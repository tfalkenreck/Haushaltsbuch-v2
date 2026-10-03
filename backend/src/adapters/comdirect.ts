import { isBlankRow, parseCsv, type CsvRow } from '../lib/csv.js';
import { parseGermanDate } from '../lib/date.js';
import { isValidIban, normalizeIban } from '../lib/iban.js';
import { parseGermanAmount } from '../lib/money.js';
import { decodeText } from '../lib/text.js';
import { field, findHeader } from './header.js';
import {
  AdapterError,
  type BankAdapter,
  type ParseResult,
  type RawTransaction,
  type SkippedLine,
  type StatementBalance,
} from './types.js';

/**
 * Comdirect – Girokonto (docs/bankformate.md § 2). Windows-1252, alle
 * Felder in Anführungszeichen, Semikolon am Zeilenende, nur 5 Spalten.
 * Gegenpartei, Verwendungszweck und Referenz stecken gemeinsam in
 * „Buchungstext“.
 *
 * Ungeprüft (§ 2.3), daher robust gebaut: Metadatenzeilen vor der
 * Kopfzeile, Fußzeilen nach der Tabelle, vorgemerkte Umsätze mit
 * Buchungstag „offen“, Kontostand in den Metadaten.
 */

const COL = {
  bookingDay: 'Buchungstag',
  valueDate: 'Wertstellung (Valuta)',
  kind: 'Vorgang',
  text: 'Buchungstext',
  amount: 'Umsatz in EUR',
} as const;

const REQUIRED = [COL.bookingDay, COL.valueDate, COL.kind, COL.text, COL.amount] as const;

const LABEL = /(Auftraggeber|Empfänger|Buchungstext|Kto\/IBAN|BLZ\/BIC):/g;

export interface ComdirectText {
  counterparty: string;
  counterpartyIban: string | null;
  purpose: string;
  reference: string | null;
}

/**
 * Zerlegt den Comdirect-Buchungstext `<Label>: <Wert> <Label>: <Wert> … Ref. X`.
 * - `Auftraggeber:` / `Empfänger:` → Gegenpartei
 * - `Buchungstext:` → Verwendungszweck (inkl. `Zeitraum: …`)
 * - `Kto/IBAN:` → Gegen-IBAN, falls gültig, sonst in den Verwendungszweck
 * - `BLZ/BIC:` → verworfen (für nichts benötigt)
 * - `Ref.` am Ende → Referenz, nicht im Verwendungszweck
 * Text vor dem ersten Label bleibt im Verwendungszweck – nichts geht verloren.
 */
export function splitComdirectText(text: string): ComdirectText {
  let rest = text.trim();
  let reference: string | null = null;
  const ref = /(?:^|\s)Ref\.\s*(\S+)\s*$/.exec(rest);
  if (ref) {
    reference = ref[1] ?? null;
    rest = rest.slice(0, ref.index).trim();
  }

  const parts: { label: string | null; value: string }[] = [];
  let lastIndex = 0;
  let lastLabel: string | null = null;
  for (const match of rest.matchAll(LABEL)) {
    parts.push({ label: lastLabel, value: rest.slice(lastIndex, match.index).trim() });
    lastLabel = match[1] ?? null;
    lastIndex = match.index + match[0].length;
  }
  parts.push({ label: lastLabel, value: rest.slice(lastIndex).trim() });

  let counterparty = '';
  let counterpartyIban: string | null = null;
  const purpose: string[] = [];
  for (const { label, value } of parts) {
    if (value === '') continue;
    switch (label) {
      case 'Auftraggeber':
      case 'Empfänger':
        counterparty = counterparty === '' ? value : `${counterparty} ${value}`;
        break;
      case 'Kto/IBAN': {
        const iban = normalizeIban(value);
        if (isValidIban(iban)) counterpartyIban = iban;
        else purpose.push(`Kto/IBAN: ${value}`);
        break;
      }
      case 'BLZ/BIC':
        break;
      default:
        purpose.push(value);
    }
  }

  return { counterparty, counterpartyIban, purpose: purpose.join(' '), reference };
}

function decode(bytes: Uint8Array): string {
  return decodeText(bytes, 'windows-1252');
}

