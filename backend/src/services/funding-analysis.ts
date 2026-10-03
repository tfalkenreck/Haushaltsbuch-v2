import { shiftMonth } from '../lib/date.js';
import type { MonthStatus } from './coverage.js';

/**
 * Deckungsprüfung eines per Dauerauftrag gespeisten Kontos (CLAUDE.md § 12)
 * – reine Funktionen über bereits geladene Daten. Der Service `funding.ts`
 * lädt Buchungen, Abdeckung, Daueraufträge und Salden und ruft diese auf.
 *
 * Begriffe je Monat (nach Buchungsdatum):
 * - Daueraufträge: Umbuchungen aufs Konto, die zu einem erkannten Dauerauftrag gehören.
 * - weitere Umbuchungen: alle übrigen Umbuchungen, rein und raus (Sonderüberweisungen).
 * - Abbuchungen: echte Abflüsse ohne Umbuchungen, abzüglich Gutschriften
 *   (Erstattungen), die keine Umbuchung sind.
 * - Differenz: Daueraufträge minus Abbuchungen. < 0 = Unterdeckung.
 */

/** So viele vollständige Monate gehen in Verlauf, Durchschnitt und Empfehlung ein. */
export const FUNDING_WINDOW_MONTHS = 12;
/**
 * Umstellung der Daueraufträge: Ändert sich die Summe der laufenden
 * Daueraufträge von einem Monat zum nächsten um mindestens 10 % und
 * mindestens 10 €, beginnt die Auswertung neu – Monate davor beschreiben
 * einen anderen Zustand (andere Daueraufträge, andere Abbuchungen).
 */
export const SWITCH_MIN_PERCENT = 10;
export const SWITCH_MIN_CENTS = 1000;
/** Mindestens so viele vollständige Monate braucht eine Empfehlung. */
export const MIN_MONTHS_FOR_RECOMMENDATION = 3;
/** Ab so vielen Unterdeckungen in Folge ist es ein Trend, kein Zufall (§ 12.4). */
export const TREND_MONTHS = 3;
/** Empfehlung wird auf volle 10 € aufgerundet. */
export const RECOMMENDATION_STEP_CENTS = 1000;
/** Ursachen: Anstieg ab 5 € im Monat. */
export const CAUSE_THRESHOLD_CENTS = 500;
/** Ursachen: letzte drei vollständige Monate gegen bis zu sechs davor. */
export const CAUSE_RECENT_MONTHS = 3;
export const CAUSE_REFERENCE_MONTHS = 6;

export interface FundingTransaction {
  id: number;
  date: string;
  amountCents: number;
  isTransfer: boolean;
  /** Posten-Schlüssel (lib/item-key.ts), für Ursachen und Puffer. */
  key: string;
  label: string;
}

export interface MonthInput {
  month: string;
  status: MonthStatus;
  /** Kontostand am Monatsende, falls bestimmbar. */
  balanceEndCents: number | null;
}

export interface FundingMonth {
  month: string;
  status: MonthStatus;
  standingOrdersCents: number;
  /** Saldo der übrigen Umbuchungen (rein positiv, raus negativ). */
  otherTransfersCents: number;
  /** Abbuchungen ohne Umbuchungen, positiv. */
  debitsCents: number;
  /** Gutschriften ohne Umbuchungen (Erstattungen), positiv. */
  creditsCents: number;
  /** Abbuchungen minus Gutschriften. */
  expensesCents: number;
  /** Daueraufträge minus Abbuchungen; < 0 = Unterdeckung. */
  differenceCents: number;
  balanceEndCents: number | null;
}

export type TrendStatus = 'covered' | 'single' | 'trend' | 'unknown';

export interface FundingTrend {
  /**
   * covered = letzter vollständiger Monat gedeckt; single = Unterdeckung in
   * 1–2 Monaten in Folge (Zufall möglich); trend = ab 3 Monaten in Folge;
   * unknown = kein vollständiger Monat.
   */
  status: TrendStatus;
  /** Unterdeckungen in Folge bis zum letzten vollständigen Monat. */
  deficitStreak: number;
  deficitSince: string | null;
  /** Wird die Unterdeckung in der Folge größer? */
  direction: 'growing' | 'shrinking' | 'steady' | null;
  /** Vollständige Monate im Betrachtungsfenster (ab Startmonat, höchstens zwölf) und davon mit Unterdeckung. */
  windowMonths: string[];
  deficitMonthsInWindow: number;
  averageStandingOrdersCents: number | null;
  averageExpensesCents: number | null;
  averageDifferenceCents: number | null;
}

