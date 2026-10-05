import type { Db } from '../db/connection.js';
import { monthBounds, monthOf, monthRange, shiftMonth } from '../lib/date.js';
import { AppError } from '../lib/errors.js';
import { permille } from '../lib/stats.js';
import type { MonthStatus } from './coverage.js';
import { completenessIndex, defaultMonth, type MonthCompleteness } from './completeness.js';

/**
 * Monatsübersicht der Startseite (CLAUDE.md § 15): Einnahmen, Ausgaben und
 * Saldo, Ausgaben nach Kategorie mit Anteil und Vormonat, Verlauf über
 * zwölf Monate – gesamt oder für ein Konto.
 *
 * Einnahmen = Zuflüsse, Ausgaben = Abflüsse, jeweils ohne Umbuchungen
 * (`transfer_id IS NULL`, § 10) – dieselben Summen wie in der Buchungsliste,
 * in die jede Zahl springt. Kartenumsätze zählen mit ihrem Kaufdatum
 * (`booking_date`, § 11).
 */

export const HISTORY_MONTHS = 12;

export interface MonthTotals {
  month: string;
  status: MonthStatus;
  incomeCents: number;
  expensesCents: number;
  /** Einnahmen minus Ausgaben. */
  balanceCents: number;
}

export interface CategoryExpense {
  /** Wurzelkategorie; null = ohne Kategorie. */
  categoryId: number | null;
  name: string;
  /** Abflüsse des Monats in dieser Kategorie und ihren Unterkategorien, positiv. */
  outflowCents: number;
  /** Gutschriften in derselben Kategorie (z. B. Erstattungen), positiv – nur zur Information. */
  inflowCents: number;
  /** Anteil an den Ausgaben des Monats in Promille. */
  sharePermille: number;
  previousOutflowCents: number;
  /** Abflüsse minus Vormonat; > 0 = mehr ausgegeben. */
  changeCents: number;
}

export interface MonthOverview {
  month: string;
  accountId: number | null;
  /** Monate zur Auswahl: erster importierter Monat bis heute, neueste zuerst. */
  availableMonths: string[];
  completeness: MonthCompleteness;
  totals: MonthTotals;
  previous: MonthTotals;
  categories: CategoryExpense[];
  /** Umbuchungen im Monat – nicht mitgezählt. */
  transfers: { count: number; inflowCents: number; outflowCents: number };
  /** Buchungen des Monats ohne Kategorie (ohne Umbuchungen). */
  uncategorized: { count: number; outflowCents: number; inflowCents: number };
  /** Älteste zuerst, endet mit dem betrachteten Monat. */
  history: MonthTotals[];
}

export interface OverviewQuery {
  month?: string | undefined;
  accountId?: number | undefined;
}

function accountFilter(accountId: number | undefined): { sql: string; params: number[] } {
  return accountId === undefined ? { sql: '', params: [] } : { sql: 'AND t.account_id = ?', params: [accountId] };
}

/** Einnahmen und Ausgaben je Monat im Bereich [from, to] (Monate `YYYY-MM`). */
function monthlySums(db: Db, from: string, to: string, accountId: number | undefined): Map<string, { income: number; expenses: number }> {
  const f = accountFilter(accountId);
  const rows = db
    .prepare(
      `SELECT substr(t.booking_date, 1, 7) AS month,
              coalesce(sum(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS income,
              coalesce(-sum(CASE WHEN t.amount_cents < 0 THEN t.amount_cents END), 0) AS expenses
         FROM transactions t
        WHERE t.transfer_id IS NULL AND t.booking_date BETWEEN ? AND ? ${f.sql}
        GROUP BY month`,
    )
    .all(monthBounds(from).first, monthBounds(to).last, ...f.params) as { month: string; income: number; expenses: number }[];
  return new Map(rows.map((r) => [r.month, { income: r.income, expenses: r.expenses }]));
}

export function assertMonth(month: string): void {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new AppError(`„${month}“ ist kein gültiger Monat (JJJJ-MM).`);
}

export function assertAccountExists(db: Db, accountId: number | undefined): void {
  if (accountId !== undefined && !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) {
    throw new AppError(`Konto ${accountId} existiert nicht.`, 404);
  }
}

