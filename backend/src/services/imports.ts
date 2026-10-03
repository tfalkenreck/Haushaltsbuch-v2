import { createHash } from 'node:crypto';
import { detectAdapters, getBankAdapter, otherAdapterIds } from '../adapters/registry.js';
import { AdapterError, type ParseResult, type RawTransaction, type SkippedLine } from '../adapters/types.js';
import type { Db } from '../db/connection.js';
import { addDays, formatDateDe, isValidIsoDate } from '../lib/date.js';
import { AppError } from '../lib/errors.js';
import { formatIban } from '../lib/iban.js';
import { normalizeCounterparty } from '../lib/normalize.js';
import { nowIso } from '../lib/time.js';
import { getAccount, type Account } from './accounts.js';
import { coveredPeriods, gapsBetween, mergePeriods, type Period } from './coverage.js';

export interface ImportInput {
  accountId: number;
  fileName: string;
  bytes: Uint8Array;
  /**
   * Zeitraum des Exports, falls bekannt. Ohne Angabe gilt erste bis letzte
   * Buchung der Datei – Tage ohne Buchung am Rand erscheinen dann als Lücke.
   */
  periodStart?: string | undefined;
  periodEnd?: string | undefined;
}

export interface ImportResult {
  /** null, wenn nichts Neues dabei war (kein Importvorgang angelegt). */
  batchId: number | null;
  accountId: number;
  bankAdapter: string;
  fileName: string;
  periodStart: string | null;
  periodEnd: string | null;
  rowsTotal: number;
  imported: number;
  duplicates: number;
  /** Zeilen eines anderen Auftragskontos. */
  otherAccount: number;
  pending: SkippedLine[];
  ignored: SkippedLine[];
  warnings: string[];
}

export interface ImportBatch {
  id: number;
  accountId: number;
  accountName: string;
  bankAdapter: string;
  fileName: string;
  importedAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  rowsTotal: number;
  rowsImported: number;
  rowsDuplicate: number;
  rowsSkipped: number;
  balanceCents: number | null;
  balanceDate: string | null;
  /** Buchungen, die aktuell zu diesem Importvorgang gehören. */
  transactionCount: number;
}

/**
 * Duplikat-Schlüssel (CLAUDE.md § 6 und § 19): SHA-256 über Konto,
 * Buchungsdatum, Betrag, Verwendungszweck und die laufende Nummer
 * identischer Zeilen innerhalb einer Datei. Zwei echte gleiche Zahlungen
 * bleiben so zwei Buchungen; dieselbe Datei erneut importiert ergibt
 * dieselben Schlüssel.
 */
export function importHash(
  accountId: number,
  bookingDate: string,
  amountCents: number,
  purpose: string,
  occurrence: number,
): string {
  return createHash('sha256')
    .update(JSON.stringify([accountId, bookingDate, amountCents, purpose, occurrence]), 'utf8')
    .digest('hex');
}

/** Schlüssel für alle Buchungen einer Datei, in Dateireihenfolge. */
export function importHashes(accountId: number, transactions: RawTransaction[]): string[] {
  const seen = new Map<string, number>();
  return transactions.map((t) => {
    const key = JSON.stringify([t.bookingDate, t.amountCents, t.purpose]);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return importHash(accountId, t.bookingDate, t.amountCents, t.purpose, occurrence);
  });
}

function parseFile(adapterId: string, bytes: Uint8Array): ParseResult {
  const adapter = getBankAdapter(adapterId);
  if (!adapter) {
    throw new AppError(`Unbekannter Bank-Adapter „${adapterId}“. Verfügbar: ${otherAdapterIds(adapterId).join(', ')}.`);
  }
  try {
    return adapter.parse(bytes);
  } catch (err) {
    if (!(err instanceof AdapterError)) throw err;
    const detected = detectAdapters(bytes, adapterId);
    const hint =
      detected.length > 0
        ? ` Die Datei passt zum Adapter ${detected.join(', ')} – ist beim Konto der richtige Adapter gewählt?`
        : '';
    throw new AppError(`${err.message} Verfügbar: ${otherAdapterIds(adapterId).join(', ')}.${hint}`);
  }
}

function accountNameByIban(db: Db, iban: string): string | null {
  const row = db.prepare('SELECT name FROM accounts WHERE iban = ?').get(iban) as { name: string } | undefined;
  return row?.name ?? null;
}

