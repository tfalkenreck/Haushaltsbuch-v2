import type { Db } from '../db/connection.js';
import { monthBounds, monthRange, shiftMonth } from '../lib/date.js';
import { AppError } from '../lib/errors.js';
import { medianCents, permille } from '../lib/stats.js';
import type { Bucket } from './categories.js';
import { completeMonthsBefore, completenessIndex, defaultMonth } from './completeness.js';
import type { MonthStatus } from './coverage.js';
import { detectIncome, withoutIds, type IncomeSource } from './income.js';
import { assertMonth } from './overview.js';

/**
 * Budget 50/30/20 (CLAUDE.md § 15).
 *
 * - Nettoeinkommen = Gutschriften, die zu einem wiederkehrenden Eingang
 *   gehören (services/income.ts) – nicht alle Gutschriften.
 * - Ist je Bucket = Ausgaben der Kategorien mit diesem Bucket, netto:
 *   Abflüsse minus Gutschriften derselben Kategorie (Erstattungen),
 *   ohne Umbuchungen und ohne die wiederkehrenden Eingänge.
 * - Sparen (`save`) zusätzlich: Saldo der Umbuchungen auf Konten mit Rolle
 *   `sparen` (hin minus zurück). Umbuchungen bleiben dabei weder Einnahme
 *   noch Ausgabe – sie zeigen nur, wie viel zurückgelegt wurde.
 * - Abweichung je Kategorie: Ist gegen das Übliche (Median der
 *   vollständigen Monate davor). So zeigt sich, welche Kategorie einen
 *   Bucket über das Ziel treibt.
 * - Was keinen Bucket hat (Kategorie ohne Bucket, unkategorisiert), steht
 *   offen daneben – sonst wäre die Rechnung geschönt.
 */

export const BUDGET_TARGETS: Record<Bucket, number> = { need: 50, want: 30, save: 20 };
export const BUDGET_SPANS = [1, 3, 6, 12] as const;
export type BudgetSpan = (typeof BUDGET_SPANS)[number];
/** So viele vollständige Monate vor dem Zeitraum bestimmen das „Übliche“ je Kategorie. */
export const TYPICAL_MONTHS = 6;

export interface BudgetCategory {
  categoryId: number;
  path: string;
  /** Netto-Ausgaben je Monat (Durchschnitt über den Zeitraum). */
  actualCents: number;
  /** Median der Netto-Ausgaben in den vollständigen Monaten davor; null = keine solchen Monate. */
  typicalCents: number | null;
  deviationCents: number | null;
}

export interface BudgetBucket {
  bucket: Bucket;
  targetPercent: number;
  targetCents: number;
  actualCents: number;
  /** Ist minus Ziel; > 0 = über dem Ziel (bei Sparen: mehr gespart als geplant). */
  deviationCents: number;
  /** Anteil am Nettoeinkommen in Promille. */
  incomePermille: number;
  categories: BudgetCategory[];
  /** Nur Sparen: Umbuchungen aufs Sparkonto (Saldo), je Monat. */
  savingsTransfersCents: number;
}

export interface Budget {
  month: string;
  span: BudgetSpan;
  months: { month: string; status: MonthStatus }[];
  allComplete: boolean;
  income: {
    /** Wiederkehrende Eingänge je Monat im Zeitraum (Durchschnitt). */
    actualCents: number;
    /** Monatswert der laufenden wiederkehrenden Eingänge. */
    expectedCents: number;
    /** Grundlage der Ziele. */
    basisCents: number;
    /** actual = tatsächliche Eingänge; expected = erwarteter Monatswert (Zeitraum unvollständig oder ohne Eingang); none = keine wiederkehrenden Eingänge erkannt. */
    basisSource: 'actual' | 'expected' | 'none';
    /** Alle Gutschriften ohne Umbuchungen je Monat – zum Vergleich. */
    allCreditsCents: number;
    sources: Omit<IncomeSource, 'transactionIds'>[];
  };
  buckets: BudgetBucket[];
  unassigned: {
    /** Abflüsse ohne Kategorie je Monat. */
    uncategorizedCents: number;
    /** Kategorien ohne Bucket mit Netto-Ausgaben (z. B. Bargeld, Sonstiges). */
    categories: { categoryId: number; path: string; actualCents: number }[];
    totalCents: number;
  };
  /** Monate, aus denen das „Übliche“ je Kategorie stammt. */
  typicalMonths: string[];
}

