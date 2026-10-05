import { addDays, addMonths, daysBetween, parseGermanDate } from '../lib/date.js';
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
  id?: number;
  /** Kaufdatum. */
  bookingDate: string;
  /** Buchungstag der Bank; fehlt beim Altbestand (dann gilt das Kaufdatum). */
  bankBookingDate?: string | null;
  /** Valuta; fehlt sie, gilt der Buchungstag der Bank. */
  valueDate?: string | null;
  amountCents: number;
}

/** Datum, nach dem Kartenumsätze einer Abrechnung zugeordnet werden. */
export type CardDateField = 'booking_date' | 'bank_booking_date' | 'value_date';

/**
 * Zuordnungsregel einer Kreditkarte (CLAUDE.md § 19): nach welchem Datum
 * ein Kartenumsatz zu einer Abrechnung gehört, und ob ein Umsatz am
 * Abrechnungsdatum (Stichtag) noch dazuzählt (`inclusive`) oder schon zur
 * nächsten (`exclusive`).
 */
export interface CardRule {
  date: CardDateField;
  cutoff: 'inclusive' | 'exclusive';
}

/** Alle geprüften Regeln; die erste ist das bisherige Verfahren und gewinnt bei Gleichstand. */
export const CARD_RULES: readonly CardRule[] = [
  { date: 'bank_booking_date', cutoff: 'inclusive' },
  { date: 'bank_booking_date', cutoff: 'exclusive' },
  { date: 'booking_date', cutoff: 'inclusive' },
  { date: 'booking_date', cutoff: 'exclusive' },
  { date: 'value_date', cutoff: 'inclusive' },
  { date: 'value_date', cutoff: 'exclusive' },
];

export const DEFAULT_CARD_RULE: CardRule = CARD_RULES[0] as CardRule;

/** Datum eines Kartenumsatzes nach der Regel; fehlende Angaben fallen auf Buchungstag bzw. Kaufdatum zurück. */
export function purchaseDate(p: CardPurchase, field: CardDateField): string {
  if (field === 'booking_date') return p.bookingDate;
  if (field === 'value_date') return p.valueDate ?? p.bankBookingDate ?? p.bookingDate;
  return p.bankBookingDate ?? p.bookingDate;
}

/**
 * Abrechnungsdatum aus dem Text des Ausgleichs bzw. der Abbuchung:
 * „Abrechnung vom 18.09.2026“ → `2026-09-18`. `null`, wenn keins genannt ist.
 */
