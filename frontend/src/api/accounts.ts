import { apiRequest } from './client';

export type AccountRole = 'einnahmen' | 'ausgaben' | 'sparen' | 'kreditkarte';

export interface Account {
  id: number;
  name: string;
  role: AccountRole;
  bankAdapter: string;
  iban: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  balanceCents: number | null;
  balanceDate: string | null;
  coverageStart: string | null;
  coverageEnd: string | null;
  transactionCount: number;
  /** Importe mit Kartenumsätzen ohne Buchungstag der Bank – neu importieren. */
  needsReimport: boolean;
}

export interface BankAdapter {
  id: string;
  label: string;
}

export interface AccountInput {
  name: string;
  role: AccountRole;
  bankAdapter: string;
  iban: string | null;
}

export type AccountPatch = Partial<AccountInput> & { active?: boolean };

export const fetchAccounts = () => apiRequest<Account[]>('GET', '/accounts');
export const fetchBankAdapters = () => apiRequest<BankAdapter[]>('GET', '/bank-adapters');
export const fetchAccountRoles = () => apiRequest<AccountRole[]>('GET', '/account-roles');
export const createAccount = (input: AccountInput) => apiRequest<Account>('POST', '/accounts', input);
export const updateAccount = (id: number, patch: AccountPatch) =>
  apiRequest<Account>('PATCH', `/accounts/${id}`, patch);
