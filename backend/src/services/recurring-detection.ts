import { daysBetween } from '../lib/date.js';
import { lastPriceChange, type PriceChange } from './funding-analysis.js';
import { INTERVAL_DAYS, monthlyEquivalent, nextDue, type Interval } from './recurring-debits.js';

/**
 * Automatische Erkennung von Fixkosten und Abos (CLAUDE.md § 14) – reine
 * Funktion, ohne Datenbank testbar. Ergebnis sind **Vorschläge**; nichts
 * wird hier übernommen.
 *
 * Verfahren je Vertrag (Schlüssel aus lib/recurring-key.ts): Abbuchungen
 * werden je Intervall (14-tägig, monatlich, quartalsweise, halbjährlich,
 * jährlich – in dieser Reihenfolge) zu Ketten verbunden. Ein Glied folgt
 * dem vorigen im Abstand des Intervalls (mit Toleranz für Wochenenden und
 * Feiertage) oder im doppelten Abstand (eine Abbuchung fehlt), und sein
 * Betrag liegt zwischen der Hälfte und dem Doppelten der bisherigen Kette
 * (Strom mit Nachzahlung, Telefon mit Verbrauch). So bleiben einmalige
 * Käufe beim selben Händler außen vor, und zwei Abos beim selben Anbieter
 * werden zwei Ketten. Was je Vertrag übrig bleibt, wird ein zweites Mal je
 * Anbieter gruppiert (wechselnde Mandatsreferenzen).
 */

/** Toleranz beim Termin je Intervall, in Tagen. */
export const DUE_TOLERANCE_DAYS: Record<Interval, number> = {
  biweekly: 4,
  monthly: 7,
  quarterly: 14,
  semiannual: 21,
  annual: 31,
};

export const INTERVAL_ORDER: Interval[] = ['biweekly', 'monthly', 'quarterly', 'semiannual', 'annual'];

/** Nominaler Abstand in Tagen (für die Wahl des besten Kettenglieds). */
const NOMINAL_DAYS: Record<Interval, number> = { biweekly: 14, monthly: 30, quarterly: 91, semiannual: 182, annual: 365 };

/** Hinweis auf einen Jahresbeitrag – eine einzelne Abbuchung damit wird als jährlich vermutet. */
const ANNUAL_HINT =
  /jahres(?:beitrag|abo|abonnement|geb(?:ü|ue|\.)hr|rechnung|pr(?:ä|ae|\.)mie|mitgliedschaft)|j(?:ä|ae|\.)hrlich|\bp\.\s?a\.|\b(?:annual|yearly)\b|beitrag\s+20\d\d(?![/\d])/i;

export interface DetectDebit {
  transactionId: number;
  accountId: number;
  date: string;
  /** Abbuchung (< 0). */
  amountCents: number;
  contractKey: string;
  providerKey: string;
  label: string;
  /** Vorgangsart und Verwendungszweck (Hinweis auf Jahresbeitrag). */
  text: string;
  /** Kartenumsatz bzw. über einen Zahlungsdienst – Hinweis auf ein Abo. */
  viaCardOrIntermediary: boolean;
  categoryId: number | null;
}