/**
 * Prüft „IBAN Auftragskonto“ gegen die IBAN des Kontos (docs/bankformate.md
 * § 1.4): passende Zeilen bleiben, fremde werden gemeldet. Gehört die
 * ganze Datei zu einem anderen Konto, wird abgebrochen.
 */
function filterByAccountIban(
  db: Db,
  account: Account,
  transactions: RawTransaction[],
  warnings: string[],
): { kept: RawTransaction[]; otherAccount: number } {
  const fileIbans = [...new Set(transactions.map((t) => t.accountIban).filter((i): i is string => i !== null))];
  if (fileIbans.length === 0) return { kept: transactions, otherAccount: 0 };

  const describe = (iban: string) => {
    const owner = accountNameByIban(db, iban);
    return owner ? `${formatIban(iban)} (Konto „${owner}“)` : formatIban(iban);
  };

  if (account.iban === null) {
    if (fileIbans.length > 1) {
      throw new AppError(
        `Die Datei enthält Buchungen mehrerer Konten (${fileIbans.map(describe).join(', ')}). ` +
          `Bitte beim Konto „${account.name}“ die eigene IBAN hinterlegen, dann werden nur die passenden Zeilen importiert.`,
      );
    }
    const iban = fileIbans[0] as string;
    const owner = accountNameByIban(db, iban);
    if (owner !== null) {
      throw new AppError(`Die Datei gehört zum Konto „${owner}“ (${formatIban(iban)}), nicht zu „${account.name}“.`);
    }
    warnings.push(
      `Beim Konto ist keine IBAN hinterlegt; die Datei gehört zu ${formatIban(iban)}. ` +
        'Mit hinterlegter IBAN prüft der Import, ob die richtige Datei gewählt ist.',
    );
    return { kept: transactions, otherAccount: 0 };
  }

  const kept = transactions.filter((t) => t.accountIban === null || t.accountIban === account.iban);
  const foreign = fileIbans.filter((iban) => iban !== account.iban);
  if (kept.length === 0) {
    throw new AppError(
      `Die Datei gehört nicht zum Konto „${account.name}“ (${formatIban(account.iban)}), ` +
        `sondern zu ${foreign.map(describe).join(', ')}. Falsche Datei gewählt?`,
    );
  }
  const otherAccount = transactions.length - kept.length;
  if (otherAccount > 0) {
    warnings.push(
      `${otherAccount} Zeile(n) gehören zu einem anderen Konto (${foreign.map(describe).join(', ')}) und wurden nicht importiert.`,
    );
  }
  return { kept, otherAccount };
}

function validatePeriodBound(value: string | undefined, label: string): string | null {
  if (value === undefined || value === '') return null;
  if (!isValidIsoDate(value)) throw new AppError(`${label} „${value}“ ist kein gültiges Datum (YYYY-MM-DD).`);
  return value;
}

/** Hinweise auf Überschneidung mit und Lücken zu bereits importierten Zeiträumen. */
function coverageWarnings(existing: Period[], period: Period): string[] {
  if (existing.length === 0) return [];
  const warnings: string[] = [];

  const overlaps = existing.filter((p) => p.start <= period.end && p.end >= period.start);
  if (overlaps.length > 0) {
    const span = overlaps
      .map((p) => {
        const start = p.start > period.start ? p.start : period.start;
        const end = p.end < period.end ? p.end : period.end;
        return `${formatDateDe(start)}–${formatDateDe(end)}`;
      })
      .join(', ');
    warnings.push(`Die Datei überschneidet sich mit bereits importierten Zeiträumen (${span}); doppelte Buchungen werden übersprungen.`);
  }

  // Lücken, die direkt an den neuen Zeitraum grenzen.
  const after = gapsBetween(mergePeriods([...existing, period]));
  for (const gap of after) {
    if (gap.end === addDays(period.start, -1) || gap.start === addDays(period.end, 1)) {
      warnings.push(
        `Zwischen ${formatDateDe(gap.start)} und ${formatDateDe(gap.end)} fehlen Kontoauszüge (Lücke). ` +
          'Falls dort keine Buchungen waren: beim Import den Zeitraum des Exports angeben.',
      );
    }
  }
  return warnings;
}