export interface BudgetQuery {
  month?: string | undefined;
  span?: number | undefined;
}

interface CategoryRow {
  id: number;
  name: string;
  parent_name: string | null;
  effective_bucket: Bucket | null;
}

export function getBudget(db: Db, query: BudgetQuery, today: string): Budget {
  if (query.month !== undefined) assertMonth(query.month);
  const span = (query.span ?? 1) as BudgetSpan;
  if (!BUDGET_SPANS.includes(span)) throw new AppError(`Zeitraum ${query.span} ist nicht vorgesehen (1, 3, 6 oder 12 Monate).`);

  const index = completenessIndex(db, today);
  const month = query.month ?? defaultMonth(db, index, today);
  const first = shiftMonth(month, -(span - 1));
  const months = monthRange(first, month).map((m) => ({ month: m, status: index.statusOf(m).status }));
  const allComplete = months.every((m) => m.status === 'complete');
  const typicalMonths = completeMonthsBefore(index, first, TYPICAL_MONTHS);

  const income = detectIncome(db);
  const incomeIds = JSON.stringify([...income.transactionIds]);
  const from = monthBounds(first).first;
  const to = monthBounds(month).last;

  // Einnahmen im Zeitraum: wiederkehrende Eingänge und alle Gutschriften zum Vergleich.
  const incomeRow = db
    .prepare(
      `SELECT coalesce(sum(CASE WHEN id IN (SELECT value FROM json_each(?)) THEN amount_cents END), 0) AS recurring,
              coalesce(sum(amount_cents), 0) AS credits
         FROM transactions WHERE transfer_id IS NULL AND amount_cents > 0 AND booking_date BETWEEN ? AND ?`,
    )
    .get(incomeIds, from, to) as { recurring: number; credits: number };
  const actualIncome = Math.round(incomeRow.recurring / span);
  const expectedIncome = income.sources.filter((s) => !s.ended).reduce((s, x) => s + x.monthlyCents, 0);
  const basisSource: Budget['income']['basisSource'] =
    allComplete && actualIncome > 0 ? 'actual' : expectedIncome > 0 ? 'expected' : actualIncome > 0 ? 'actual' : 'none';
  const basis = basisSource === 'actual' ? actualIncome : basisSource === 'expected' ? expectedIncome : 0;

  // Netto-Ausgaben je Kategorie und Monat (Zeitraum plus Vergleichsmonate), ohne Umbuchungen und wiederkehrende Eingänge.
  const earliest = typicalMonths[0] ?? first;
  const netRows = db
    .prepare(
      `SELECT category_id, substr(booking_date, 1, 7) AS month,
              -sum(amount_cents) AS net,
              coalesce(-sum(CASE WHEN amount_cents < 0 THEN amount_cents END), 0) AS outflow
         FROM transactions
        WHERE transfer_id IS NULL AND booking_date BETWEEN ? AND ?
          AND id NOT IN (SELECT value FROM json_each(?))
        GROUP BY category_id, month`,
    )
    .all(monthBounds(earliest).first, to, incomeIds) as { category_id: number | null; month: string; net: number; outflow: number }[];

  const inSpan = new Set(months.map((m) => m.month));
  const typicalSet = new Set(typicalMonths);
  const actual = new Map<number, number>();
  const typical = new Map<number, Map<string, number>>();
  let uncategorized = 0;
  for (const r of netRows) {
    if (r.category_id === null) {
      if (inSpan.has(r.month)) uncategorized += r.outflow;
      continue;
    }
    if (inSpan.has(r.month)) actual.set(r.category_id, (actual.get(r.category_id) ?? 0) + r.net);
    if (typicalSet.has(r.month)) {
      const byMonth = typical.get(r.category_id) ?? new Map<string, number>();
      byMonth.set(r.month, r.net);
      typical.set(r.category_id, byMonth);
    }
  }

  // Umbuchungen auf Sparkonten (hin minus zurück), datiert nach der frühesten beteiligten Buchung.
  const savingsRow = db
    .prepare(
      `SELECT coalesce(sum(CASE WHEN ta.role = 'sparen' THEN tr.amount_cents ELSE 0 END)
                     - sum(CASE WHEN fa.role = 'sparen' THEN tr.amount_cents ELSE 0 END), 0) AS net
         FROM transfers tr
         JOIN (SELECT transfer_id, min(booking_date) AS date FROM transactions
                WHERE transfer_id IS NOT NULL GROUP BY transfer_id) d ON d.transfer_id = tr.id
         LEFT JOIN accounts fa ON fa.id = tr.from_account_id
         LEFT JOIN accounts ta ON ta.id = tr.to_account_id
        WHERE tr.kind IN ('pair', 'one_sided') AND d.date BETWEEN ? AND ?`,
    )
    .get(from, to) as { net: number };
  const savingsTransfers = Math.round(savingsRow.net / span);

  const categories = db
    .prepare(
      `SELECT c.id, c.name, p.name AS parent_name,
              CASE WHEN c.parent_id IS NOT NULL AND c.inherit_bucket = 1 THEN p.bucket ELSE c.bucket END AS effective_bucket
         FROM categories c LEFT JOIN categories p ON p.id = c.parent_id`,
    )
    .all() as CategoryRow[];

  const buckets: BudgetBucket[] = (Object.keys(BUDGET_TARGETS) as Bucket[]).map((bucket) => ({
    bucket,
    targetPercent: BUDGET_TARGETS[bucket],
    targetCents: Math.round((basis * BUDGET_TARGETS[bucket]) / 100),
    actualCents: 0,
    deviationCents: 0,
    incomePermille: 0,
    categories: [],
    savingsTransfersCents: bucket === 'save' ? savingsTransfers : 0,
  }));
  const unassigned: Budget['unassigned'] = { uncategorizedCents: Math.round(uncategorized / span), categories: [], totalCents: 0 };

  for (const c of categories) {
    const actualCents = Math.round((actual.get(c.id) ?? 0) / span);
    const byMonth = typical.get(c.id);
    const typicalCents = typicalMonths.length === 0 ? null : medianCents(typicalMonths.map((m) => byMonth?.get(m) ?? 0));
    if (actualCents === 0 && !typicalCents) continue;
    const path = c.parent_name === null ? c.name : `${c.parent_name} › ${c.name}`;
    if (c.effective_bucket === null) {
      if (actualCents > 0) unassigned.categories.push({ categoryId: c.id, path, actualCents });
      continue;
    }
    const target = buckets.find((b) => b.bucket === c.effective_bucket) as BudgetBucket;
    target.categories.push({
      categoryId: c.id,
      path,
      actualCents,
      typicalCents,
      deviationCents: typicalCents === null ? null : actualCents - typicalCents,
    });
  }

  for (const b of buckets) {
    b.categories.sort((x, y) => y.actualCents - x.actualCents || x.path.localeCompare(y.path));
    b.actualCents = b.categories.reduce((s, c) => s + c.actualCents, 0) + b.savingsTransfersCents;
    b.deviationCents = b.actualCents - b.targetCents;
    b.incomePermille = permille(b.actualCents, basis);
  }
  unassigned.categories.sort((x, y) => y.actualCents - x.actualCents);
  unassigned.totalCents = unassigned.uncategorizedCents + unassigned.categories.reduce((s, c) => s + c.actualCents, 0);

  return {
    month,
    span,
    months,
    allComplete,
    income: {
      actualCents: actualIncome,
      expectedCents: expectedIncome,
      basisCents: basis,
      basisSource,
      allCreditsCents: Math.round(incomeRow.credits / span),
      sources: income.sources.map(withoutIds),
    },
    buckets,
    unassigned,
    typicalMonths,
  };
}