/** Kontostand aus einer Metadaten- oder Fußzeile, z. B. `"Neuer Kontostand";"1.234,56 EUR";`. */
function balanceFromRow(row: CsvRow): { cents: number; date: string | null } | null {
  const labelIndex = row.fields.findIndex((f) => /kontostand/i.test(f) && !/alter/i.test(f));
  if (labelIndex === -1) return null;
  const label = row.fields[labelIndex] as string;
  for (const value of row.fields.slice(labelIndex + 1)) {
    const cents = parseGermanAmount(value.replace(/EUR|€/gi, ''));
    if (cents !== null) {
      const date = /(\d{2}\.\d{2}\.\d{4})/.exec(label);
      return { cents, date: date?.[1] ? parseGermanDate(date[1]) : null };
    }
  }
  return null;
}

function parse(bytes: Uint8Array): ParseResult {
  const rows = parseCsv(decode(bytes));
  const header = findHeader(rows, REQUIRED);
  if (!header) throw new AdapterError('Comdirect-Adapter erkennt keine Kopfzeile.');

  const transactions: RawTransaction[] = [];
  const pending: SkippedLine[] = [];
  const ignored: SkippedLine[] = [];
  const warnings: string[] = [];
  const statementBalances: StatementBalance[] = [];

  const noteBalance = (row: CsvRow) => {
    const balance = balanceFromRow(row);
    if (balance && statementBalances.length === 0) statementBalances.push({ accountIban: null, ...balance });
  };

  for (const row of rows.slice(0, header.index)) noteBalance(row);

  // Die Tabelle endet mit der ersten Zeile, die keine Buchung ist; alles
  // danach (Fußzeilen, weitere Tabellen) wird gemeldet, nicht importiert.
  let tableEnded = false;
  for (const row of rows.slice(header.index + 1)) {
    if (isBlankRow(row)) continue;
    const get = (name: string) => field(row, header.columns, name);

    if (tableEnded) {
      noteBalance(row);
      if (findHeader([row], REQUIRED) || /buchungstag/i.test(row.fields[0] ?? '')) {
        warnings.push(`Ab Zeile ${row.line} folgt eine weitere Tabelle – nur die erste wurde gelesen.`);
      }
      ignored.push({ line: row.line, reason: 'nach Tabellenende' });
      continue;
    }

    const dayText = get(COL.bookingDay);
    if (/^offen$/i.test(dayText)) {
      pending.push({ line: row.line, reason: `vorgemerkt: ${get(COL.text).slice(0, 60)} (${get(COL.amount)})` });
      continue;
    }

    const bookingDate = parseGermanDate(dayText);
    if (bookingDate === null) {
      tableEnded = true;
      noteBalance(row);
      ignored.push({ line: row.line, reason: `keine Buchung („${row.fields.join(';').slice(0, 40)}“)` });
      continue;
    }

    const amountCents = parseGermanAmount(get(COL.amount));
    if (amountCents === null) {
      ignored.push({ line: row.line, reason: `Betrag unlesbar („${get(COL.amount)}“)` });
      continue;
    }

    const kind = get(COL.kind);
    const parts = splitComdirectText(get(COL.text));
    // Bankentgelte haben kein „Auftraggeber:“ – Gegenpartei ist die Bank selbst.
    const counterparty = parts.counterparty || (/entgelt/i.test(kind) ? 'comdirect' : '');

    transactions.push({
      line: row.line,
      bookingDate,
      valueDate: parseGermanDate(get(COL.valueDate)),
      amountCents,
      currency: 'EUR',
      counterparty,
      counterpartyIban: parts.counterpartyIban,
      purpose: parts.purpose,
      bookingText: kind,
      creditorId: null,
      mandateReference: null,
      balanceAfterCents: null,
      bankReference: parts.reference,
      accountIban: null,
    });
  }

  return { transactions, pending, ignored, statementBalances, warnings };
}

export const comdirectAdapter: BankAdapter = {
  id: 'comdirect',
  label: 'Comdirect (Girokonto)',
  detect(bytes) {
    return findHeader(parseCsv(decode(bytes)), REQUIRED) !== null;
  },
  parse,
};