export interface FluctuatingItem {
  key: string;
  label: string;
  minCents: number;
  maxCents: number;
  averageCents: number;
}

export interface FundingRecommendation {
  basisMonths: number;
  averageExpensesCents: number;
  /** Kleinste und größte monatliche Abbuchungssumme im Fenster. */
  minExpensesCents: number;
  maxExpensesCents: number;
  /**
   * Puffer aus der Schwankung der monatlichen Abbuchungssumme:
   * 80.-Perzentil der Monatssummen minus Durchschnitt. Schwankungen
   * einzelner Posten, die sich im Monat ausgleichen, kosten keinen Puffer.
   */
  bufferCents: number;
  /** Posten, die laut § 13 aufs Konto umgestellt werden sollen, je Monat. */
  plannedMovesCents: number;
  /** Bedarf: Durchschnitt + Puffer + Umzustellendes, auf volle 10 € aufgerundet. */
  neededCents: number;
  /** Jeder Monat im Fenster gedeckt. */
  allMonthsCovered: boolean;
  /** Kleinste Überdeckung im Fenster (nur wenn jeder Monat gedeckt ist). */
  minSurplusCents: number | null;
  /** Kontostand im Fenster gefallen; null = unbekannt. */
  balanceFalling: boolean | null;
  /**
   * fits = passt, keine Änderung nötig; increase = Dauerauftrag erhöhen.
   * Ist jeder Monat gedeckt und der Kontostand nicht fallend, passt der
   * Dauerauftrag – nur umzustellende Posten, die die kleinste Überdeckung
   * übersteigen, verlangen eine Erhöhung.
   */
  verdict: 'fits' | 'increase';
  /** Neuer Gesamtbetrag (= aktuell, wenn es passt). */
  recommendedCents: number;
  /** Summe der laufenden Daueraufträge. */
  currentCents: number;
  /** Empfohlen minus aktuell; > 0 = Dauerauftrag erhöhen. */
  changeCents: number;
  /** Die am stärksten schwankenden Posten – zur Information, der Puffer rechnet mit der Monatssumme. */
  fluctuating: FluctuatingItem[];
}

/** Umstellung der Daueraufträge (deutliche Änderung ihrer Summe). */
export interface FundingSwitch {
  /** Erster Monat mit den neuen Daueraufträgen. */
  month: string;
  fromCents: number;
  toCents: number;
}

/** Ab welchem Monat ausgewertet wird. */
export interface FundingEvaluation {
  /** null = alle Monate. */
  startMonth: string | null;
  /** manual = von Hand festgelegt, switch = Umstellung erkannt, all = keine Umstellung. */
  source: 'manual' | 'switch' | 'all';
  /** Erkannte letzte Umstellung, unabhängig von einer Festlegung von Hand. */
  detectedSwitch: FundingSwitch | null;
  /** Von Hand festgelegter Startmonat, falls vorhanden. */
  manualStartMonth: string | null;
  /** Vollständige Monate ab Startmonat (Fenster). */
  basisMonths: string[];
  /** Mindestens drei vollständige Monate – sonst sind Durchschnitt und Empfehlung nicht belastbar. */
  sufficient: boolean;
}

export interface PriceChange {
  date: string;
  fromCents: number;
  toCents: number;
}

export interface CauseItem {
  key: string;
  label: string;
  /** Durchschnitt je Monat im Vergleichszeitraum bzw. in den letzten Monaten, positiv. */
  beforeCents: number;
  recentCents: number;
  increaseCents: number;
  /** Im Vergleichszeitraum gab es den Posten nicht. */
  isNew: boolean;
  /** Letzte Betragsänderung, falls in den letzten Monaten (Preiserhöhung). */
  priceChange: PriceChange | null;
}

export interface FundingCauses {
  recentMonths: string[];
  referenceMonths: string[];
  /** Veränderung der durchschnittlichen Abbuchungen insgesamt. */
  totalChangeCents: number;
  items: CauseItem[];
}

export interface BalanceInfo {
  balanceCents: number;
  date: string;
  source: 'bank' | 'import' | 'manual';
}