export function statementDateIn(text: string): string | null {
  const match = /abrechnung\s+vom\s+(\d{2}\.\d{2}\.\d{4})/i.exec(text);
  return match?.[1] ? parseGermanDate(match[1]) : null;
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

/**
 * Abrechnungszeitraum bei bekanntem Abrechnungsdatum (Erkenntnis aus dem
 * ersten Echtdaten-Test, CLAUDE.md § 19): Die Bank rechnet nicht nach dem
 * Kaufdatum ab, sondern nach einem eigenen Datum bis zum Stichtag. Welches
 * Datum und ob der Stichtag dazugehört, legt die Regel der Karte fest
 * (`calibrateCardRule`); ohne Regel gilt das bisherige Verfahren: Buchungstag
 * der Bank bis einschließlich Abrechnungsdatum – ein Kauf am 17.09.,
 * gebucht am 19.09., gehört zur Abrechnung nach dem 18.09.
 *
 * Beginn ist `fixedStart` (Tag nach dem Ende der vorigen Abrechnung
 * derselben Karte), solange er im Suchfenster liegt. Sonst der früheste
 * Tag, ab dem die Summe genau passt, ersatzweise der Tag nach demselben
 * Stichtag im Vormonat.
 */
export function findStatementPeriod(
  purchases: CardPurchase[],
  amountCents: number,
  statementDate: string,
  fixedStart: string | null,
  rule: CardRule = DEFAULT_CARD_RULE,
): CardPeriod {
  const dateOf = (p: CardPurchase) => purchaseDate(p, rule.date);
  const end = rule.cutoff === 'inclusive' ? statementDate : addDays(statementDate, -1);
  const earliest = addDays(statementDate, -CARD_LOOKBACK_DAYS);
  const inWindow = purchases.filter((p) => dateOf(p) >= earliest && dateOf(p) <= end);
  const sumFrom = (start: string) => inWindow.filter((p) => dateOf(p) >= start).reduce((sum, p) => sum - p.amountCents, 0);
  const period = (start: string): CardPeriod => {
    const sumCents = sumFrom(start);
    return { start, end, sumCents, exact: sumCents === amountCents };
  };

  if (fixedStart !== null && fixedStart >= earliest && fixedStart <= end) return period(fixedStart);

  const days = [...new Set(inWindow.map(dateOf))].sort();
  for (const day of days) {
    if (sumFrom(day) === amountCents) return period(day);
  }
  const monthBefore = addMonths(statementDate, -1);
  return period(rule.cutoff === 'inclusive' ? addDays(monthBefore, 1) : monthBefore);
}

/** Kartenabrechnung mit Abrechnungsdatum aus dem Text („Abrechnung vom …“). */
export interface Statement {
  id: number;
  statementDate: string;
  /** Abgerechneter Betrag, positiv. */
  amountCents: number;
}

export interface StatementPeriod extends CardPeriod {
  id: number;
  /** Beginnt am Tag nach der vorigen Abrechnung – nur solche sind für die Kalibrierung aussagekräftig. */
  chained: boolean;
}

/**
 * Zeiträume aller Abrechnungen einer Karte nach einer Regel, in zeitlicher
 * Reihenfolge: jede beginnt am Tag nach dem Ende der vorigen, wenn diese
 * höchstens `CARD_LOOKBACK_DAYS` zurückliegt.
 */
export function statementPeriods(statements: Statement[], purchases: CardPurchase[], rule: CardRule): StatementPeriod[] {
  const sorted = [...statements].sort((a, b) => a.statementDate.localeCompare(b.statementDate) || a.id - b.id);
  const result: StatementPeriod[] = [];
  let previous: { statementDate: string; end: string } | null = null;
  for (const s of sorted) {
    const fixedStart =
      previous !== null && daysBetween(previous.statementDate, s.statementDate) <= CARD_LOOKBACK_DAYS ? addDays(previous.end, 1) : null;
    const period = findStatementPeriod(purchases, s.amountCents, s.statementDate, fixedStart, rule);
    result.push({ ...period, id: s.id, chained: fixedStart !== null && fixedStart === period.start });
    previous = { statementDate: s.statementDate, end: period.end };
  }
  return result;
}

export interface CardRuleResult {
  rule: CardRule;
  /** Prüfbare Abrechnungen, deren Summe genau aufgeht. */
  exact: number;
  /** Summe der Beträge, um die die prüfbaren Abrechnungen abweichen. */
  deviationCents: number;
}

export interface CardCalibration {
  rule: CardRule;
  /** Prüfbare Abrechnungen: Zeitraum schließt an die vorige an und enthält Kartenumsätze. */
  checked: number;
  /** Ergebnis jeder geprüften Regel, beste zuerst. */
  results: CardRuleResult[];
  /** Zeiträume nach der gewählten Regel. */
  periods: StatementPeriod[];
}

/**
 * Kalibriert die Zuordnungsregel einer Karte (CLAUDE.md § 19): jede Regel
 * aus `CARD_RULES` wird über alle Abrechnungen mit Abrechnungsdatum
 * gerechnet; gewählt wird die, bei der die meisten Abrechnungen exakt
 * aufgehen, bei Gleichstand die mit der kleinsten Gesamtabweichung, dann
 * die frühere in der Liste. Bewertet werden nur Abrechnungen, die an die
 * vorige anschließen (sonst ist der Beginn gesucht und passt immer) und in
 * deren Zeitraum nach irgendeiner Regel Kartenumsätze liegen (sonst ist
 * der Kartenimport noch nicht so weit).
 */
export function calibrateCardRule(statements: Statement[], purchases: CardPurchase[]): CardCalibration {
  const byRule = CARD_RULES.map((rule) => ({ rule, periods: statementPeriods(statements, purchases, rule) }));
  const amounts = new Map(statements.map((s) => [s.id, s.amountCents]));
  const checkable = new Set(
    statements
      .map((s) => s.id)
      .filter((id) => byRule.every((r) => r.periods.find((p) => p.id === id)?.chained) && byRule.some((r) => r.periods.find((p) => p.id === id)?.sumCents !== 0)),
  );
  const scored = byRule.map(({ rule, periods }, order) => {
    const relevant = periods.filter((p) => checkable.has(p.id));
    return {
      order,
      periods,
      result: {
        rule,
        exact: relevant.filter((p) => p.exact).length,
        deviationCents: relevant.reduce((sum, p) => sum + Math.abs((amounts.get(p.id) ?? 0) - p.sumCents), 0),
      },
    };
  });
  scored.sort((a, b) => b.result.exact - a.result.exact || a.result.deviationCents - b.result.deviationCents || a.order - b.order);
  const best = scored[0] as (typeof scored)[number];
  return { rule: best.result.rule, checked: checkable.size, results: scored.map((s) => s.result), periods: best.periods };
}

/** So viele Tage vor und nach einer Grenze zeigt die Prüfung die Kartenumsätze. */
export const BOUNDARY_DAYS = 5;

export interface BoundaryPurchase {
  id: number;
  /** Datum nach der Regel der Karte. */
  date: string;
  amountCents: number;
  /** Liegt im Zeitraum dieser Abrechnung. */
  inPeriod: boolean;
  /**
   * Läge der Umsatz auf der anderen Seite der Grenze, ginge die Abrechnung
   * auf: außerhalb mit Betrag = Abweichung, innerhalb mit Betrag = −Abweichung.
   */
  explains: boolean;
}

/**
 * Kartenumsätze ±`BOUNDARY_DAYS` Tage um eine Grenze des Zeitraums (erster
 * Tag `start` bzw. letzter Tag `end`), für eine Abrechnung, die nicht
 * aufgeht. `differenceCents` = abgerechnet minus Summe im Zeitraum.
 */
export function boundaryPurchases(
  purchases: (CardPurchase & { id: number })[],
  period: { start: string; end: string },
  side: 'start' | 'end',
  field: CardDateField,
  differenceCents: number,
): BoundaryPurchase[] {
  // Grenze zwischen dem letzten Tag davor und dem ersten danach.
  const firstAfter = side === 'start' ? period.start : addDays(period.end, 1);
  const from = addDays(firstAfter, -BOUNDARY_DAYS);
  const to = addDays(firstAfter, BOUNDARY_DAYS - 1);
  return purchases
    .map((p) => ({ p, date: purchaseDate(p, field) }))
    .filter(({ date }) => date >= from && date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.p.id - b.p.id)
    .map(({ p, date }) => {
      const inPeriod = date >= period.start && date <= period.end;
      const charge = -p.amountCents;
      return { id: p.id, date, amountCents: p.amountCents, inPeriod, explains: charge !== 0 && (inPeriod ? charge === -differenceCents : charge === differenceCents) };
    });
}
