import type { Db } from '../db/connection.js';
import { monthBounds, monthOf, monthRange, shiftMonth } from '../lib/date.js';
import { AppError } from '../lib/errors.js';
import { averageCents, medianCents } from '../lib/stats.js';
import { currentBalance, loadBalanceData } from './balances.js';
import { completeMonthsBefore, completenessIndex } from './completeness.js';
import { detectIncome, withoutIds, type IncomeSource } from './income.js';
import { dueDatesBetween } from './recurring-check.js';
import type { Interval } from './recurring-debits.js';
import { listRecurring, recurringAssignments, type RecurringKind } from './recurring.js';

/**
 * Prognose (CLAUDE.md § 15) ab dem aktuellen Monat:
 *
 * - Einnahmen: wiederkehrende Eingänge (services/income.ts) mit Termin und
 *   letztem Betrag.
 * - Fixkosten: übernommene, aktive Fixkosten und Abos mit Soll-Betrag an
 *   ihren Terminen – Jahres- und Quartalsposten landen so im richtigen
 *   Monat. Posten mit Status „beendet?“ zählen nicht.
 * - Variable Ausgaben je Wurzelkategorie: **Median** der Netto-Beträge
 *   (Abflüsse minus Gutschriften) der letzten vollständigen Monate – ohne
 *   Umbuchungen, ohne Buchungen, die zu Fixkosten/Abos gehören, und ohne
 *   die wiederkehrenden Eingänge (sonst zählten sie doppelt). Ein
 *   seltener großer Posten verschiebt den Median nicht.
 *
 * Jeder Monat wird ganz prognostiziert, auch der laufende.
 */

export const DEFAULT_HORIZON = 12;
export const MAX_HORIZON = 24;
/** So viele vollständige Monate bestimmen den Median der variablen Ausgaben. */
export const MEDIAN_MONTHS = 6;

export interface ForecastFixedItem {
  id: number;
  name: string;
  kind: RecurringKind;
  interval: Interval;
  /** Soll je Abbuchung, positiv. */
  amountCents: number;
  categoryId: number | null;
  /** Wurzelkategorie (Zeile der Prognose). */
  rootCategoryId: number | null;
  /** Abbuchungen je Prognosemonat, negativ. */
  months: number[];
  totalCents: number;
}

export interface ForecastCategory {
  /** Wurzelkategorie; null = ohne Kategorie. */
  categoryId: number | null;
  name: string;
  /** Fixkosten je Monat (negativ). */
  fixedMonths: number[];
  /** Median der variablen Netto-Beträge je Monat (Abfluss negativ). */
  variableCents: number;
  /** Fixkosten plus variabel je Monat. */
  months: number[];
  totalCents: number;
}

export interface ForecastIncome extends Omit<IncomeSource, 'transactionIds'> {
  months: number[];
  totalCents: number;
}

export interface ForecastMonth {
  month: string;
  incomeCents: number;
  fixedCents: number;
  variableCents: number;
  /** Überschuss des Monats: Einnahmen + Fixkosten + variabel. */
  balanceCents: number;
  /** Aufsummierter Überschuss ab Prognosebeginn. */
  cumulativeCents: number;
  /** Kontostand aller aktiven Konten am Monatsende – nur, wenn jeder Kontostand bekannt ist. */
  projectedBalanceCents: number | null;
}

export interface Forecast {
  months: string[];
  /** Vollständige Monate, aus denen der Median stammt. */
  basisMonths: string[];
  income: ForecastIncome[];
  categories: ForecastCategory[];
  fixedItems: ForecastFixedItem[];
  /** Nicht berücksichtigte Posten mit Grund. */
  excludedItems: { id: number; name: string; reason: 'ended' | 'no_due_date' }[];
  totals: ForecastMonth[];
  /** Durchschnittlicher Überschuss je Monat über die Prognose. */
  averageSurplusCents: number;
  startBalance: { totalCents: number; knownAccounts: number; activeAccounts: number };
}

/** Beträge je Prognosemonat aus Terminen ab `anchor` im Intervall. */
function scheduled(anchor: string, interval: Interval, amountCents: number, months: string[]): number[] {
  return months.map((m) => {
    const { first, last } = monthBounds(m);
    return dueDatesBetween(anchor, interval, first, last).length * amountCents;
  });
}

const sum = (values: number[]) => values.reduce((s, v) => s + v, 0);

