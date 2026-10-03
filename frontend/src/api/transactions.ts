import { apiRequest, query } from './client';

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
}

export interface TransactionPage {
  items: Transaction[];
  total: number;
  inflowCents: number;
  outflowCents: number;
  limit: number;
  offset: number;
}

export interface TransactionFilter {
  accountId?: number | undefined;
  importBatchId?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export const fetchTransactions = (filter: TransactionFilter) =>
  apiRequest<TransactionPage>('GET', `/transactions${query({ ...filter })}`);
