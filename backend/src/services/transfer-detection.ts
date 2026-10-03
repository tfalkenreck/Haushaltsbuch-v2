import { addDays } from '../lib/date.js';
import { normalizeIban } from '../lib/iban.js';

/**
 * Reine Erkennungslogik für Umbuchungen zwischen eigenen Konten
 * (CLAUDE.md § 10, § 11) – ohne Datenbank testbar. Der Service
 * `transfers.ts` lädt die Kandidaten, ruft diese Funktionen auf und
 * schreibt das Ergebnis.
 */

/** „Innerhalb weniger Tage“: Wochenende plus Feiertag (Karfreitag–Ostermontag). */
export const TRANSFER_WINDOW_DAYS = 5;

/** Wie weit vor der Sammelabbuchung Kartenumsätze für den Abrechnungszeitraum gesucht werden. */
export const CARD_LOOKBACK_DAYS = 62;

export interface OwnAccount {
  id: number;
  name: string;
  role: string;
  iban: string | null;
}

/** Buchung, die die Erkennung noch einordnen darf (keine Umbuchung, nie von Hand angefasst). */
export interface TransferCandidate {
  id: number;
  accountId: number;
  bookingDate: string;
  amountCents: number;
  counterparty: string;
  counterpartyIban: string | null;
  purpose: string;
}

export function daysApart(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000));
}

const isCard = (account: OwnAccount | undefined) => account?.role === 'kreditkarte';

/** Text, in dem eine IBAN mit oder ohne Leerzeichen stehen kann, ohne Leerraum und groß. */
function compact(text: string): string {
  return normalizeIban(text);
}

/** Eigenes Konto, dessen IBAN die Buchung als Gegen-IBAN oder im Text nennt (nicht das eigene). */
export function ownAccountNamedBy(t: TransferCandidate, accounts: OwnAccount[]): { account: OwnAccount; via: 'iban' | 'text' } | null {
  const others = accounts.filter((a) => a.id !== t.accountId && a.iban !== null);
  const byIban = t.counterpartyIban ? others.find((a) => a.iban === t.counterpartyIban) : undefined;
  if (byIban) return { account: byIban, via: 'iban' };
  const text = compact(`${t.counterparty} ${t.purpose}`);
  const byText = others.find((a) => text.includes(a.iban as string));
  return byText ? { account: byText, via: 'text' } : null;
}

// ---------------------------------------------------------------------------
// Paare 1:1
// ---------------------------------------------------------------------------

export interface PairMatch {
  debitId: number;
  creditId: number;
  reason: string;
}

/**
 * Paare: gleicher Betrag mit umgekehrtem Vorzeichen, Datum höchstens
 * `TRANSFER_WINDOW_DAYS` auseinander, zwei verschiedene angelegte Konten.
 * Kreditkartenkonten sind ausgenommen (dort gilt die Kartenabrechnung).
 *
 * Ausgeschlossen, wenn eine Seite eine Gegen-IBAN nennt, die nicht zum
 * anderen Konto gehört (die Überweisung ging nachweislich woanders hin).
 * Bei mehreren Möglichkeiten gewinnt zuerst die passende IBAN, dann der
 * kleinere Datumsabstand; jede Buchung landet in höchstens einem Paar.
 */
