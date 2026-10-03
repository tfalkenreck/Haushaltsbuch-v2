import { isBlankRow, parseCsv, type CsvRow } from '../lib/csv.js';
import { parseGermanDate } from '../lib/date.js';
import { normalizeIban } from '../lib/iban.js';
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
 * Volksbank OWL – Girokonto, Sparkonto und Visa (docs/bankformate.md § 1).
 * Alle drei exportieren dasselbe 18-spaltige Format in UTF-8 mit BOM.
 *
 * Kartenbesonderheiten (§ 1.3) erkennt der Parser am Inhalt der Zeile,
 * nicht am Konto: Ist „Name Zahlungsbeteiligter“ leer, wird der Händler
 * aus dem Anfang des Verwendungszwecks abgeleitet, und ein
 * „Umsatz vom TT.MM.JJJJ“ im Verwendungszweck wird zum Buchungsdatum.
 */

const COL = {
  accountIban: 'IBAN Auftragskonto',
  bookingDay: 'Buchungstag',
  valueDate: 'Valutadatum',
  counterparty: 'Name Zahlungsbeteiligter',
  counterpartyIban: 'IBAN Zahlungsbeteiligter',
  bookingText: 'Buchungstext',
  purpose: 'Verwendungszweck',
  amount: 'Betrag',
  currency: 'Waehrung',
  balance: 'Saldo nach Buchung',
  creditorId: 'Glaeubiger ID',
  mandateReference: 'Mandatsreferenz',
} as const;

const REQUIRED = [COL.accountIban, COL.bookingDay, COL.counterparty, COL.purpose, COL.amount] as const;

const CARD_DATE = /Umsatz vom\s+(\d{2}\.\d{2}\.\d{4})/;

/**
 * Händler am Anfang eines Kartenumsatzes: bis zur ersten Lücke aus
 * mehreren Leerzeichen bzw. vor einem Ländercode mit folgender Nummer.
 * `PAYPAL *STREAMINGDIENST  GB  1234…` → `PAYPAL *STREAMINGDIENST`.
 */
export function merchantFromPurpose(purpose: string): string {
  const match = /^(.*?)(?:\s{2,}|\s[A-Z]{2}\s+\d|$)/.exec(purpose.trim());
  return (match?.[1] ?? '').trim();
}

interface Parsed {
  raw: RawTransaction;
  /** Buchungstag laut Bank (vor Kartendatum-Korrektur), für den Saldo-Stichtag. */
  bookingDay: string;
}

function decode(bytes: Uint8Array): string {
  try {
    return decodeText(bytes, 'utf-8');
  } catch {
    throw new AdapterError('Volksbank-Adapter: Datei ist kein gültiges UTF-8 (erwartet: UTF-8 mit BOM).');
  }
}

function parseRow(row: CsvRow, columns: Map<string, number>, ignored: SkippedLine[]): Parsed | null {
  const get = (name: string) => field(row, columns, name);

  const bookingDay = parseGermanDate(get(COL.bookingDay));
  if (bookingDay === null) {
    ignored.push({ line: row.line, reason: `kein Buchungstag („${get(COL.bookingDay) || row.fields.join(';').slice(0, 40)}“)` });
    return null;
  }
  const amountCents = parseGermanAmount(get(COL.amount));
  if (amountCents === null) {
    ignored.push({ line: row.line, reason: `Betrag unlesbar („${get(COL.amount)}“)` });
    return null;
  }

  const purpose = get(COL.purpose);
  let counterparty = get(COL.counterparty);
  let bookingDate = bookingDay;

  if (counterparty === '') {
    counterparty = merchantFromPurpose(purpose);
    const cardDate = CARD_DATE.exec(purpose);
    const parsed = cardDate?.[1] ? parseGermanDate(cardDate[1]) : null;
    if (parsed !== null) bookingDate = parsed;
  }

  const balanceText = get(COL.balance);
  const currency = get(COL.currency).toUpperCase();
  const counterpartyIban = normalizeIban(get(COL.counterpartyIban));
  const accountIban = normalizeIban(get(COL.accountIban));

  return {
    bookingDay,
    raw: {
      line: row.line,
      bookingDate,
      valueDate: parseGermanDate(get(COL.valueDate)),
      amountCents,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : 'EUR',
      counterparty,
      counterpartyIban: counterpartyIban === '' ? null : counterpartyIban,
      purpose,
      bookingText: get(COL.bookingText),
      creditorId: get(COL.creditorId) || null,
      mandateReference: get(COL.mandateReference) || null,
      balanceAfterCents: balanceText === '' ? null : parseGermanAmount(balanceText),
      bankReference: null,
      accountIban: accountIban === '' ? null : accountIban,
    },
  };
}

