import { apiRequest } from './client';

export type MonthStatus = 'complete' | 'partial' | 'missing';

export interface StandingOrderOccurrence {
  transactionId: number;
  date: string;
  amountCents: number;
  month: string;
}

export interface StandingOrder {
  sourceAccountId: number | null;
  sourceAccountName: string | null;
  dayOfMonth: number;
  firstDate: string;
  lastDate: string;
  amountCents: number;
  active: boolean;
  suspected: boolean;
  endedSince: string | null;
  occurrences: StandingOrderOccurrence[];
  changes: { date: string; fromCents: number; toCents: number }[];
}

export interface FundingMonth {
  month: string;
  status: MonthStatus;
  standingOrdersCents: number;
  otherTransfersCents: number;
  debitsCents: number;
  creditsCents: number;
  expensesCents: number;
  /** Daueraufträge minus Abbuchungen; < 0 = Unterdeckung. */
  differenceCents: number;
  balanceEndCents: number | null;
}

export interface FundingTrend {
  status: 'covered' | 'single' | 'trend' | 'unknown';
  deficitStreak: number;
  deficitSince: string | null;
  direction: 'growing' | 'shrinking' | 'steady' | null;
  windowMonths: string[];
  deficitMonthsInWindow: number;
  averageStandingOrdersCents: number | null;
  averageExpensesCents: number | null;
  averageDifferenceCents: number | null;
}

export interface FundingRecommendation {
  basisMonths: number;
  averageExpensesCents: number;
  bufferCents: number;
  plannedMovesCents: number;
  recommendedCents: number;
  currentCents: number;
  changeCents: number;
  fluctuating: { key: string; label: string; minCents: number; maxCents: number; averageCents: number }[];
}

export interface CauseItem {
  key: string;
  label: string;
  beforeCents: number;
  recentCents: number;
  increaseCents: number;
  isNew: boolean;
  priceChange: { date: string; fromCents: number; toCents: number } | null;
}

export interface FundingCauses {
  recentMonths: string[];
  referenceMonths: string[];
  totalChangeCents: number;
  items: CauseItem[];
}

export type BalanceSource = 'bank' | 'import' | 'manual';

export interface BalanceAssessment {
  status: 'negative' | 'cushion' | 'unknown';
  current: { balanceCents: number; date: string; source: BalanceSource } | null;
  runwayMonths: number | null;
  lowestCents: number | null;
  lowestMonth: string | null;
  changeCents: number | null;
  changeSince: string | null;
}

export interface ManualBalance {
  id: number;
  accountId: number;
  date: string;
  balanceCents: number;
  notes: string | null;
  createdAt: string;
}

export interface PlannedIncrease {
  accountId: number;
  accountName: string;
  count: number;
  monthlyCents: number;
}

export interface FundingAnalysis {
  accountId: number;
  accountName: string;
  role: string;
  dataEnd: string | null;
  standingOrders: StandingOrder[];
  standingOrdersTotalCents: number;
  extraTransferCount: number;
  months: FundingMonth[];
  trend: FundingTrend;
  recommendation: FundingRecommendation | null;
  causes: FundingCauses | null;
  balance: BalanceAssessment;
  hasBankBalances: boolean;
  manualBalances: ManualBalance[];
  plannedMoves: PlannedIncrease | null;
}

export type Interval = 'biweekly' | 'monthly' | 'quarterly' | 'semiannual' | 'annual';
export type BypassDecision = 'move' | 'keep';

export interface BypassItem {
  key: string;
  sourceAccountId: number;
  sourceAccountName: string;
  label: string;
  categoryPath: string | null;
  interval: Interval;
  count: number;
  firstDate: string;
  lastDate: string;
  lastAmountCents: number;
  monthlyCents: number;
  nextDueDate: string;
  status: 'active' | 'switched' | 'ended';
  switchedTo: { accountId: number; accountName: string; date: string } | null;
  decision: BypassDecision | null;
  targetAccountId: number | null;
  targetAccountName: string | null;
}

export interface BypassOverview {
  items: BypassItem[];
  targets: { id: number; name: string }[];
  plannedIncreases: PlannedIncrease[];
  unassignedMoves: number;
}

export const fetchFunding = (accountId: number) => apiRequest<FundingAnalysis>('GET', `/accounts/${accountId}/funding`);

/** Kontostand am Ende eines Tages von Hand erfassen; `amount` als deutscher Betrag („1.234,56“). */
export const createManualBalance = (accountId: number, input: { date: string; amount: string; notes: string | null }) =>
  apiRequest<ManualBalance>('POST', `/accounts/${accountId}/balances`, input);
export const deleteManualBalance = (id: number) => apiRequest<null>('DELETE', `/balances/${id}`);

export const fetchBypass = () => apiRequest<BypassOverview>('GET', '/bypass');
/** `decision` null = Entscheidung zurücknehmen. */
export const setBypassDecision = (input: {
  sourceAccountId: number;
  key: string;
  decision: BypassDecision | null;
  targetAccountId?: number | null;
}) => apiRequest<BypassOverview>('PUT', '/bypass/decision', input);
