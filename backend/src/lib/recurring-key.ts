import { normalizeCounterparty } from './normalize.js';

/**
 * Schlüssel für Fixkosten und Abos (CLAUDE.md § 14, § 19): wer steckt
 * hinter einer Abbuchung, und zu welchem Vertrag gehört sie?
 *
 * Reihenfolge: Mandatsreferenz vor Gläubiger-ID vor Gegen-IBAN vor
 * normalisierter Gegenpartei.
 *
 * - Zahlungsdienste (PayPal) sind nicht der Anbieter: Bei Lastschriften
 *   steht der Händler im Verwendungszweck („Ihr Einkauf bei Audible Ltd“),
 *   bei Kartenumsätzen im Händlernamen („PAYPAL *AUDIBLE“). Beides ergibt
 *   `paypal audible` – Gläubiger-ID, Mandatsreferenz und IBAN von PayPal
 *   sind für alle Einkäufe gleich und taugen hier nicht als Schlüssel.
 * - Anbieter: Gläubiger-ID (bleibt gleich, auch wenn die Schreibweise der
 *   Gegenpartei schwankt), sonst Gegen-IBAN (Überweisungen und
 *   Daueraufträge an verschiedene Empfänger gleichen Namens – etwa den
 *   Kontoinhaber selbst – bleiben getrennt), sonst Gegenpartei.
 * - Vertrag: Anbieter plus Mandatsreferenz – sechs Verträge beim selben
 *   Versicherer bleiben sechs Verträge.
 */

export interface RecurringKeyInput {
  counterparty: string;
  counterpartyNormalized: string;
  purpose: string;
  creditorId: string | null;
  mandateReference: string | null;
  counterpartyIban: string | null;
}

const INTERMEDIARY = /^paypal\b/;
const PURCHASE_AT = /(?:ihr\s+einkauf\s+bei|einkauf\s+bei)\s+([^,/]+)/i;
const PAYPAL_REF = /\bPP\.\d+\.PP\s*\.?\s*([^,/]+)/i;

/** Händler hinter einem Zahlungsdienst, normalisiert; `null`, wenn keiner erkennbar ist. */
function intermediaryMerchant(purpose: string): string | null {
  const match = PURCHASE_AT.exec(purpose) ?? PAYPAL_REF.exec(purpose);
  const merchant = match?.[1] ? normalizeCounterparty(match[1]) : '';
  return merchant === '' ? null : merchant;
}

function isIntermediary(t: RecurringKeyInput): boolean {
  return INTERMEDIARY.test(t.counterpartyNormalized);
}

/**
 * Gegenpartei, wie sie die Fixkosten-Zuordnung sieht: normalisiert, bei
 * Zahlungsdiensten mit dem Händler aus dem Verwendungszweck, ohne
 * Gegenpartei die ersten Wörter des Verwendungszwecks.
 */
export function effectiveCounterparty(t: RecurringKeyInput): string {
  if (isIntermediary(t)) {
    const merchant = intermediaryMerchant(t.purpose);
    if (merchant !== null) return `paypal ${merchant}`;
    return t.counterpartyNormalized;
  }
  if (t.counterpartyNormalized) return t.counterpartyNormalized;
  return normalizeCounterparty(t.purpose).split(' ').filter(Boolean).slice(0, 4).join(' ');
}

/** IBAN ohne Leerzeichen, groß; `null`, wenn keine angegeben ist. */
export function compactIban(iban: string | null): string | null {
  const compact = iban?.replace(/\s+/g, '').toUpperCase() ?? '';
  return compact === '' ? null : compact;
}

/** Anbieter: PayPal-Händler, sonst Gläubiger-ID, sonst Gegen-IBAN, sonst Gegenpartei. */
export function providerKey(t: RecurringKeyInput): string {
  if (isIntermediary(t)) return `cp:${effectiveCounterparty(t)}`;
  if (t.creditorId?.trim()) return `cid:${t.creditorId.trim().toUpperCase()}`;
  const iban = compactIban(t.counterpartyIban);
  if (iban) return `iban:${iban}`;
  return `cp:${effectiveCounterparty(t)}`;
}

/** Vertrag: Anbieter plus Mandatsreferenz (nicht bei Zahlungsdiensten). */
export function contractKey(t: RecurringKeyInput): string {
  const provider = providerKey(t);
  return t.mandateReference?.trim() && !isIntermediary(t) ? `${provider}|m:${t.mandateReference.trim()}` : provider;
}

/** Hängt der Schlüssel an einem Vertrag (Mandatsreferenz) statt nur am Anbieter? */
export const isContractLevel = (key: string) => key.includes('|m:');

/** Zahlungsdienst wie PayPal – dessen Gläubiger-ID, Mandat und IBAN gehören nicht zum Händler. */
export function viaIntermediary(t: RecurringKeyInput): boolean {
  return isIntermediary(t);
}

/** Anbieter-Schlüssel aus einem Erkennungsschlüssel (ohne Mandat und Zusatz für doppelte Abos). */
export function providerOf(key: string): string {
  return key.replace(/\|m:.*$/, '').replace(/@d\d+$/, '');
}

/** Ganze Wörter von `needle` stehen zusammenhängend in `haystack`. */
export function containsWords(haystack: string, needle: string): boolean {
  if (needle === '') return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/** Anzeigename hinter einem Zahlungsdienst: „PayPal: Audible Ltd“, sonst Gegenpartei bzw. Verwendungszweck. */
export function recurringLabel(t: RecurringKeyInput): string {
  if (isIntermediary(t)) {
    const match = PURCHASE_AT.exec(t.purpose) ?? PAYPAL_REF.exec(t.purpose);
    const merchant = match?.[1]?.trim();
    if (merchant) return `PayPal: ${merchant}`;
  }
  const text = (t.counterparty.trim() || t.purpose.trim()).replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 57)}…` : text || '(ohne Text)';
}
