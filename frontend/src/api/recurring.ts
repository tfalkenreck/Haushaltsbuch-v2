import { apiRequest } from './client';
import type { Interval } from './funding';

export type RecurringKind = 'fixed_cost' | 'subscription';
export type NoticeUnit = 'days' | 'weeks' | 'months';
export type OccurrenceState = 'ok' | 'differs' | 'missing' | 'not_imported';
export type CheckStatus = 'ok' | 'differs' | 'missing' | 'ended' | 'no_bookings' | 'not_due' | 'inactive';

export interface Occurrence {
  dueDate: string;
  state: OccurrenceState;
  transactionId: number | null;
  date: string | null;
  amountCents: number | null;
}

export interface PriceChange {
  date: string;
  fromCents: number;
  toCents: number;
}

export interface ItemCheck {
  status: CheckStatus;
  occurrences: Occurrence[];
  missingCount: number;
  extraBookings: { transactionId: number; date: string; amountCents: number }[];
  lastBooking: { transactionId: number; date: string; amountCents: number } | null;
  priceChange: PriceChange | null;
  suggestedAmountCents: number | null;
  nextDueDate: string | null;
  scheduleFromBookings: boolean;
  cancel: { contractEndDate: string; cancelBy: string; state: 'open' | 'soon' | 'passed' | 'expired' } | null;
}

export interface RecurringItem {
  id: number;
  name: string;
  kind: RecurringKind;
  accountId: number | null;
  accountName: string | null;
  counterparty: string;
  amountCents: number;
  interval: Interval;
  monthlyCents: number;
  nextDueDate: string | null;
  contractEndDate: string | null;
  noticePeriodValue: number | null;
  noticePeriodUnit: NoticeUnit | null;
  categoryId: number | null;
  categoryPath: string | null;
  creditorId: string | null;
  mandateReference: string | null;
  origin: 'manual' | 'auto';
  isSuspected: boolean;
  active: boolean;
  notes: string | null;
  detectionKey: string | null;
  bookingCount: number;
  check: ItemCheck;
  duplicates: string[];
}

export interface RecurringSuggestion {
  key: string;
  providerKey: string;
  accountId: number;
  accountName: string;
  label: string;
  interval: Interval;
  count: number;
  firstDate: string;
  lastDate: string;
  lastAmountCents: number;
  monthlyCents: number;
  nextDueDate: string;
  suspected: boolean;
  ended: boolean;
  priceChange: PriceChange | null;
  kind: RecurringKind;
  categoryId: number | null;
  categoryPath: string | null;
  transactionIds: number[];
  duplicates: string[];
}

export interface RecurringOverview {
  items: RecurringItem[];
  suggestions: RecurringSuggestion[];
  dismissed: { id: number; name: string; amountCents: number; interval: Interval; detectionKey: string }[];
  totals: { count: number; monthlyCents: number; fixedCostMonthlyCents: number; subscriptionMonthlyCents: number };
}

export interface RecurringItemInput {
  name?: string;
  kind: RecurringKind;
  accountId: number | null;
  counterparty: string;
  /** Deutscher Betrag der Abbuchung, z. B. „9,99“. */
  amount: string;
  interval: Interval;
  nextDueDate: string;
  contractEndDate?: string | null;
  noticePeriodValue?: number | null;
  noticePeriodUnit?: NoticeUnit | null;
  categoryId?: number | null;
  creditorId?: string | null;
  mandateReference?: string | null;
  active?: boolean;
  notes?: string | null;
}

export const fetchRecurring = () => apiRequest<RecurringOverview>('GET', '/recurring');
export const createRecurring = (input: RecurringItemInput) =>
  apiRequest<{ id: number; overview: RecurringOverview }>('POST', '/recurring', input);
export const updateRecurring = (id: number, input: RecurringItemInput) => apiRequest<RecurringOverview>('PUT', `/recurring/${id}`, input);
/** Löschen bzw. verworfenen Vorschlag zurückholen. */
export const deleteRecurring = (id: number) => apiRequest<RecurringOverview>('DELETE', `/recurring/${id}`);
export const confirmSuggestion = (input: { key: string; name?: string; kind?: RecurringKind }) =>
  apiRequest<{ id: number; overview: RecurringOverview }>('POST', '/recurring/suggestions/confirm', input);
export const dismissSuggestion = (key: string) => apiRequest<RecurringOverview>('POST', '/recurring/suggestions/dismiss', { key });

/** Buchung von Hand einem Posten zuordnen; `null` = „nicht wiederkehrend“. */
export const setTransactionRecurring = (transactionId: number, itemId: number | null) =>
  apiRequest<null>('PUT', `/transactions/${transactionId}/recurring`, { itemId });
export const resetTransactionRecurring = (transactionId: number) => apiRequest<null>('DELETE', `/transactions/${transactionId}/recurring`);
