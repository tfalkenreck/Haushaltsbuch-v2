import type { Db } from '../db/connection.js';
import { monthOf, shiftMonth } from '../lib/date.js';
import { getCoverage, type MonthStatus } from './coverage.js';

/**
 * Ist ein Monat vollständig importiert (CLAUDE.md § 15: „sonst sieht ein
 * halber Monat aus wie ein sparsamer“)? Grundlage ist die Abdeckung der
 * aktiven Konten (§ 6). Monate vor dem ersten Import eines Kontos zählen
 * für dieses Konto nicht als Lücke – sie werden nur genannt. Konten ohne
 * jeden Import bleiben außen vor; die Startseite meldet sie als offenen
 * Punkt.
 */

export interface AccountMonthState {
  accountId: number;
  accountName: string;
  status: MonthStatus;
}

export interface MonthCompleteness {
  month: string;
  status: MonthStatus;
  /** Konten, deren Monat teilweise oder gar nicht importiert ist. */
  incomplete: AccountMonthState[];
  /** Konten, die erst nach diesem Monat importiert wurden. */
  notYetImported: { accountId: number; accountName: string }[];
}

interface AccountCoverageMonths {
  accountId: number;
  accountName: string;
  firstMonth: string;
  months: Map<string, MonthStatus>;
}

export interface CompletenessIndex {
  /** Erster Monat, den irgendein Import abdeckt; null = nichts importiert. */
  firstMonth: string | null;
  accountIds: number[];
  statusOf(month: string): MonthCompleteness;
}

/**
 * Abdeckung aller aktiven Konten (oder nur von `accountId`, auch wenn es
 * deaktiviert ist) als Nachschlagewerk je Monat.
 */
export function completenessIndex(db: Db, today: string, accountId?: number): CompletenessIndex {
  const accounts = (
    accountId === undefined
      ? db.prepare('SELECT id, name FROM accounts WHERE active = 1 ORDER BY id').all()
      : db.prepare('SELECT id, name FROM accounts WHERE id = ?').all(accountId)
  ) as { id: number; name: string }[];

  const covered: AccountCoverageMonths[] = [];
  for (const a of accounts) {
    const coverage = getCoverage(db, a.id, today);
    const first = coverage.months[0];
    if (!first) continue;
    covered.push({
      accountId: a.id,
      accountName: a.name,
      firstMonth: first.month,
      months: new Map(coverage.months.map((m) => [m.month, m.status])),
    });
  }
  const firstMonth = covered.map((c) => c.firstMonth).sort()[0] ?? null;

  return {
    firstMonth,
    accountIds: covered.map((c) => c.accountId),
    statusOf(month: string): MonthCompleteness {
      const incomplete: AccountMonthState[] = [];
      const notYetImported: { accountId: number; accountName: string }[] = [];
      let considered = 0;
      let missing = 0;
      for (const c of covered) {
        if (month < c.firstMonth) {
          notYetImported.push({ accountId: c.accountId, accountName: c.accountName });
          continue;
        }
        considered += 1;
        // Monate nach dem aktuellen gibt die Abdeckung nicht an – sie fehlen.
        const status = c.months.get(month) ?? 'missing';
        if (status === 'missing') missing += 1;
        if (status !== 'complete') incomplete.push({ accountId: c.accountId, accountName: c.accountName, status });
      }
      const status: MonthStatus =
        considered === 0 || missing === considered ? 'missing' : incomplete.length === 0 ? 'complete' : 'partial';
      return { month, status, incomplete, notYetImported };
    },
  };
}

/**
 * Die letzten `count` vollständigen Monate vor `before` (ausschließlich),
 * älteste zuerst. Gesucht wird höchstens `lookback` Monate zurück.
 */
export function completeMonthsBefore(index: CompletenessIndex, before: string, count: number, lookback = 24): string[] {
  const result: string[] = [];
  if (index.firstMonth === null) return result;
  for (let i = 1; i <= lookback && result.length < count; i++) {
    const month = shiftMonth(before, -i);
    if (month < index.firstMonth) break;
    if (index.statusOf(month).status === 'complete') result.unshift(month);
  }
  return result;
}

/**
 * Standardmonat der Auswertungen: der jüngste vollständig importierte
 * Monat bis heute, sonst der jüngste Monat mit Buchungen, sonst der
 * aktuelle Monat.
 */
export function defaultMonth(db: Db, index: CompletenessIndex, today: string, accountId?: number): string {
  const current = monthOf(today);
  const complete = completeMonthsBefore(index, shiftMonth(current, 1), 1);
  if (complete[0]) return complete[0];
  const row = (
    accountId === undefined
      ? db.prepare('SELECT max(booking_date) AS d FROM transactions WHERE booking_date <= ?').get(today)
      : db.prepare('SELECT max(booking_date) AS d FROM transactions WHERE booking_date <= ? AND account_id = ?').get(today, accountId)
  ) as { d: string | null };
  return row.d ? monthOf(row.d) : current;
}
