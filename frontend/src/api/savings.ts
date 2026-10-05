import { apiRequest, query } from './client';

export interface GoalPlan {
  id: number;
  currentCents: number;
  remainingCents: number;
  monthsToReach: number | null;
  reachMonth: string | null;
  monthsAvailable: number | null;
  neededMonthlyCents: number | null;
  onTrack: boolean | null;
}

export interface SavingsGoal {
  id: number;
  name: string;
  targetCents: number;
  targetDate: string | null;
  priority: number;
  accountId: number | null;
  accountName: string | null;
  active: boolean;
  balanceUnknown: boolean;
  plan: GoalPlan | null;
  withoutSelected: (GoalPlan & { monthsEarlier: number | null }) | null;
}

export interface SavingsOverview {
  currentMonth: string;
  surplusCents: number;
  forecastMonths: number;
  neededTotalCents: number;
  goals: SavingsGoal[];
  accounts: { accountId: number; accountName: string; balanceCents: number | null; balanceDate: string | null; allocatedCents: number }[];
  subscriptions: { id: number; name: string; monthlyCents: number; selected: boolean }[];
  selectedMonthlyCents: number;
}

export interface SavingsGoalInput {
  name: string;
  amount: string;
  targetDate: string | null;
  priority: number;
  accountId: number | null;
  active: boolean;
}

/** `without` = IDs der Abos, deren Wegfall durchgerechnet wird; weggelassen = alle. */
export const fetchSavingsGoals = (without?: number[]) =>
  apiRequest<SavingsOverview>('GET', `/savings-goals${without === undefined ? '' : query({ without: without.join(',') }) || '?without='}`);
export const createSavingsGoal = (input: SavingsGoalInput) => apiRequest<{ id: number }>('POST', '/savings-goals', input);
export const updateSavingsGoal = (id: number, input: SavingsGoalInput) => apiRequest<null>('PUT', `/savings-goals/${id}`, input);
export const deleteSavingsGoal = (id: number) => apiRequest<null>('DELETE', `/savings-goals/${id}`);