export interface DetectedSeries {
  /** Erkennungsschlüssel, stabil über erneute Erkennungen. */
  key: string;
  providerKey: string;
  /** Konto der letzten Abbuchung. */
  accountId: number;
  label: string;
  interval: Interval;
  count: number;
  firstDate: string;
  lastDate: string;
  /** Betrag der letzten Abbuchung, positiv. */
  lastAmountCents: number;
  monthlyCents: number;
  nextDueDate: string;
  /** Nur vermutet: einzelner Jahresbeitrag ohne mehrjährige Daten. */
  suspected: boolean;
  /** Länger als ein Intervall (plus Toleranz) keine Abbuchung mehr. */
  ended: boolean;
  priceChange: PriceChange | null;
  kind: 'fixed_cost' | 'subscription';
  categoryId: number | null;
  transactionIds: number[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

const byDate = (a: DetectDebit, b: DetectDebit) => a.date.localeCompare(b.date) || a.transactionId - b.transactionId;

/** Betragstoleranz bei Händlern mit vielen weiteren Buchungen: 2 %, mindestens 0,50 €. */
const STEADY_PERCENT = 2;
const STEADY_MIN_CENTS = 50;

/**
 * Zufallskette bei einem Händler, bei dem häufig eingekauft wird
 * (Supermarkt)? Liegen im Zeitraum der Kette mehr weitere Abbuchungen beim
 * selben Händler als die Kette selbst hat, zählt die Kette nur mit
 * mindestens drei Gliedern und nahezu gleichen Beträgen (Amazon Prime
 * zwischen Einkäufen bei Amazon).
 */
function isNoise(chain: DetectDebit[], list: DetectDebit[]): boolean {
  const first = (chain[0] as DetectDebit).date;
  const last = (chain[chain.length - 1] as DetectDebit).date;
  const ids = new Set(chain.map((d) => d.transactionId));
  const others = list.filter((d) => !ids.has(d.transactionId) && d.date >= first && d.date <= last).length;
  if (others <= chain.length - 1) return false;
  if (chain.length < 3) return true;
  const mid = median(chain.map((d) => -d.amountCents));
  const tolerance = Math.max(STEADY_MIN_CENTS, Math.round((mid * STEADY_PERCENT) / 100));
  return chain.some((d) => Math.abs(-d.amountCents - mid) > tolerance);
}

/**
 * Verbindet Abbuchungen (nach Datum sortiert) zu Ketten eines Intervalls.
 * Eine Kette braucht mindestens so viele Glieder wie das Intervall verlangt
 * (14-tägig 4, monatlich 3, sonst 2), mindestens einen einfachen Abstand,
 * höchstens eine fehlende Abbuchung je sechs Glieder und darf keine
 * Zufallskette sein (`isNoise`).
 */
export function buildChains(list: DetectDebit[], interval: Interval): DetectDebit[][] {
  const range = INTERVAL_DAYS[interval];
  const used = new Set<number>();
  const chains: DetectDebit[][] = [];
  for (let i = 0; i < list.length; i++) {
    const start = list[i] as DetectDebit;
    if (used.has(start.transactionId)) continue;
    const chain = [start];
    const indices = [i];
    let doubled = 0;
    for (;;) {
      const lastIndex = indices[indices.length - 1] as number;
      const last = list[lastIndex] as DetectDebit;
      const reference = median(chain.map((d) => -d.amountCents));
      let best: { index: number; score: [number, number, number]; doubled: boolean } | null = null;
      for (let j = lastIndex + 1; j < list.length; j++) {
        const c = list[j] as DetectDebit;
        if (used.has(c.transactionId)) continue;
        const gap = daysBetween(last.date, c.date);
        if (gap > 2 * range.max) break;
        const single = gap >= range.min && gap <= range.max;
        const twice = gap >= 2 * range.min && gap <= 2 * range.max;
        if (!single && !twice) continue;
        const amount = -c.amountCents;
        if (amount * 2 < reference || amount > reference * 2) continue;
        const score: [number, number, number] = [
          single ? 0 : 1,
          Math.abs(amount + last.amountCents),
          Math.abs(gap - NOMINAL_DAYS[interval] * (single ? 1 : 2)),
        ];
        const better =
          !best ||
          score[0] < best.score[0] ||
          (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])));
        if (better) best = { index: j, score, doubled: !single };
      }
      if (!best) break;
      chain.push(list[best.index] as DetectDebit);
      indices.push(best.index);
      if (best.doubled) doubled += 1;
    }
    const singles = chain.length - 1 - doubled;
    if (chain.length >= range.minCount && singles >= 1 && doubled <= Math.max(1, Math.floor(chain.length / 6)) && !isNoise(chain, list)) {
      for (const d of chain) used.add(d.transactionId);
      chains.push(chain);
    }
  }
  return chains;
}

