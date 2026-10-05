import { apiRequest, query } from './client';

export type TransferKind = 'pair' | 'one_sided' | 'card_settlement';
export type TransferStatus = 'suggested' | 'confirmed';
/** Datum, nach dem Kartenumsätze einer Abrechnung zugeordnet werden. */
export type CardDateField = 'booking_date' | 'bank_booking_date' | 'value_date';

/** Zuordnungsregel einer Karte: Datum und ob der Stichtag (Abrechnungsdatum) noch dazugehört. */
export interface CardRule {
  date: CardDateField;
  cutoff: 'inclusive' | 'exclusive';
}

export interface CardBoundary {
  side: 'start' | 'end';
  neighborTransferId: number | null;
  neighborDifferenceCents: number | null;
  /** Nachbarabrechnung weicht um genau den Gegenbetrag ab. */
  counterDeviation: boolean;
  purchases: {
    id: number;
    /** Datum nach der Regel der Karte. */
    date: string;
    amountCents: number;
    inPeriod: boolean;
    /** Auf der anderen Seite der Grenze ginge die Abrechnung auf. */
    explains: boolean;
    counterparty: string;
    purpose: string;
  }[];
}

export interface CardRuleSummary {
  accountId: number;
  accountName: string;
  rule: CardRule;
  statements: number;
  checked: number;
  results: { rule: CardRule; exact: number; deviationCents: number }[];
}

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
  /** Regel der Karte; null = kein Abrechnungsdatum im Text (Kaufdatum). */
  rule: CardRule | null;
  boundaries: CardBoundary[];
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
  periodDate: CardDateField | null;
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
export const fetchCardRules = () => apiRequest<CardRuleSummary[]>('GET', '/transfers/card-rules');
export const detectTransfers = () => apiRequest<DetectionResult>('POST', '/transfers/detect');
export const confirmTransfer = (id: number) => apiRequest<Transfer>('POST', `/transfers/${id}/confirm`);
/** Anzahl vorgeschlagener Paare, deren Gegen-IBAN ein eigenes Konto ist. */
export const fetchOwnIbanPairCount = () => apiRequest<{ count: number }>('GET', '/transfers/own-iban-pairs');
/** Diese Paare gesammelt bestätigen. */
export const confirmOwnIbanPairs = () => apiRequest<{ confirmed: number }>('POST', '/transfers/own-iban-pairs/confirm');
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