export function getMonthOverview(db: Db, query: OverviewQuery, today: string): MonthOverview {
  if (query.month !== undefined) assertMonth(query.month);
  assertAccountExists(db, query.accountId);
  const index = completenessIndex(db, today, query.accountId);
  const month = query.month ?? defaultMonth(db, index, today, query.accountId);
  const previousMonth = shiftMonth(month, -1);
  const historyFrom = shiftMonth(month, -(HISTORY_MONTHS - 1));
  const f = accountFilter(query.accountId);

  const sums = monthlySums(db, historyFrom, month, query.accountId);
  const totalsOf = (m: string): MonthTotals => {
    const s = sums.get(m) ?? { income: 0, expenses: 0 };
    return { month: m, status: index.statusOf(m).status, incomeCents: s.income, expensesCents: s.expenses, balanceCents: s.income - s.expenses };
  };
  const totals = totalsOf(month);

  // Ausgaben je Wurzelkategorie im Monat und im Vormonat.
  const categoryRows = db
    .prepare(
      `SELECT coalesce(c.parent_id, c.id) AS root_id, substr(t.booking_date, 1, 7) AS month,
              coalesce(-sum(CASE WHEN t.amount_cents < 0 THEN t.amount_cents END), 0) AS outflow,
              coalesce(sum(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS inflow
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.transfer_id IS NULL AND t.booking_date BETWEEN ? AND ? ${f.sql}
        GROUP BY root_id, month`,
    )
    .all(monthBounds(previousMonth).first, monthBounds(month).last, ...f.params) as {
    root_id: number | null;
    month: string;
    outflow: number;
    inflow: number;
  }[];
  const names = new Map((db.prepare('SELECT id, name FROM categories').all() as { id: number; name: string }[]).map((c) => [c.id, c.name]));
  const byRoot = new Map<number | null, { outflow: number; inflow: number; previous: number }>();
  for (const r of categoryRows) {
    const entry = byRoot.get(r.root_id) ?? { outflow: 0, inflow: 0, previous: 0 };
    if (r.month === month) {
      entry.outflow += r.outflow;
      entry.inflow += r.inflow;
    } else {
      entry.previous += r.outflow;
    }
    byRoot.set(r.root_id, entry);
  }
  const categories: CategoryExpense[] = [...byRoot.entries()]
    .filter(([, e]) => e.outflow > 0 || e.previous > 0)
    .map(([id, e]) => ({
      categoryId: id,
      name: id === null ? 'ohne Kategorie' : (names.get(id) ?? `Kategorie ${id}`),
      outflowCents: e.outflow,
      inflowCents: e.inflow,
      sharePermille: permille(e.outflow, totals.expensesCents),
      previousOutflowCents: e.previous,
      changeCents: e.outflow - e.previous,
    }))
    .sort((a, b) => b.outflowCents - a.outflowCents || b.previousOutflowCents - a.previousOutflowCents || a.name.localeCompare(b.name));

  const { first, last } = monthBounds(month);
  const transferRow = db
    .prepare(
      `SELECT count(*) AS n,
              coalesce(sum(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS inflow,
              coalesce(-sum(CASE WHEN t.amount_cents < 0 THEN t.amount_cents END), 0) AS outflow
         FROM transactions t WHERE t.transfer_id IS NOT NULL AND t.booking_date BETWEEN ? AND ? ${f.sql}`,
    )
    .get(first, last, ...f.params) as { n: number; inflow: number; outflow: number };
  const uncategorizedRow = db
    .prepare(
      `SELECT count(*) AS n,
              coalesce(sum(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS inflow,
              coalesce(-sum(CASE WHEN t.amount_cents < 0 THEN t.amount_cents END), 0) AS outflow
         FROM transactions t
        WHERE t.transfer_id IS NULL AND t.category_id IS NULL AND t.booking_date BETWEEN ? AND ? ${f.sql}`,
    )
    .get(first, last, ...f.params) as { n: number; inflow: number; outflow: number };

  const current = monthOf(today);
  const firstMonth = index.firstMonth ?? (month < current ? month : current);
  const lastMonth = month > current ? month : current;

  return {
    month,
    accountId: query.accountId ?? null,
    availableMonths: monthRange(firstMonth < month ? firstMonth : month, lastMonth).reverse(),
    completeness: index.statusOf(month),
    totals,
    // Der Vormonat liegt immer im Verlauf (zwölf Monate).
    previous: totalsOf(previousMonth),
    categories,
    transfers: { count: transferRow.n, inflowCents: transferRow.inflow, outflowCents: transferRow.outflow },
    uncategorized: { count: uncategorizedRow.n, outflowCents: uncategorizedRow.outflow, inflowCents: uncategorizedRow.inflow },
    history: monthRange(historyFrom, month).map(totalsOf),
  };
}