/**
 * Prüft die Saldo-Kette (Saldo_vorher + Betrag = Saldo_nachher) je
 * Auftragskonto. Die Bank sortiert absteigend (neueste zuerst); beide
 * Richtungen werden versucht, die passendere gewinnt. Liefert Warnungen
 * und den jüngsten Saldo.
 */
function checkBalances(rows: Parsed[]): { warnings: string[]; latest: Parsed | null } {
  const withBalance = rows.filter((r) => r.raw.balanceAfterCents !== null);
  if (withBalance.length === 0) return { warnings: [], latest: null };
  if (withBalance.length !== rows.length) {
    return { warnings: ['Nicht jede Zeile hat einen Saldo – Saldo-Prüfung übersprungen.'], latest: null };
  }

  const gaps = (ordered: Parsed[]) => {
    const found: [Parsed, Parsed][] = [];
    for (let i = 1; i < ordered.length; i++) {
      const older = ordered[i - 1] as Parsed;
      const newer = ordered[i] as Parsed;
      if ((older.raw.balanceAfterCents as number) + newer.raw.amountCents !== newer.raw.balanceAfterCents) {
        found.push([older, newer]);
      }
    }
    return found;
  };

  const ascending = rows;
  const descending = [...rows].reverse();
  const gapsAsc = gaps(ascending);
  const gapsDesc = gaps(descending);

  let ordered: Parsed[];
  let found: [Parsed, Parsed][];
  if (rows.length === 1) {
    ordered = rows;
    found = [];
  } else if (gapsDesc.length < gapsAsc.length) {
    ordered = descending;
    found = gapsDesc;
  } else if (gapsAsc.length < gapsDesc.length) {
    ordered = ascending;
    found = gapsAsc;
  } else {
    // Gleich gut (oder gleich schlecht): nach Buchungstag entscheiden.
    const first = rows[0] as Parsed;
    const last = rows[rows.length - 1] as Parsed;
    ordered = first.bookingDay > last.bookingDay ? descending : ascending;
    found = ordered === descending ? gapsDesc : gapsAsc;
  }

  const warnings = found.map(([older, newer]) => {
    const [a, b] = [older.raw.line, newer.raw.line].sort((x, y) => x - y);
    return `Saldo passt nicht zwischen Zeile ${a} und ${b} – fehlt dort eine Buchung?`;
  });
  return { warnings, latest: ordered[ordered.length - 1] ?? null };
}

function parse(bytes: Uint8Array): ParseResult {
  const rows = parseCsv(decode(bytes));
  const header = findHeader(rows, REQUIRED);
  if (!header) throw new AdapterError('Volksbank-Adapter erkennt keine Kopfzeile.');

  const ignored: SkippedLine[] = [];
  const parsed: Parsed[] = [];
  for (const row of rows.slice(header.index + 1)) {
    if (isBlankRow(row)) continue;
    const result = parseRow(row, header.columns, ignored);
    if (result) parsed.push(result);
  }

  const warnings: string[] = [];
  const statementBalances: StatementBalance[] = [];

  // Saldo-Kette je Auftragskonto prüfen (eine Datei kann mehrere enthalten).
  const byAccount = new Map<string, Parsed[]>();
  for (const p of parsed) {
    const key = p.raw.accountIban ?? '';
    byAccount.set(key, [...(byAccount.get(key) ?? []), p]);
  }
  for (const [accountIban, group] of byAccount) {
    const check = checkBalances(group);
    warnings.push(...check.warnings);
    if (check.latest) {
      statementBalances.push({
        accountIban: accountIban === '' ? null : accountIban,
        cents: check.latest.raw.balanceAfterCents as number,
        date: check.latest.bookingDay,
      });
    }
  }

  return { transactions: parsed.map((p) => p.raw), pending: [], ignored, statementBalances, warnings };
}

export const volksbankOwlAdapter: BankAdapter = {
  id: 'volksbank-owl',
  label: 'Volksbank OWL (Giro, Spar, Visa)',
  detect(bytes) {
    try {
      return findHeader(parseCsv(decodeText(bytes, 'utf-8')), REQUIRED) !== null;
    } catch {
      return false;
    }
  },
  parse,
};