export interface BalanceAssessment {
  /** negative = Konto im Minus; cushion = Guthaben vorhanden; unknown = kein Kontostand bekannt. */
  status: 'negative' | 'cushion' | 'unknown';
  current: BalanceInfo | null;
  /** Monate, die das Guthaben bei gleichbleibender Unterdeckung noch reicht. */
  runwayMonths: number | null;
  /** Niedrigster Monatsendstand im Fenster. */
  lowestCents: number | null;
  lowestMonth: string | null;
  /** Veränderung des Kontostands vom Ende des Monats `changeSince` bis zum Ende des letzten vollständigen Monats. */
  changeCents: number | null;
  changeSince: string | null;
}

const average = (values: number[]): number | null =>
  values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) / values.length);

/** Nearest-Rank-Perzentil einer Ganzzahlliste. */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p * sorted.length) / 100));
  return sorted[rank - 1] as number;
}

/** Monatszeilen: Daueraufträge, übrige Umbuchungen, Abbuchungen, Differenz. */
export function fundingMonths(
  months: MonthInput[],
  transactions: FundingTransaction[],
  standingOrderTxIds: ReadonlySet<number>,
): FundingMonth[] {
  const rows = new Map<string, FundingMonth>(
    months.map((m) => [
      m.month,
      {
        month: m.month,
        status: m.status,
        standingOrdersCents: 0,
        otherTransfersCents: 0,
        debitsCents: 0,
        creditsCents: 0,
        expensesCents: 0,
        differenceCents: 0,
        balanceEndCents: m.balanceEndCents,
      },
    ]),
  );
  for (const t of transactions) {
    const row = rows.get(t.date.slice(0, 7));
    if (!row) continue;
    if (t.isTransfer) {
      if (standingOrderTxIds.has(t.id)) row.standingOrdersCents += t.amountCents;
      else row.otherTransfersCents += t.amountCents;
    } else if (t.amountCents < 0) {
      row.debitsCents -= t.amountCents;
    } else {
      row.creditsCents += t.amountCents;
    }
  }
  for (const row of rows.values()) {
    row.expensesCents = row.debitsCents - row.creditsCents;
    row.differenceCents = row.standingOrdersCents - row.expensesCents;
  }
  return [...rows.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/** Daueraufträge, wie sie die Umstellungserkennung braucht (siehe standing-orders.ts). */
export interface LevelOrder {
  active: boolean;
  occurrences: { month: string; amountCents: number }[];
}

/**
 * Summe der laufenden Daueraufträge in einem Monat (Soll-Zufluss). Ein
 * Dauerauftrag läuft vom Monat seiner ersten bis zu dem seiner letzten
 * Ausführung, ein noch laufender unbegrenzt; eine ausgelassene Ausführung
 * zählt mit dem letzten Betrag.
 */
export function standingOrderLevel(orders: LevelOrder[], month: string): number {
  let sum = 0;
  for (const o of orders) {
    const first = o.occurrences[0];
    const last = o.occurrences[o.occurrences.length - 1];
    if (!first || !last || month < first.month || (!o.active && month > last.month)) continue;
    let amount = first.amountCents;
    for (const x of o.occurrences) if (x.month <= month) amount = x.amountCents;
    sum += amount;
  }
  return sum;
}

/**
 * Letzte Umstellung der Daueraufträge: der späteste Monat, in dem sich ihre
 * Summe gegenüber dem Vormonat deutlich ändert (mindestens
 * `SWITCH_MIN_PERCENT` % und `SWITCH_MIN_CENTS`). Verglichen werden
 * vollständige Monate und am Ende der laufende, teilweise importierte
 * Monat – teilweise Monate am Anfang oder um eine Importlücke würden
 * Daueraufträge nur scheinbar beginnen oder enden lassen.
 */
export function detectFundingSwitch(rows: FundingMonth[], orders: LevelOrder[]): FundingSwitch | null {
  const lastComplete = rows.map((r) => r.status).lastIndexOf('complete');
  if (lastComplete === -1) return null;
  const compared = rows.filter((r, i) => r.status === 'complete' || (i > lastComplete && r.status === 'partial'));
  let result: FundingSwitch | null = null;
  let prev: number | null = null;
  for (const r of compared) {
    const level = standingOrderLevel(orders, r.month);
    if (prev !== null) {
      const diff = Math.abs(level - prev);
      if (diff >= SWITCH_MIN_CENTS && diff * 100 >= prev * SWITCH_MIN_PERCENT) {
        result = { month: r.month, fromCents: prev, toCents: level };
      }
    }
    prev = level;
  }
  return result;
}

/**
 * Ab welchem Monat ausgewertet wird: von Hand festgelegt, sonst ab der
 * letzten Umstellung der Daueraufträge, sonst alle Monate.
 */
export function fundingEvaluation(
  rows: FundingMonth[],
  detectedSwitch: FundingSwitch | null,
  manualStartMonth: string | null,
): FundingEvaluation {
  const startMonth = manualStartMonth ?? detectedSwitch?.month ?? null;
  const basisMonths = windowOf(rows, startMonth).map((r) => r.month);
  return {
    startMonth,
    source: manualStartMonth !== null ? 'manual' : detectedSwitch ? 'switch' : 'all',
    detectedSwitch,
    manualStartMonth,
    basisMonths,
    sufficient: basisMonths.length >= MIN_MONTHS_FOR_RECOMMENDATION,
  };
}

/** Vollständige Monate ab `startMonth` (null = alle). */
function completeSince(rows: FundingMonth[], startMonth: string | null): FundingMonth[] {
  return rows.filter((r) => r.status === 'complete' && (startMonth === null || r.month >= startMonth));
}

/** Die letzten bis zu `FUNDING_WINDOW_MONTHS` vollständigen Monate ab `startMonth`. */
export function windowOf(rows: FundingMonth[], startMonth: string | null = null): FundingMonth[] {
  return completeSince(rows, startMonth).slice(-FUNDING_WINDOW_MONTHS);
}

/**
 * Verlauf statt Momentaufnahme (§ 12.4): Unterdeckungen in Folge bis zum
 * letzten vollständigen Monat, ob sie wächst, Durchschnitte im Fenster.
 * Unvollständige Monate zählen nicht – ein halber Monat sähe sonst gedeckt
 * aus. Monate vor `startMonth` (vor der Umstellung) zählen ebenfalls nicht.
 */
export function fundingTrend(rows: FundingMonth[], startMonth: string | null = null): FundingTrend {
  const window = windowOf(rows, startMonth);
  const complete = completeSince(rows, startMonth);
  let streak = 0;
  for (let i = complete.length - 1; i >= 0 && (complete[i] as FundingMonth).differenceCents < 0; i--) streak++;
  const streakRows = complete.slice(complete.length - streak);

  let direction: FundingTrend['direction'] = null;
  if (streak >= 2) {
    const first = -(streakRows[0] as FundingMonth).differenceCents;
    const last = -(streakRows[streakRows.length - 1] as FundingMonth).differenceCents;
    direction = last > first ? 'growing' : last < first ? 'shrinking' : 'steady';
  }

  return {
    status: complete.length === 0 ? 'unknown' : streak === 0 ? 'covered' : streak < TREND_MONTHS ? 'single' : 'trend',
    deficitStreak: streak,
    deficitSince: streakRows[0]?.month ?? null,
    direction,
    windowMonths: window.map((r) => r.month),
    deficitMonthsInWindow: window.filter((r) => r.differenceCents < 0).length,
    averageStandingOrdersCents: average(window.map((r) => r.standingOrdersCents)),
    averageExpensesCents: average(window.map((r) => r.expensesCents)),
    averageDifferenceCents: average(window.map((r) => r.differenceCents)),
  };
}

/**
 * Abbuchungen je Posten und Monat (positiv), ohne Umbuchungen. Gutschriften
 * bleiben außen vor – eine ausbleibende Erstattung ist kein gestiegener Posten.
 */
function itemMonthSums(transactions: FundingTransaction[], months: ReadonlySet<string>) {
  const items = new Map<string, { label: string; labelDate: string; byMonth: Map<string, number> }>();
  for (const t of transactions) {
    const month = t.date.slice(0, 7);
    if (t.isTransfer || t.amountCents >= 0 || !months.has(month)) continue;
    let item = items.get(t.key);
    if (!item) {
      item = { label: t.label, labelDate: t.date, byMonth: new Map() };
      items.set(t.key, item);
    }
    if (t.date >= item.labelDate) {
      item.label = t.label;
      item.labelDate = t.date;
    }
    item.byMonth.set(month, (item.byMonth.get(month) ?? 0) - t.amountCents);
  }
  return items;
}

/**
 * Empfehlung für den Dauerauftrag (§ 12.6) auf Grundlage der vollständigen
 * Monate ab `startMonth` (seit der letzten Umstellung). `null` bei weniger
 * als drei solchen Monaten.
 *
 * - Ist jeder Monat gedeckt und der Kontostand nicht fallend, passt der
 *   Dauerauftrag. Nur umzustellende Posten (§ 13), die die kleinste
 *   monatliche Überdeckung übersteigen, verlangen eine Erhöhung.
 * - Sonst: Bedarf = durchschnittliche Abbuchungen (Durchschnitt statt
 *   Median, damit Jahresbeiträge mitfinanziert sind) + Puffer aus der
 *   Schwankung der Monatssummen + Umzustellendes, auf volle 10 €
 *   aufgerundet. Liegt der Bedarf nicht über dem aktuellen Betrag, passt es.
 */
export function fundingRecommendation(
  rows: FundingMonth[],
  transactions: FundingTransaction[],
  currentCents: number,
  plannedMovesCents: number,
  startMonth: string | null = null,
  balance: Pick<BalanceAssessment, 'changeCents'> | null = null,
): FundingRecommendation | null {
  const window = windowOf(rows, startMonth);
  if (window.length < MIN_MONTHS_FOR_RECOMMENDATION) return null;
  const expenses = window.map((r) => r.expensesCents);
  const averageExpensesCents = average(expenses) as number;
  const bufferCents = Math.max(0, percentile(expenses, 80) - averageExpensesCents);
  const roundUp = (cents: number) => Math.ceil(Math.max(0, cents) / RECOMMENDATION_STEP_CENTS) * RECOMMENDATION_STEP_CENTS;
  const neededCents = roundUp(averageExpensesCents + bufferCents + plannedMovesCents);

  const allMonthsCovered = window.every((r) => r.differenceCents >= 0);
  const minSurplusCents = allMonthsCovered ? Math.min(...window.map((r) => r.differenceCents)) : null;
  const balanceFalling = balance?.changeCents == null ? null : balance.changeCents < 0;

  let recommendedCents: number;
  if (allMonthsCovered && balanceFalling !== true) {
    const missing = plannedMovesCents - (minSurplusCents as number);
    recommendedCents = missing > 0 ? roundUp(currentCents + missing) : currentCents;
  } else {
    recommendedCents = Math.max(currentCents, neededCents);
  }

  const months = window.map((r) => r.month);
  const fluctuating: FluctuatingItem[] = [];
  for (const [key, item] of itemMonthSums(transactions, new Set(months))) {
    if (item.byMonth.size < 2) continue;
    const values = months.map((m) => item.byMonth.get(m) ?? 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max - min < CAUSE_THRESHOLD_CENTS * 2) continue;
    fluctuating.push({ key, label: item.label, minCents: min, maxCents: max, averageCents: average(values) as number });
  }
  fluctuating.sort((a, b) => b.maxCents - b.averageCents - (a.maxCents - a.averageCents) || a.label.localeCompare(b.label));

  return {
    basisMonths: window.length,
    averageExpensesCents,
    minExpensesCents: Math.min(...expenses),
    maxExpensesCents: Math.max(...expenses),
    bufferCents,
    plannedMovesCents,
    neededCents,
    allMonthsCovered,
    minSurplusCents,
    balanceFalling,
    verdict: recommendedCents > currentCents ? 'increase' : 'fits',
    recommendedCents,
    currentCents,
    changeCents: recommendedCents - currentCents,
    fluctuating: fluctuating.slice(0, 5),
  };
}

/**
 * Letzte Betragsänderung eines Postens (Abbuchungen in zeitlicher
 * Reihenfolge). Nur bei festen Beträgen: der alte Betrag muss mindestens
 * zweimal in Folge vorgekommen sein – beim Supermarkt ist jeder Einkauf
 * anders, das ist keine Preiserhöhung.
 */
export function lastPriceChange(debits: { date: string; amountCents: number }[]): PriceChange | null {
  const sorted = [...debits].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) return null;
  const latest = (sorted[sorted.length - 1] as { amountCents: number }).amountCents;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const prev = sorted[i] as { date: string; amountCents: number };
    if (prev.amountCents !== latest) {
      const before = sorted[i - 1];
      if (!before || before.amountCents !== prev.amountCents) return null;
      return { date: (sorted[i + 1] as { date: string }).date, fromCents: -prev.amountCents, toCents: -latest };
    }
  }
  return null;
}

