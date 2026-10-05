import type { Bucket } from './categories';
import { apiRequest, query } from './client';
import type { Interval, MonthStatus } from './funding';
import type { RecurringKind } from './recurring';

// ---------------------------------------------------------------------------
// Offene Punkte
// ---------------------------------------------------------------------------

export type AttentionSeverity = 'bad' | 'warn' | 'info';

interface Base {
  severity: AttentionSeverity;
}

export type AttentionItem =
  | (Base & {
      kind: 'funding_deficit';
      accountId: number;
      accountName: string;
      trendStatus: 'covered' | 'single' | 'trend' | 'unknown' | null;
      deficitSince: string | null;
      deficitStreak: number;
      direction: 'growing' | 'shrinking' | 'steady' | null;
      recommendedCents: number | null;
      changeCents: number | null;
      negativeBalance: { balanceCents: number; date: string } | null;
    })
  | (Base & { kind: 'recurring_suggestions'; entries: { key: string; name: string; amountCents: number; interval: Interval; duplicate: boolean }[] })
  | (Base & {
      kind: 'recurring_price';
      /** Die abweichende Buchung (Datum, Betrag) – nicht unbedingt die letzte. */
      entries: { itemId: number; name: string; sollCents: number; date: string | null; actualCents: number | null }[];
    })
  | (Base & { kind: 'recurring_merged'; entries: { itemId: number; name: string; contracts: number }[] })
  | (Base & { kind: 'recurring_missing'; entries: { itemId: number; name: string; dueDate: string | null; ended: boolean }[] })
  | (Base & { kind: 'recurring_cancel'; entries: { itemId: number; name: string; cancelBy: string; contractEndDate: string }[] })
  | (Base & { kind: 'uncategorized'; count: number; outflowCents: number; inflowCents: number })
  | (Base & { kind: 'transfers_suggested'; count: number })
  | (Base & {
      kind: 'card_mismatch';
      entries: { transferId: number; cardAccountId: number; cardAccountName: string | null; periodStart: string; periodEnd: string; differenceCents: number }[];
    })
  | (Base & { kind: 'import_gap'; accountId: number; accountName: string; gaps: { start: string; end: string }[] })
  | (Base & { kind: 'import_stale'; accountId: number; accountName: string; lastDate: string; days: number })
  | (Base & { kind: 'export_due'; lastExportAt: string | null; days: number | null })
  | (Base & { kind: 'never_imported' | 'needs_reimport'; accountId: number; accountName: string });

export const fetchAttention = () => apiRequest<{ items: AttentionItem[] }>('GET', '/attention');

// ---------------------------------------------------------------------------
// Monatsübersicht
// ---------------------------------------------------------------------------

export interface MonthTotals {
  month: string;
  status: MonthStatus;
  incomeCents: number;
  expensesCents: number;
  balanceCents: number;
}

export interface CategoryExpense {
  categoryId: number | null;
  name: string;
  outflowCents: number;
  inflowCents: number;
  sharePermille: number;
  previousOutflowCents: number;
  changeCents: number;
}

export interface MonthCompleteness {
  month: string;
  status: MonthStatus;
  incomplete: { accountId: number; accountName: string; status: MonthStatus }[];
  notYetImported: { accountId: number; accountName: string }[];
}

export interface MonthOverview {
  month: string;
  accountId: number | null;
  availableMonths: string[];
  completeness: MonthCompleteness;
  totals: MonthTotals;
  previous: MonthTotals;
  categories: CategoryExpense[];
  transfers: { count: number; inflowCents: number; outflowCents: number };
  uncategorized: { count: number; outflowCents: number; inflowCents: number };
  history: MonthTotals[];
}

export const fetchOverview = (params: { month?: string | undefined; accountId?: number | undefined }) =>
  apiRequest<MonthOverview>('GET', `/overview${query(params)}`);

// ---------------------------------------------------------------------------
// Budget 50/30/20
// ---------------------------------------------------------------------------

export interface IncomeSource {
  key: string;
  label: string;
  accountId: number;
  accountName: string;
  interval: Interval;
  count: number;
  firstDate: string;
  lastDate: string;
  lastAmountCents: number;
  monthlyCents: number;
  nextDueDate: string;
  ended: boolean;
}

export interface BudgetCategory {
  categoryId: number;
  path: string;
  actualCents: number;
  typicalCents: number | null;
  deviationCents: number | null;
}

export interface BudgetBucket {
  bucket: Bucket;
  targetPercent: number;
  targetCents: number;
  actualCents: number;
  deviationCents: number;
  incomePermille: number;
  categories: BudgetCategory[];
  savingsTransfersCents: number;
}

export type BudgetSpan = 1 | 3 | 6 | 12;

export interface Budget {
  month: string;
  span: BudgetSpan;
  months: { month: string; status: MonthStatus }[];
  allComplete: boolean;
  income: {
    actualCents: number;
    expectedCents: number;
    basisCents: number;
    basisSource: 'actual' | 'expected' | 'none';
    allCreditsCents: number;
    sources: IncomeSource[];
  };
  buckets: BudgetBucket[];
  unassigned: { uncategorizedCents: number; categories: { categoryId: number; path: string; actualCents: number }[]; totalCents: number };
  typicalMonths: string[];
}

export const fetchBudget = (params: { month?: string | undefined; span?: BudgetSpan | undefined }) =>
  apiRequest<Budget>('GET', `/budget${query(params)}`);

// ---------------------------------------------------------------------------
// Prognose
// ---------------------------------------------------------------------------

export interface ForecastFixedItem {
  id: number;
  name: string;
  kind: RecurringKind;
  interval: Interval;
  amountCents: number;
  categoryId: number | null;
  rootCategoryId: number | null;
  months: number[];
  totalCents: number;
}

export interface ForecastCategory {
  categoryId: number | null;
  name: string;
  fixedMonths: number[];
  variableCents: number;
  months: number[];
  totalCents: number;
}

export interface ForecastIncome extends IncomeSource {
  months: number[];
  totalCents: number;
}

export interface ForecastMonth {
  month: string;
  incomeCents: number;
  fixedCents: number;
  variableCents: number;
  balanceCents: number;
  cumulativeCents: number;
  projectedBalanceCents: number | null;
}

export interface Forecast {
  months: string[];
  basisMonths: string[];
  income: ForecastIncome[];
  categories: ForecastCategory[];
  fixedItems: ForecastFixedItem[];
  excludedItems: { id: number; name: string; reason: 'ended' | 'no_due_date' }[];
  totals: ForecastMonth[];
  averageSurplusCents: number;
  startBalance: { totalCents: number; knownAccounts: number; activeAccounts: number };
}

export const fetchForecast = (months?: number) => apiRequest<Forecast>('GET', `/forecast${query({ months })}`);