/** Häufigster Tag im Monat einer Kette (für den Schlüssel doppelter Abos). */
function typicalDay(chain: DetectDebit[]): number {
  const counts = new Map<number, number>();
  for (const d of chain) {
    const day = Number(d.date.slice(8, 10));
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 1;
}

function toSeries(
  key: string,
  chain: DetectDebit[],
  interval: Interval,
  suspected: boolean,
  dataEnd: ReadonlyMap<number, string>,
): DetectedSeries {
  const first = chain[0] as DetectDebit;
  const last = chain[chain.length - 1] as DetectDebit;
  const due = nextDue(last.date, interval);
  const end = dataEnd.get(last.accountId);
  return {
    key,
    providerKey: last.providerKey,
    accountId: last.accountId,
    label: last.label,
    interval,
    count: chain.length,
    firstDate: first.date,
    lastDate: last.date,
    lastAmountCents: -last.amountCents,
    monthlyCents: monthlyEquivalent(-last.amountCents, interval),
    nextDueDate: due,
    suspected,
    ended: end !== undefined && daysBetween(due, end) > DUE_TOLERANCE_DAYS[interval],
    priceChange: lastPriceChange(chain.map((d) => ({ date: d.date, amountCents: d.amountCents }))),
    kind: chain.some((d) => d.viaCardOrIntermediary) ? 'subscription' : 'fixed_cost',
    categoryId: last.categoryId,
    transactionIds: chain.map((d) => d.transactionId),
  };
}

function groupBy(list: DetectDebit[], key: (d: DetectDebit) => string): Map<string, DetectDebit[]> {
  const groups = new Map<string, DetectDebit[]>();
  for (const d of list) {
    const k = key(d);
    const g = groups.get(k);
    if (g) g.push(d);
    else groups.set(k, [d]);
  }
  return groups;
}

type Found = { chain: DetectDebit[]; interval: Interval }[];

/** Ketten in der gegebenen Reihenfolge der Intervalle; liefert auch den Rest. */
function chainsInOrder(group: DetectDebit[], order: Interval[]): { found: Found; remaining: DetectDebit[] } {
  let remaining = [...group].sort(byDate);
  const found: Found = [];
  for (const interval of order) {
    const chains = buildChains(remaining, interval);
    if (chains.length === 0) continue;
    const taken = new Set(chains.flatMap((c) => c.map((d) => d.transactionId)));
    remaining = remaining.filter((d) => !taken.has(d.transactionId));
    for (const chain of chains) found.push({ chain, interval });
  }
  return { found, remaining };
}

/**
 * Ketten aller Intervalle einer Gruppe; Rest bleibt in `rest`. 14-tägig
 * und zwei monatliche Abos am 8. und 22. sehen sich ähnlich – beide
 * Lesarten werden versucht, gewählt wird die, die mehr Abbuchungen mit
 * weniger Reihen erklärt.
 */
function chainsOf(group: DetectDebit[], rest: DetectDebit[]): Found {
  const monthlyFirst: Interval[] = ['monthly', 'biweekly', 'quarterly', 'semiannual', 'annual'];
  const candidates = [chainsInOrder(group, INTERVAL_ORDER), chainsInOrder(group, monthlyFirst)];
  const best = candidates.sort(
    (a, b) => a.remaining.length - b.remaining.length || a.found.length - b.found.length,
  )[0] as { found: Found; remaining: DetectDebit[] };
  rest.push(...best.remaining);
  return best.found;
}

/**
 * Erkennt wiederkehrende Abbuchungen. `dataEnd` = letzter importierter Tag
 * je Konto (für „beendet“). Umbuchungen gehören nicht in `debits` –
 * sie sind weder Fixkosten noch Abo.
 */
export function detectRecurring(debits: DetectDebit[], dataEnd: ReadonlyMap<number, string>): DetectedSeries[] {
  const result: DetectedSeries[] = [];
  const add = (baseKey: string, found: Found) => {
    // Mehrere Ketten unter einem Schlüssel (doppelte Abos): die längste
    // behält den Schlüssel, die übrigen bekommen den Tag im Monat dazu.
    const sorted = [...found].sort((a, b) => b.chain.length - a.chain.length || byDate(a.chain[0] as DetectDebit, b.chain[0] as DetectDebit));
    sorted.forEach(({ chain, interval }, i) => {
      result.push(toSeries(i === 0 ? baseKey : `${baseKey}@d${typicalDay(chain)}`, chain, interval, false, dataEnd));
    });
  };

  const negative = debits.filter((d) => d.amountCents < 0);
  const leftover: DetectDebit[] = [];
  for (const [key, group] of groupBy(negative, (d) => d.contractKey)) add(key, chainsOf(group, leftover));

  // Zweiter Durchgang je Anbieter (z. B. wechselnde Mandatsreferenzen),
  // nur mit den Abbuchungen, die keinem Vertrag zugeordnet wurden.
  const single: DetectDebit[] = [];
  const known = new Set(result.map((s) => s.key));
  for (const [key, group] of groupBy(leftover, (d) => d.providerKey)) {
    const found = chainsOf(group, single);
    if (found.length > 0) add(known.has(key) ? `${key}|p` : key, found);
  }

  // Einzelne Jahresbeiträge: als jährlich vermutet, solange der nächste Termin noch nicht verstrichen ist.
  for (const d of single) {
    if (!ANNUAL_HINT.test(d.text)) continue;
    const series = toSeries(d.contractKey, [d], 'annual', true, dataEnd);
    if (series.ended || result.some((s) => s.key === series.key)) continue;
    result.push(series);
  }

  return result.sort((a, b) => Number(a.ended) - Number(b.ended) || b.monthlyCents - a.monthlyCents || a.label.localeCompare(b.label));
}

/**
 * Intervall einer Reihe von Abbuchungen nach dem mittleren Abstand (für
 * einen abgeteilten Vertrag, CLAUDE.md § 19); `null`, wenn keins passt.
 */
export function guessInterval(debits: { date: string }[]): Interval | null {
  const dates = debits.map((d) => d.date).sort();
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1] as string, dates[i] as string));
  if (gaps.length === 0) return null;
  const mid = median(gaps);
  return INTERVAL_ORDER.find((interval) => mid >= INTERVAL_DAYS[interval].min && mid <= INTERVAL_DAYS[interval].max) ?? null;
}