export function getForecast(db: Db, today: string, horizon = DEFAULT_HORIZON): Forecast {
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > MAX_HORIZON) {
    throw new AppError(`Die Prognose umfasst 1 bis ${MAX_HORIZON} Monate.`);
  }
  const current = monthOf(today);
  const months = monthRange(current, shiftMonth(current, horizon - 1));
  const index = completenessIndex(db, today);
  const basisMonths = completeMonthsBefore(index, current, MEDIAN_MONTHS);

  const roots = new Map(
    (db.prepare('SELECT id, coalesce(parent_id, id) AS root, name FROM categories').all() as { id: number; root: number; name: string }[]).map(
      (c) => [c.id, c],
    ),
  );
  const rootOf = (categoryId: number | null) => (categoryId === null ? null : (roots.get(categoryId)?.root ?? categoryId));
  const nameOf = (rootId: number | null) => (rootId === null ? 'ohne Kategorie' : (roots.get(rootId)?.name ?? `Kategorie ${rootId}`));

  // Einnahmen: laufende wiederkehrende Eingänge.
  const incomeDetection = detectIncome(db);
  const income: ForecastIncome[] = incomeDetection.sources
    .filter((s) => !s.ended)
    .map((s) => {
      const values = scheduled(s.nextDueDate, s.interval, s.lastAmountCents, months);
      return { ...withoutIds(s), months: values, totalCents: sum(values) };
    });

  // Fixkosten und Abos: übernommen, aktiv, nicht „beendet?“.
  const recurring = listRecurring(db, today);
  const fixedItems: ForecastFixedItem[] = [];
  const excludedItems: Forecast['excludedItems'] = [];
  for (const item of recurring.items) {
    if (!item.active) continue;
    if (item.check.status === 'ended') {
      excludedItems.push({ id: item.id, name: item.name, reason: 'ended' });
      continue;
    }
    const anchor = item.check.nextDueDate ?? item.nextDueDate;
    if (anchor === null) {
      excludedItems.push({ id: item.id, name: item.name, reason: 'no_due_date' });
      continue;
    }
    const values = scheduled(anchor, item.interval, -item.amountCents, months);
    fixedItems.push({
      id: item.id,
      name: item.name,
      kind: item.kind,
      interval: item.interval,
      amountCents: item.amountCents,
      categoryId: item.categoryId,
      rootCategoryId: rootOf(item.categoryId),
      months: values,
      totalCents: sum(values),
    });
  }

  // Variable Ausgaben: Netto je Wurzelkategorie und Monat in den Basismonaten.
  const excluded = JSON.stringify([...recurringAssignments(db).keys(), ...incomeDetection.transactionIds]);
  const byRoot = new Map<number | null, Map<string, number>>();
  if (basisMonths.length > 0) {
    const rows = db
      .prepare(
        `SELECT coalesce(c.parent_id, c.id) AS root_id, substr(t.booking_date, 1, 7) AS month, sum(t.amount_cents) AS net
           FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
          WHERE t.transfer_id IS NULL AND t.booking_date BETWEEN ? AND ?
            AND t.id NOT IN (SELECT value FROM json_each(?))
          GROUP BY root_id, month`,
      )
      .all(monthBounds(basisMonths[0] as string).first, monthBounds(basisMonths[basisMonths.length - 1] as string).last, excluded) as {
      root_id: number | null;
      month: string;
      net: number;
    }[];
    const basis = new Set(basisMonths);
    for (const r of rows) {
      if (!basis.has(r.month)) continue;
      const m = byRoot.get(r.root_id) ?? new Map<string, number>();
      m.set(r.month, r.net);
      byRoot.set(r.root_id, m);
    }
  }

  const rootIds = new Set<number | null>([...byRoot.keys(), ...fixedItems.map((i) => i.rootCategoryId)]);
  const categories: ForecastCategory[] = [];
  for (const rootId of rootIds) {
    const perMonth = byRoot.get(rootId);
    const variableCents = perMonth ? medianCents(basisMonths.map((m) => perMonth.get(m) ?? 0)) : 0;
    const fixedMonths = months.map((_, i) => sum(fixedItems.filter((f) => f.rootCategoryId === rootId).map((f) => f.months[i] as number)));
    const values = fixedMonths.map((v) => v + variableCents);
    if (variableCents === 0 && fixedMonths.every((v) => v === 0) && !fixedItems.some((f) => f.rootCategoryId === rootId)) continue;
    categories.push({ categoryId: rootId, name: nameOf(rootId), fixedMonths, variableCents, months: values, totalCents: sum(values) });
  }
  categories.sort((a, b) => a.totalCents - b.totalCents || a.name.localeCompare(b.name));

  // Kontostand zu Beginn: Summe der aktuellen Stände aller aktiven Konten.
  const accounts = db.prepare('SELECT id FROM accounts WHERE active = 1').all() as { id: number }[];
  let startTotal = 0;
  let known = 0;
  for (const { id } of accounts) {
    const balance = currentBalance(loadBalanceData(db, id));
    if (balance) {
      startTotal += balance.balanceCents;
      known += 1;
    }
  }
  const allKnown = accounts.length > 0 && known === accounts.length;

  let cumulative = 0;
  const totals: ForecastMonth[] = months.map((month, i) => {
    const incomeCents = sum(income.map((s) => s.months[i] as number));
    const fixedCents = sum(fixedItems.map((f) => f.months[i] as number));
    const variableCents = sum(categories.map((c) => c.variableCents));
    const balanceCents = incomeCents + fixedCents + variableCents;
    cumulative += balanceCents;
    return {
      month,
      incomeCents,
      fixedCents,
      variableCents,
      balanceCents,
      cumulativeCents: cumulative,
      projectedBalanceCents: allKnown ? startTotal + cumulative : null,
    };
  });

  return {
    months,
    basisMonths,
    income,
    categories,
    fixedItems,
    excludedItems,
    totals,
    averageSurplusCents: averageCents(totals.map((t) => t.balanceCents)),
    startBalance: { totalCents: startTotal, knownAccounts: known, activeAccounts: accounts.length },
  };
}