/**
 * Ursachen benennen (§ 12.7): welche Posten sind gestiegen und um wie
 * viel – Durchschnitt je Monat der letzten drei vollständigen Monate gegen
 * die bis zu sechs davor, beides ab `startMonth` (Monate vor einer
 * Umstellung beschreiben einen anderen Zustand). `null`, solange es keinen
 * Vergleichszeitraum gibt.
 */
export function fundingCauses(
  rows: FundingMonth[],
  transactions: FundingTransaction[],
  startMonth: string | null = null,
): FundingCauses | null {
  const complete = completeSince(rows, startMonth).map((r) => r.month);
  if (complete.length < CAUSE_RECENT_MONTHS + 1) return null;
  const recentMonths = complete.slice(-CAUSE_RECENT_MONTHS);
  const referenceMonths = complete.slice(-CAUSE_RECENT_MONTHS - CAUSE_REFERENCE_MONTHS, -CAUSE_RECENT_MONTHS);
  const recentSet = new Set(recentMonths);
  const referenceSet = new Set(referenceMonths);
  const items = itemMonthSums(transactions, new Set([...recentMonths, ...referenceMonths]));
  const sumOver = (byMonth: Map<string, number>, months: string[]) => months.reduce((s, m) => s + (byMonth.get(m) ?? 0), 0);

  const debitsByKey = new Map<string, { date: string; amountCents: number }[]>();
  for (const t of transactions) {
    if (t.isTransfer || t.amountCents >= 0) continue;
    const list = debitsByKey.get(t.key);
    if (list) list.push(t);
    else debitsByKey.set(t.key, [t]);
  }

  const result: CauseItem[] = [];
  for (const [key, item] of items) {
    const beforeCents = Math.round(sumOver(item.byMonth, referenceMonths) / referenceMonths.length);
    const recentCents = Math.round(sumOver(item.byMonth, recentMonths) / recentMonths.length);
    const increaseCents = recentCents - beforeCents;
    if (increaseCents < CAUSE_THRESHOLD_CENTS) continue;
    const change = lastPriceChange(debitsByKey.get(key) ?? []);
    const isNew = ![...item.byMonth.keys()].some((m) => referenceSet.has(m));
    result.push({
      key,
      label: item.label,
      beforeCents,
      recentCents,
      increaseCents,
      isNew,
      priceChange: change && recentSet.has(change.date.slice(0, 7)) && !isNew ? change : null,
    });
  }
  result.sort((a, b) => b.increaseCents - a.increaseCents || a.label.localeCompare(b.label));

  const avgExpenses = (months: string[]) =>
    Math.round(rows.filter((r) => months.includes(r.month)).reduce((s, r) => s + r.expensesCents, 0) / months.length);
  return {
    recentMonths,
    referenceMonths,
    totalChangeCents: avgExpenses(recentMonths) - avgExpenses(referenceMonths),
    items: result,
  };
}