export function matchPairs(candidates: TransferCandidate[], accounts: OwnAccount[]): PairMatch[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const usable = candidates.filter((t) => t.amountCents !== 0 && !isCard(byId.get(t.accountId)));
  const debits = usable.filter((t) => t.amountCents < 0);
  const credits = usable.filter((t) => t.amountCents > 0);

  const options: { debit: TransferCandidate; credit: TransferCandidate; evidence: number; days: number }[] = [];
  for (const debit of debits) {
    for (const credit of credits) {
      if (credit.accountId === debit.accountId || credit.amountCents !== -debit.amountCents) continue;
      const days = daysApart(debit.bookingDate, credit.bookingDate);
      if (days > TRANSFER_WINDOW_DAYS) continue;
      const debitAccount = byId.get(debit.accountId);
      const creditAccount = byId.get(credit.accountId);
      if (debit.counterpartyIban && creditAccount?.iban && debit.counterpartyIban !== creditAccount.iban) continue;
      if (credit.counterpartyIban && debitAccount?.iban && credit.counterpartyIban !== debitAccount.iban) continue;
      const evidence =
        (debit.counterpartyIban !== null && debit.counterpartyIban === creditAccount?.iban ? 1 : 0) +
        (credit.counterpartyIban !== null && credit.counterpartyIban === debitAccount?.iban ? 1 : 0);
      options.push({ debit, credit, evidence, days });
    }
  }
  options.sort(
    (a, b) => b.evidence - a.evidence || a.days - b.days || a.debit.id - b.debit.id || a.credit.id - b.credit.id,
  );

  const used = new Set<number>();
  const pairs: PairMatch[] = [];
  for (const o of options) {
    if (used.has(o.debit.id) || used.has(o.credit.id)) continue;
    used.add(o.debit.id);
    used.add(o.credit.id);
    const reason = [
      o.days === 0 ? 'Betrag und Datum passen' : `Betrag passt, ${o.days} Tag(e) Abstand`,
      o.evidence > 0 ? 'Gegen-IBAN ist das eigene Konto' : null,
    ]
      .filter(Boolean)
      .join('; ');
    pairs.push({ debitId: o.debit.id, creditId: o.credit.id, reason });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Einseitig, vermutet
// ---------------------------------------------------------------------------

/** Begriffe im Verwendungszweck, die auf eine Umbuchung zwischen eigenen Konten deuten. */
const TRANSFER_WORDS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bumbuchung/i, label: 'Umbuchung' },
  { pattern: /\b(?:ü|ue)bertrag\b/i, label: 'Übertrag' },
  { pattern: /\beigene[snm]?\s+konto/i, label: 'eigenes Konto' },
  { pattern: /\bkontoausgleich\b/i, label: 'Kontoausgleich' },
];

export interface OneSidedMatch {
  transactionId: number;
  /** Gegenkonto, falls über die IBAN bekannt. */
  otherAccountId: number | null;
  reason: string;
}

/**
 * Vermutete Umbuchung, deren Gegenbuchung fehlt: Gegen-IBAN (oder eine im
 * Text genannte IBAN) gehört zu einem eigenen Konto, oder der
 * Verwendungszweck spricht von einer Umbuchung. Kartenumsätze sind
 * ausgenommen.
 */
export function oneSidedEvidence(t: TransferCandidate, accounts: OwnAccount[]): OneSidedMatch | null {
  const own = accounts.find((a) => a.id === t.accountId);
  if (t.amountCents === 0 || (isCard(own) && t.amountCents < 0)) return null;
  const named = ownAccountNamedBy(t, accounts);
  if (named) {
    return {
      transactionId: t.id,
      otherAccountId: named.account.id,
      reason:
        named.via === 'iban'
          ? `Gegen-IBAN gehört zum Konto „${named.account.name}“`
          : `Verwendungszweck nennt die IBAN von „${named.account.name}“`,
    };
  }
  const word = TRANSFER_WORDS.find((w) => w.pattern.test(t.purpose));
  if (word) return { transactionId: t.id, otherAccountId: null, reason: `Verwendungszweck enthält „${word.label}“` };
  return null;
}

// ---------------------------------------------------------------------------
// Kartenabrechnung 1:n
// ---------------------------------------------------------------------------

/** Begriffe, an denen die Gutschrift auf dem Kartenkonto (Ausgleich) erkennbar ist. */
const CARD_CREDIT_WORDS = /ausgleich|kartenkonto|lastschrifteinzug|abrechnung|zahlung erhalten|einzug/i;

/** Begriffe, an denen eine Sammelabbuchung auf dem Girokonto erkennbar sein kann. */
const CARD_DEBIT_WORDS = /\bvisa\b|kreditkart|mastercard|\bamex\b|kartenabrechnung/i;

