import { normalizeCounterparty } from './normalize.js';

export interface KeyedTransaction {
  counterparty: string;
  counterpartyNormalized: string;
  purpose: string;
  creditorId: string | null;
  mandateReference: string | null;
}

/**
 * Schlüssel des Postens hinter einer Buchung, unabhängig vom Konto:
 * normalisierte Gegenpartei, ersatzweise Gläubiger-ID, ersatzweise die
 * ersten Wörter des normalisierten Verwendungszwecks. Basis für
 * Ursachen der Deckungsprüfung und Kontowechsel-Erkennung (§ 12, § 13).
 */
export function baseItemKey(t: KeyedTransaction): string {
  if (t.counterpartyNormalized) return `cp:${t.counterpartyNormalized}`;
  if (t.creditorId) return `cid:${t.creditorId.toUpperCase()}`;
  const words = normalizeCounterparty(t.purpose).split(' ').filter(Boolean).slice(0, 4).join(' ');
  return words ? `txt:${words}` : 'txt:';
}

/**
 * Schlüssel eines Vertrags: wie `baseItemKey`, bei SEPA-Lastschriften
 * zusätzlich die Mandatsreferenz – zwei Versicherungen beim selben
 * Versicherer bleiben zwei Posten.
 */
export function contractKey(t: KeyedTransaction): string {
  const base = baseItemKey(t);
  return t.mandateReference ? `${base}|m:${t.mandateReference}` : base;
}

/** Basis-Schlüssel aus einem Vertragsschlüssel. */
export function baseOf(key: string): string {
  const cut = key.indexOf('|m:');
  return cut === -1 ? key : key.slice(0, cut);
}

/** Anzeigename eines Postens: Gegenpartei, sonst der Anfang des Verwendungszwecks. */
export function itemLabel(t: { counterparty: string; purpose: string }): string {
  const text = (t.counterparty.trim() || t.purpose.trim()).replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 57)}…` : text || '(ohne Text)';
}
