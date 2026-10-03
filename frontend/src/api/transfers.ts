import { apiRequest, query } from './client';

export type TransferKind = 'pair' | 'one_sided' | 'card_settlement';
export type TransferStatus = 'suggested' | 'confirmed';

export interface TransferTransaction {
  id: number;
  accountId: number;
  accountName: string;
  bookingDate: string;
  amountCents: number;
  counterparty: string;
  purpose: string;
}

export interface CardCheck {
  purchaseCount: number;
  purchasesCents: number;
  /** Abgebucht minus Summe der Kartenumsätze; 0 = plausibel. */
  differenceCents: number;
}

export interface Transfer {
  id: number;
  kind: TransferKind;
  origin: 'auto' | 'manual';
  status: TransferStatus;
  fromAccountId: number | null;
  fromAccountName: string | null;
  toAccountId: number | null;
  toAccountName: string | null;
  amountCents: number;
  date: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  reason: string | null;
  transactions: TransferTransaction[];
  counterMissing: boolean;
  card: CardCheck | null;
}

export interface DetectionResult {
  created: number;
  completed: number;
}

export const fetchTransfers = (filter: { status?: TransferStatus; accountId?: number } = {}) =>
  apiRequest<Transfer[]>('GET', `/transfers${query(filter)}`);
export const detectTransfers = () => apiRequest<DetectionResult>('POST', '/transfers/detect');
export const confirmTransfer = (id: number) => apiRequest<Transfer>('POST', `/transfers/${id}/confirm`);
/** Fehlerkennung aufheben – die Buchungen zählen wieder und werden nicht erneut vorgeschlagen. */
export const dissolveTransfer = (id: number) => apiRequest<{ released: number }>('DELETE', `/transfers/${id}`);

/** Buchung von Hand als Umbuchung markieren (Gegenkonto optional). */
export const markTransfer = (transactionId: number, accountId: number | null) =>
  apiRequest<Transfer>('PUT', `/transactions/${transactionId}/transfer`, { accountId });
/** „Keine Umbuchung“. */
export const unmarkTransfer = (transactionId: number) => apiRequest<null>('DELETE', `/transactions/${transactionId}/transfer`);
/** Handarbeit aufheben, die Erkennung darf wieder entscheiden. */
export const resetTransfer = (transactionId: number) =>
  apiRequest<DetectionResult>('POST', `/transactions/${transactionId}/transfer/reset`);
