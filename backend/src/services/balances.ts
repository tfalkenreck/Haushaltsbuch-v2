import type { Db } from '../db/connection.js';
import { isValidIsoDate } from '../lib/date.js';
import { AppError } from '../lib/errors.js';
import { parseGermanAmount } from '../lib/money.js';
import { nowIso } from '../lib/time.js';
import { balanceAt, dayEndBalances, type BalanceAnchor, type BalanceAt, type Movement } from './balance-history.js';
import { coveredPeriods, type Period } from './coverage.js';

/**
 * Kontostände (CLAUDE.md § 12.5): von Hand erfasste Stände für Konten ohne
 * Saldo im Export (Comdirect) und der daraus über die Buchungen
 * gerechnete Verlauf.
 */

export interface ManualBalance {
  id: number;
  accountId: number;
  date: string;
  balanceCents: number;
  notes: string | null;
  createdAt: string;
}

export interface ManualBalanceInput {
  date: string;
  /** Deutscher Betrag, z. B. „-1.234,56“. */
  amount: string;
  notes?: string | null | undefined;
}

interface ManualRow {
  id: number;
  account_id: number;
  balance_date: string;
  balance_cents: number;
  notes: string | null;
  created_at: string;
}

const toManual = (r: ManualRow): ManualBalance => ({
  id: r.id,
  accountId: r.account_id,
  date: r.balance_date,
  balanceCents: r.balance_cents,
  notes: r.notes,
  createdAt: r.created_at,
});

function assertAccount(db: Db, accountId: number): void {
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) {
    throw new AppError(`Konto ${accountId} existiert nicht.`, 404);
  }
}

export function listManualBalances(db: Db, accountId: number): ManualBalance[] {
  assertAccount(db, accountId);
  return (
    db
      .prepare('SELECT * FROM balance_anchors WHERE account_id = ? ORDER BY balance_date DESC')
      .all(accountId) as ManualRow[]
  ).map(toManual);
}

/** Kontostand am Ende eines Tages erfassen; ein Stand für denselben Tag wird ersetzt. */
export function setManualBalance(db: Db, accountId: number, input: ManualBalanceInput): ManualBalance {
  assertAccount(db, accountId);
  if (!isValidIsoDate(input.date)) throw new AppError(`„${input.date}“ ist kein gültiges Datum.`);
  const cents = parseGermanAmount(input.amount);
  if (cents === null) throw new AppError(`„${input.amount}“ ist kein Betrag (Beispiel: 1.234,56 oder -50,00).`);
  const notes = input.notes?.trim() || null;
  db.prepare(
    `INSERT INTO balance_anchors (account_id, balance_date, balance_cents, notes, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account_id, balance_date) DO UPDATE SET balance_cents = excluded.balance_cents, notes = excluded.notes`,
  ).run(accountId, input.date, cents, notes, nowIso());
  return toManual(
    db.prepare('SELECT * FROM balance_anchors WHERE account_id = ? AND balance_date = ?').get(accountId, input.date) as ManualRow,
  );
}

export function deleteManualBalance(db: Db, id: number): void {
  const result = db.prepare('DELETE FROM balance_anchors WHERE id = ?').run(id);
  if (result.changes === 0) throw new AppError(`Kontostand ${id} existiert nicht.`, 404);
}

// ---------------------------------------------------------------------------
// Verlauf
// ---------------------------------------------------------------------------

export interface BalanceData {
  movements: Movement[];
  anchors: BalanceAnchor[];
  /** Die Bank liefert zu jeder Zeile einen Saldo (kein Stand von Hand nötig). */
  hasBankBalances: boolean;
  periods: Period[];
  /** Letzter Tag mit Buchung oder Kontostand. */
  lastDate: string | null;
}

export function loadBalanceData(db: Db, accountId: number): BalanceData {
  const movements = (
    db
      .prepare(
        `SELECT id, coalesce(bank_booking_date, booking_date) AS date, amount_cents, balance_after_cents
           FROM transactions WHERE account_id = ? ORDER BY date, id`,
      )
      .all(accountId) as { id: number; date: string; amount_cents: number; balance_after_cents: number | null }[]
  ).map((r): Movement => ({ id: r.id, date: r.date, amountCents: r.amount_cents, balanceAfterCents: r.balance_after_cents }));

  const bank = dayEndBalances(movements);
  const imported = (
    db
      .prepare(
        `SELECT balance_date, balance_cents FROM import_batches
          WHERE account_id = ? AND balance_cents IS NOT NULL AND balance_date IS NOT NULL`,
      )
      .all(accountId) as { balance_date: string; balance_cents: number }[]
  ).map((r): BalanceAnchor => ({ date: r.balance_date, balanceCents: r.balance_cents, source: 'import' }));
  const manual = (
    db.prepare('SELECT balance_date, balance_cents FROM balance_anchors WHERE account_id = ?').all(accountId) as {
      balance_date: string;
      balance_cents: number;
    }[]
  ).map((r): BalanceAnchor => ({ date: r.balance_date, balanceCents: r.balance_cents, source: 'manual' }));

  const anchors = [...bank, ...imported, ...manual];
  const dates = [...movements.map((m) => m.date), ...anchors.map((a) => a.date)].sort();
  return {
    movements,
    anchors,
    hasBankBalances: bank.length > 0,
    periods: coveredPeriods(db, accountId),
    lastDate: dates[dates.length - 1] ?? null,
  };
}

/**
 * Abschnitt der importierten Zeiträume, zu dem ein Datum gehört. Zwischen
 * zwei Abschnitten liegt eine Importlücke mit unbekannten Buchungen –
 * darüber hinweg wird nicht gerechnet. Ein Datum in einer Lücke oder nach
 * dem letzten Zeitraum gehört zum Abschnitt davor.
 */
function segmentOf(date: string, periods: Period[]): number {
  let segment = 0;
  for (let i = 0; i < periods.length; i++) if ((periods[i] as Period).start <= date) segment = i;
  return segment;
}

/** Kontostand am Ende von `date`, nur aus Ankern ohne Importlücke dazwischen. */
export function balanceOn(data: BalanceData, date: string): BalanceAt | null {
  const segment = segmentOf(date, data.periods);
  const usable = data.anchors.filter((a) => segmentOf(a.date, data.periods) === segment);
  return balanceAt(date, usable, data.movements);
}

/** Aktueller Kontostand: am letzten Tag mit Buchung oder Kontostand. */
export function currentBalance(data: BalanceData): (BalanceAt & { date: string }) | null {
  if (data.lastDate === null) return null;
  const at = balanceOn(data, data.lastDate);
  return at ? { ...at, date: data.lastDate } : null;
}