/**
 * Saldoentwicklung (§ 12.5): zehrt die Unterdeckung an einem Polster, oder
 * ist das Konto schon im Minus? Reicht das Guthaben bei gleichbleibender
 * Unterdeckung noch N Monate?
 */
export function assessBalance(
  rows: FundingMonth[],
  trend: FundingTrend,
  current: BalanceInfo | null,
  startMonth: string | null = null,
): BalanceAssessment {
  const window = windowOf(rows, startMonth);
  const known = window.filter((r) => r.balanceEndCents !== null);
  const lowest = known.reduce<FundingMonth | null>(
    (low, r) => (low === null || (r.balanceEndCents as number) < (low.balanceEndCents as number) ? r : low),
    null,
  );
  // Ab dem Monat vor dem Fenster, sonst ab dem ersten Monat mit Kontostand.
  const last = window[window.length - 1];
  const first = window[0];
  const before = first ? rows.find((r) => r.month === shiftMonth(first.month, -1) && r.balanceEndCents !== null) : undefined;
  const from = before ?? known[0];
  const changeCents =
    last?.balanceEndCents != null && from?.balanceEndCents != null && from !== last ? last.balanceEndCents - from.balanceEndCents : null;

  let runwayMonths: number | null = null;
  if (current && current.balanceCents > 0 && trend.deficitStreak > 0) {
    const streak = completeSince(rows, startMonth).slice(-trend.deficitStreak);
    const deficit = -Math.round(streak.reduce((s, r) => s + r.differenceCents, 0) / streak.length);
    if (deficit > 0) runwayMonths = Math.floor(current.balanceCents / deficit);
  }

  return {
    status: current === null ? 'unknown' : current.balanceCents < 0 ? 'negative' : 'cushion',
    current,
    runwayMonths,
    lowestCents: lowest?.balanceEndCents ?? null,
    lowestMonth: lowest?.month ?? null,
    changeCents,
    changeSince: changeCents === null ? null : (from?.month ?? null),
  };
}