/**
 * Importiert eine Datei in ein Konto – als ein Importvorgang in einer
 * Transaktion, damit er als Einheit rückgängig gemacht werden kann.
 */
export function importFile(db: Db, input: ImportInput): ImportResult {
  const account = getAccount(db, input.accountId);
  if (!account.active) throw new AppError(`Das Konto „${account.name}“ ist deaktiviert.`);

  const fileName = input.fileName.trim() || 'unbenannt.csv';
  const requestedStart = validatePeriodBound(input.periodStart, 'Zeitraum von');
  const requestedEnd = validatePeriodBound(input.periodEnd, 'Zeitraum bis');
  if (requestedStart && requestedEnd && requestedStart > requestedEnd) {
    throw new AppError('Der Zeitraum ist ungültig: „von“ liegt nach „bis“.');
  }

  const parsed = parseFile(account.bankAdapter, input.bytes);
  const warnings = [...parsed.warnings];

  const { kept, otherAccount } = filterByAccountIban(db, account, parsed.transactions, warnings);
  if (kept.length === 0) {
    if (parsed.pending.length > 0) {
      throw new AppError('Die Datei enthält nur vorgemerkte Umsätze – nichts zu importieren.');
    }
    throw new AppError('Die Datei enthält keine Buchungen.');
  }

  const dates = kept.map((t) => t.bookingDate).sort();
  const firstDate = dates[0] as string;
  const lastDate = dates[dates.length - 1] as string;
  if (requestedStart && requestedStart > firstDate) {
    throw new AppError(`Der angegebene Zeitraum beginnt nach der ersten Buchung der Datei (${formatDateDe(firstDate)}).`);
  }
  if (requestedEnd && requestedEnd < lastDate) {
    throw new AppError(`Der angegebene Zeitraum endet vor der letzten Buchung der Datei (${formatDateDe(lastDate)}).`);
  }
  const period: Period = { start: requestedStart ?? firstDate, end: requestedEnd ?? lastDate };

  const fileSha256 = createHash('sha256').update(input.bytes).digest('hex');
  const sameFile = db
    .prepare('SELECT imported_at FROM import_batches WHERE account_id = ? AND file_sha256 = ? ORDER BY id LIMIT 1')
    .get(account.id, fileSha256) as { imported_at: string } | undefined;
  if (sameFile) {
    warnings.push(`Diese Datei wurde bereits am ${formatDateDe(sameFile.imported_at.slice(0, 10))} importiert.`);
  }

  warnings.push(...coverageWarnings(coveredPeriods(db, account.id), period));

  const balance =
    parsed.statementBalances.find((b) => b.accountIban !== null && b.accountIban === account.iban) ??
    parsed.statementBalances.find((b) => b.accountIban === null) ??
    (parsed.statementBalances.length === 1 && account.iban === null ? parsed.statementBalances[0] : undefined);

  const hashes = importHashes(account.id, kept);
  const exists = db.prepare('SELECT 1 FROM transactions WHERE import_hash = ?');
  const fresh = kept
    .map((t, i) => ({ t, hash: hashes[i] as string }))
    .filter(({ hash }) => exists.get(hash) === undefined);
  const duplicates = kept.length - fresh.length;

  const rowsTotal = parsed.transactions.length + parsed.pending.length + parsed.ignored.length;
  const result: ImportResult = {
    batchId: null,
    accountId: account.id,
    bankAdapter: account.bankAdapter,
    fileName,
    periodStart: period.start,
    periodEnd: period.end,
    rowsTotal,
    imported: fresh.length,
    duplicates,
    otherAccount,
    pending: parsed.pending,
    ignored: parsed.ignored,
    warnings,
  };

  if (fresh.length === 0) {
    warnings.push('Alle Buchungen der Datei sind bereits vorhanden – es wurde nichts importiert.');
    return result;
  }

  const now = nowIso();
  db.transaction(() => {
    const batch = db
      .prepare(
        `INSERT INTO import_batches
           (account_id, bank_adapter, file_name, file_sha256, imported_at, period_start, period_end,
            rows_total, rows_imported, rows_duplicate, rows_skipped, balance_cents, balance_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        account.id,
        account.bankAdapter,
        fileName,
        fileSha256,
        now,
        period.start,
        period.end,
        rowsTotal,
        fresh.length,
        duplicates,
        otherAccount + parsed.pending.length + parsed.ignored.length,
        balance?.cents ?? null,
        balance ? (balance.date ?? lastDate) : null,
      );
    const batchId = Number(batch.lastInsertRowid);

    const insert = db.prepare(
      `INSERT INTO transactions
         (account_id, booking_date, value_date, amount_cents, currency, counterparty, counterparty_normalized,
          counterparty_iban, purpose, booking_text, creditor_id, mandate_reference, balance_after_cents,
          bank_reference, import_batch_id, import_hash, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const { t, hash } of fresh) {
      insert.run(
        account.id,
        t.bookingDate,
        t.valueDate,
        t.amountCents,
        t.currency,
        t.counterparty,
        normalizeCounterparty(t.counterparty),
        t.counterpartyIban,
        t.purpose,
        t.bookingText,
        t.creditorId,
        t.mandateReference,
        t.balanceAfterCents,
        t.bankReference,
        batchId,
        hash,
        now,
      );
    }
    result.batchId = batchId;
  })();

  return result;
}

interface BatchRow {
  id: number;
  account_id: number;
  account_name: string;
  bank_adapter: string;
  file_name: string;
  imported_at: string;
  period_start: string | null;
  period_end: string | null;
  rows_total: number;
  rows_imported: number;
  rows_duplicate: number;
  rows_skipped: number;
  balance_cents: number | null;
  balance_date: string | null;
  transaction_count: number;
}

function toBatch(row: BatchRow): ImportBatch {
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name,
    bankAdapter: row.bank_adapter,
    fileName: row.file_name,
    importedAt: row.imported_at,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    rowsTotal: row.rows_total,
    rowsImported: row.rows_imported,
    rowsDuplicate: row.rows_duplicate,
    rowsSkipped: row.rows_skipped,
    balanceCents: row.balance_cents,
    balanceDate: row.balance_date,
    transactionCount: row.transaction_count,
  };
}