/** Gutschrift auf dem Kartenkonto, die nach Ausgleich der Abrechnung aussieht. */
export function looksLikeCardCredit(t: TransferCandidate, card: OwnAccount, accounts: OwnAccount[]): boolean {
  if (t.accountId !== card.id || t.amountCents <= 0) return false;
  const named = ownAccountNamedBy(t, accounts);
  return named !== null || CARD_CREDIT_WORDS.test(`${t.counterparty} ${t.purpose}`);
}

/**
 * Hinweis aus dem Text, dass eine Abbuchung zur Karte gehört: IBAN bzw.
 * Kartenkontonummer der Karte (stark) oder Begriffe wie „Visa“ (schwach –
 * auch Kartenentgelte heißen so, deshalb muss dann der Betrag passen).
 */
export function cardDebitHint(t: TransferCandidate, card: OwnAccount, accounts: OwnAccount[]): 'iban' | 'word' | null {
  if (t.accountId === card.id || t.amountCents >= 0) return null;
  const named = ownAccountNamedBy(t, accounts);
  if (named?.account.id === card.id) return 'iban';
  if (named) return null;
  return CARD_DEBIT_WORDS.test(`${t.counterparty} ${t.purpose}`) ? 'word' : null;
}

export interface CardPurchase {
  bookingDate: string;
  amountCents: number;
}

export interface CardPeriod {
  start: string;
  end: string;
  /** Summe der Kartenumsätze im Zeitraum als positiver Abrechnungsbetrag. */
  sumCents: number;
  /** Summe entspricht genau der Sammelabbuchung. */
  exact: boolean;
}

/**
 * Abrechnungszeitraum einer Sammelabbuchung (§ 11): zusammenhängende
 * Kaufdaten vor der Abbuchung, deren Umsätze in Summe genau den
 * abgebuchten Betrag ergeben. Beginn ist der Tag nach dem Ende der
 * vorigen Abrechnung (`fixedStart`), sonst frei gesucht. Bevorzugt wird
 * das späteste passende Ende, dann der längste Zeitraum.
 *
 * Passt keine Summe, gilt `fixedStart` bzw. die erste Kartenbuchung im
 * Suchfenster bis zum Vortag der Abbuchung – die Abweichung zeigt dann
 * die Plausibilitätsprüfung.
 */
export function findCardPeriod(
  purchases: CardPurchase[],
  amountCents: number,
  settlementDate: string,
  fixedStart: string | null,
): CardPeriod {
  const lastDay = addDays(settlementDate, -1);
  const earliest = fixedStart ?? addDays(settlementDate, -CARD_LOOKBACK_DAYS);
  const inWindow = purchases
    .filter((p) => p.bookingDate >= earliest && p.bookingDate <= lastDay)
    .sort((a, b) => a.bookingDate.localeCompare(b.bookingDate));

  // Summen je Kaufdatum, damit ein Zeitraum nie einen Tag teilt.
  const days: { date: string; cents: number }[] = [];
  for (const p of inWindow) {
    const last = days[days.length - 1];
    if (last && last.date === p.bookingDate) last.cents -= p.amountCents;
    else days.push({ date: p.bookingDate, cents: -p.amountCents });
  }
  const prefix = [0];
  for (const d of days) prefix.push((prefix[prefix.length - 1] as number) + d.cents);
  const sum = (from: number, to: number) => (prefix[to + 1] as number) - (prefix[from] as number);

  for (let end = days.length - 1; end >= 0; end--) {
    const starts = fixedStart !== null ? [0] : days.map((_, i) => i).filter((i) => i <= end);
    for (const start of starts) {
      if (start > end || sum(start, end) !== amountCents) continue;
      return {
        start: fixedStart ?? (days[start] as { date: string }).date,
        end: (days[end] as { date: string }).date,
        sumCents: amountCents,
        exact: true,
      };
    }
  }

  const start = fixedStart ?? days[0]?.date ?? addDays(settlementDate, -31);
  const clampedStart = start <= lastDay ? start : lastDay;
  return {
    start: clampedStart,
    end: lastDay,
    sumCents: days.length === 0 ? 0 : sum(0, days.length - 1),
    exact: false,
  };
}
