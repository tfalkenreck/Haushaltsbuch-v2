import type { Db } from '../db/connection.js';
import { addDays, monthBounds, monthRange } from '../lib/date.js';

export interface Period {
  start: string;
  end: string;
}

export type MonthStatus = 'complete' | 'partial' | 'missing';

export interface MonthCoverage {
  month: string;
  status: MonthStatus;
  transactionCount: number;
}

export interface AccountCoverage {
  accountId: number;
  /** Zusammengefasste, von Importen abgedeckte Zeiträume. */
  periods: Period[];
  /** Lücken zwischen den abgedeckten Zeiträumen und seit dem letzten Import bis heute. */
  gaps: Period[];
  /** Erster abgedeckter Monat bis zum aktuellen Monat. */
  months: MonthCoverage[];
}

/**
 * Fasst Zeiträume zusammen; direkt aneinandergrenzende Tage (Ende + 1 =
 * Anfang) gelten als durchgehend.
 */
export function mergePeriods(periods: Period[]): Period[] {
  const sorted = [...periods].sort((a, b) => a.start.localeCompare(b.start));
  const merged: Period[] = [];
  for (const period of sorted) {
    const last = merged[merged.length - 1];
    if (last && period.start <= addDays(last.end, 1)) {
      if (period.end > last.end) last.end = period.end;
    } else {
      merged.push({ ...period });
    }
  }
  return merged;
}

/** Lücken zwischen zusammengefassten Zeiträumen. */
export function gapsBetween(merged: Period[]): Period[] {
  const gaps: Period[] = [];
  for (let i = 1; i < merged.length; i++) {
    gaps.push({ start: addDays((merged[i - 1] as Period).end, 1), end: addDays((merged[i] as Period).start, -1) });
  }
  return gaps;
}

/** Wie viele Tage von `period` durch `merged` abgedeckt sind. */
function coveredDays(merged: Period[], period: Period): number {
  let days = 0;
  for (const p of merged) {
    const start = p.start > period.start ? p.start : period.start;
    const end = p.end < period.end ? p.end : period.end;
    if (start <= end) days += daysBetween(start, end) + 1;
  }
  return days;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Von Importvorgängen abgedeckte Zeiträume eines Kontos (zusammengefasst). */
export function coveredPeriods(db: Db, accountId: number): Period[] {
  const rows = db
    .prepare(
      `SELECT period_start AS start, period_end AS end FROM import_batches
        WHERE account_id = ? AND period_start IS NOT NULL AND period_end IS NOT NULL`,
    )
    .all(accountId) as Period[];
  return mergePeriods(rows);
}

/**
 * Abdeckung pro Konto (CLAUDE.md § 6): welche Monate vollständig, teilweise
 * oder gar nicht importiert sind, und wo Lücken liegen. Grundlage sind die
 * Zeiträume der Importvorgänge, nicht nur die Buchungen – ein Monat ohne
 * Buchung, den eine Datei abdeckt, ist keine Lücke.
 */
export function getCoverage(db: Db, accountId: number, today: string): AccountCoverage {
  const periods = coveredPeriods(db, accountId);
  const first = periods[0];
  const last = periods[periods.length - 1];
  if (!first || !last) return { accountId, periods, gaps: [], months: [] };

  const gaps = gapsBetween(periods);
  if (last.end < today) gaps.push({ start: addDays(last.end, 1), end: today });

  const counts = new Map(
    (
      db
        .prepare(
          // Buchungstag der Bank: ein Kartenkauf vom 29.12., gebucht am
          // 02.01., gehört zum Januar-Export. Altbestand ohne Buchungstag
          // (Migration 004) fällt auf booking_date zurück.
          `SELECT substr(coalesce(bank_booking_date, booking_date), 1, 7) AS month, count(*) AS n FROM transactions
            WHERE account_id = ? GROUP BY month`,
        )
        .all(accountId) as { month: string; n: number }[]
    ).map((r) => [r.month, r.n]),
  );

  const lastMonth = today > last.end ? today : last.end;
  const months = monthRange(first.start, lastMonth).map((month): MonthCoverage => {
    const bounds = monthBounds(month);
    const total = daysBetween(bounds.first, bounds.last) + 1;
    const covered = coveredDays(periods, { start: bounds.first, end: bounds.last });
    const status: MonthStatus = covered === 0 ? 'missing' : covered === total ? 'complete' : 'partial';
    return { month, status, transactionCount: counts.get(month) ?? 0 };
  });

  return { accountId, periods, gaps, months };
}