const BATCH_SELECT = `
  SELECT b.*, a.name AS account_name,
         (SELECT count(*) FROM transactions t WHERE t.import_batch_id = b.id) AS transaction_count
    FROM import_batches b
    JOIN accounts a ON a.id = b.account_id`;

export function listImportBatches(db: Db, accountId?: number): ImportBatch[] {
  const rows = (
    accountId === undefined
      ? db.prepare(`${BATCH_SELECT} ORDER BY b.id DESC`).all()
      : db.prepare(`${BATCH_SELECT} WHERE b.account_id = ? ORDER BY b.id DESC`).all(accountId)
  ) as BatchRow[];
  return rows.map(toBatch);
}

export interface UndoResult {
  batchId: number;
  deletedTransactions: number;
  warnings: string[];
}

/**
 * Macht einen Importvorgang als Einheit rückgängig: alle seine Buchungen
 * und der Vorgang selbst verschwinden, in einer Transaktion.
 */
export function undoImport(db: Db, batchId: number): UndoResult {
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId) as
    | { id: number; account_id: number; period_start: string | null; period_end: string | null }
    | undefined;
  if (!batch) throw new AppError(`Importvorgang ${batchId} existiert nicht.`, 404);

  const warnings: string[] = [];
  // Andere Importe desselben Zeitraums haben ihre Duplikate übersprungen –
  // deren Buchungen fehlen nach dem Rückgängigmachen, bis sie erneut
  // importiert werden.
  if (batch.period_start && batch.period_end) {
    const overlapping = db
      .prepare(
        `SELECT file_name FROM import_batches
          WHERE account_id = ? AND id <> ? AND rows_duplicate > 0
            AND period_start <= ? AND period_end >= ?`,
      )
      .all(batch.account_id, batch.id, batch.period_end, batch.period_start) as { file_name: string }[];
    if (overlapping.length > 0) {
      warnings.push(
        `Überschneidende Importe (${overlapping.map((o) => o.file_name).join(', ')}) haben Buchungen dieses ` +
          'Zeitraums als Duplikat übersprungen. Diese Dateien erneut importieren, damit nichts fehlt.',
      );
    }
  }

  const deletedTransactions = db.transaction(() => {
    const deleted = db.prepare('DELETE FROM transactions WHERE import_batch_id = ?').run(batchId).changes;
    db.prepare('DELETE FROM import_batches WHERE id = ?').run(batchId);
    return deleted;
  })();

  return { batchId, deletedTransactions, warnings };
}
