import { apiRequest, query } from './client';
import type { RuleSuggestion } from './rules';
import type { TransferKind, TransferStatus } from './transfers';

export type CategorySource = 'manual' | 'rule' | 'auto';

export interface Transaction {
  id: number;
  accountId: number;
  accountName: string;
  bookingDate: string;
  valueDate: string | null;
  amountCents: number;
  currency: string;
  counterparty: string;
  counterpartyIban: string | null;
  purpose: string;
  bookingText: string;
  creditorId: string | null;
  mandateReference: string | null;
  balanceAfterCents: number | null;
  importBatchId: number | null;
  categoryId: number | null;
  categoryPath: string | null;
  categorySource: CategorySource | null;
  categoryRuleId: number | null;
  transferId: number | null;
  transferKind: TransferKind | null;
  transferStatus: TransferStatus | null;
  /** manual = von Hand (auch „bewusst keine Umbuchung“), auto = erkannt. */
  transferSource: 'manual' | 'auto' | null;
  transferAccountName: string | null;
}

export interface TransactionPage {
  items: Transaction[];
  total: number;
  inflowCents: number;
  outflowCents: number;
  transferCount: number;
  transferInflowCents: number;
  transferOutflowCents: number;
  limit: number;
  offset: number;
}

export interface TransactionFilter {
  accountId?: number | undefined;
  importBatchId?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
  /** bank = von/bis nach Buchungstag der Bank (Kartenabrechnung). */
  dateBasis?: 'booking' | 'bank' | undefined;
  q?: string | undefined;
  categoryId?: number | undefined;
  uncategorized?: boolean | undefined;
  transfers?: 'only' | 'exclude' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface UncategorizedSummary {
  count: number;
  inflowCents: number;
  outflowCents: number;
}

export interface CategoryChange {
  transaction: Transaction;
  suggestion: RuleSuggestion | null;
}

export const fetchTransactions = ({ uncategorized, ...filter }: TransactionFilter) =>
  apiRequest<TransactionPage>('GET', `/transactions${query({ ...filter, uncategorized: uncategorized ? 'true' : undefined })}`);

export const fetchUncategorizedSummary = () => apiRequest<UncategorizedSummary>('GET', '/transactions/uncategorized');

/** Kategorie von Hand setzen; `null` = bewusst keine Kategorie. */
export const setTransactionCategory = (id: number, categoryId: number | null) =>
  apiRequest<CategoryChange>('PUT', `/transactions/${id}/category`, { categoryId });

/** Handarbeit aufheben – Regeln dürfen die Buchung wieder einordnen. */
export const resetTransactionCategory = (id: number) => apiRequest<Transaction>('DELETE', `/transactions/${id}/category`);
