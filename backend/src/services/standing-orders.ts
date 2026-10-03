import { addDays, addMonths, daysBetween, daysInMonth, shiftMonth } from '../lib/date.js';

/**
 * Daueraufträge auf ein per Dauerauftrag gespeistes Konto erkennen
 * (CLAUDE.md § 12.1) – reine Funktion, ohne Datenbank testbar.
 *
 * Grundlage sind die Umbuchungen auf das Konto. Es können mehrere
 * Daueraufträge sein, auch mehrere am selben Tag mit gleichem Betrag
 * (z. B. am 11.: 10 €, 60 €, 10 €, 100 €). Jeder wird einzeln verfolgt –
 * mit Termin, aktuellem Betrag und Betragsänderungen über die Zeit.
 */

/** Toleranz beim Termin: Wochenende plus Feiertag, Ausführung am nächsten Bankarbeitstag. */
export const STANDING_ORDER_DAY_TOLERANCE = 4;

export interface IncomingTransfer {
  transactionId: number;
  /** Buchungsdatum auf dem gespeisten Konto. */
  date: string;
  /** Gutgeschriebener Betrag (> 0). */
  amountCents: number;
  /** Konto, von dem die Umbuchung kommt (NULL = nicht angelegt / unbekannt). */
  sourceAccountId: number | null;
  /** Vorgangsart und Verwendungszweck beider Seiten – „Dauerauftrag“ ist ein Hinweis. */
  text: string;
}

export interface StandingOrderOccurrence {
  transactionId: number;
  date: string;
  amountCents: number;
  /** Monat, für den die Ausführung gilt (ein Termin am 30., ausgeführt am 01., zählt zum Vormonat). */
  month: string;
}

export interface AmountChange {
  /** Erste Ausführung mit dem neuen Betrag. */
  date: string;
  fromCents: number;
  toCents: number;
}

export interface StandingOrder {
  sourceAccountId: number | null;
  /** Üblicher Ausführungstag im Monat. */
  dayOfMonth: number;
  firstDate: string;
  lastDate: string;
  /** Betrag der letzten Ausführung. */
  amountCents: number;
  /** Läuft noch: die nächste Ausführung ist im importierten Zeitraum noch nicht fällig gewesen. */
  active: boolean;
  /** Nur einmal gesehen, aber als „Dauerauftrag“ bezeichnet. */
  suspected: boolean;
  occurrences: StandingOrderOccurrence[];
  changes: AmountChange[];
}

export interface StandingOrderAnalysis {
  /** Nach Termin und Betrag sortiert, laufende zuerst. */
  orders: StandingOrder[];
  /** Umbuchungen aufs Konto, die zu keinem Dauerauftrag gehören (Sonderüberweisungen). */
  extraTransactionIds: number[];
}

interface Series {
  sourceAccountId: number | null;
  days: number[];
  lastMonth: string;
  occurrences: StandingOrderOccurrence[];
  hinted: boolean;
}

const HINT = /dauerauftrag/i;

/** Häufigster Tag, bei Gleichstand der früheste (Banken verschieben nach hinten). */
function typicalDay(days: number[]): number {
  const counts = new Map<number, number>();
  for (const d of days) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 1;
}

/** Fälligkeitstag eines Dauerauftrags mit Termin `day` im Monat `month` (aufs Monatsende begrenzt). */
export function dueDate(month: string, day: number): string {
  const max = daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)));
  return `${month}-${String(Math.min(day, max)).padStart(2, '0')}`;
}

/**
 * Erkennt die Daueraufträge unter den Umbuchungen auf ein Konto.
 *
 * Verfahren: Umbuchungen in zeitlicher Reihenfolge, je Buchungstag
 * gemeinsam zugeordnet. Eine Umbuchung setzt eine Reihe fort, wenn sie vom
 * selben Konto kommt und höchstens `STANDING_ORDER_DAY_TOLERANCE` Tage vom
 * Termin des Folgemonats (oder des übernächsten, falls eine Ausführung
 * fehlt) entfernt liegt. Gleicher Betrag hat Vorrang, sonst der nächste
 * Betrag (= Betragsänderung). Eine Reihe mit mindestens zwei Ausführungen
 * ist ein Dauerauftrag; eine einzelne nur, wenn sie „Dauerauftrag“ heißt
 * (vermutet). Alles Übrige sind Sonderüberweisungen.
 *
 * `dataEnd` = letzter importierter Tag des Kontos: ist die nächste
 * Ausführung bis dahin überfällig, gilt der Dauerauftrag als beendet.
 */
export function detectStandingOrders(transfers: IncomingTransfer[], dataEnd: string): StandingOrderAnalysis {
  const sorted = [...transfers]
    .filter((t) => t.amountCents > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.transactionId - b.transactionId);
  const series: Series[] = [];

  let i = 0;
  while (i < sorted.length) {
    const date = (sorted[i] as IncomingTransfer).date;
    const batch: IncomingTransfer[] = [];
    while (i < sorted.length && (sorted[i] as IncomingTransfer).date === date) batch.push(sorted[i++] as IncomingTransfer);

    const options: { t: IncomingTransfer; s: Series; month: string; exact: boolean; diff: number; days: number }[] = [];
    for (const t of batch) {
      for (const s of series) {
        if (s.sourceAccountId !== t.sourceAccountId) continue;
        const day = typicalDay(s.days);
        for (const k of [1, 2]) {
          const month = shiftMonth(s.lastMonth, k);
          const days = Math.abs(daysBetween(dueDate(month, day), t.date));
          if (days > STANDING_ORDER_DAY_TOLERANCE) continue;
          const last = s.occurrences[s.occurrences.length - 1] as StandingOrderOccurrence;
          const diff = Math.abs(last.amountCents - t.amountCents);
          options.push({ t, s, month, exact: diff === 0, diff, days: days + (k - 1) * 31 });
        }
      }
    }
    options.sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        a.diff - b.diff ||
        a.days - b.days ||
        a.t.transactionId - b.t.transactionId,
    );
    const usedT = new Set<number>();
    const usedS = new Set<Series>();
    for (const o of options) {
      if (usedT.has(o.t.transactionId) || usedS.has(o.s)) continue;
      usedT.add(o.t.transactionId);
      usedS.add(o.s);
      o.s.occurrences.push({ transactionId: o.t.transactionId, date: o.t.date, amountCents: o.t.amountCents, month: o.month });
      if (o.month === o.t.date.slice(0, 7)) o.s.days.push(Number(o.t.date.slice(8, 10)));
      o.s.lastMonth = o.month;
      o.s.hinted ||= HINT.test(o.t.text);
    }
    for (const t of batch) {
      if (usedT.has(t.transactionId)) continue;
      series.push({
        sourceAccountId: t.sourceAccountId,
        days: [Number(t.date.slice(8, 10))],
        lastMonth: t.date.slice(0, 7),
        occurrences: [{ transactionId: t.transactionId, date: t.date, amountCents: t.amountCents, month: t.date.slice(0, 7) }],
        hinted: HINT.test(t.text),
      });
    }
  }

  const orders: StandingOrder[] = [];
  const extraTransactionIds: number[] = [];
  for (const s of series) {
    if (s.occurrences.length < 2 && !s.hinted) {
      extraTransactionIds.push(...s.occurrences.map((o) => o.transactionId));
      continue;
    }
    const first = s.occurrences[0] as StandingOrderOccurrence;
    const last = s.occurrences[s.occurrences.length - 1] as StandingOrderOccurrence;
    const day = typicalDay(s.days);
    const changes: AmountChange[] = [];
    for (let k = 1; k < s.occurrences.length; k++) {
      const prev = s.occurrences[k - 1] as StandingOrderOccurrence;
      const cur = s.occurrences[k] as StandingOrderOccurrence;
      if (cur.amountCents !== prev.amountCents) changes.push({ date: cur.date, fromCents: prev.amountCents, toCents: cur.amountCents });
    }
    const nextDue = dueDate(shiftMonth(s.lastMonth, 1), day);
    orders.push({
      sourceAccountId: s.sourceAccountId,
      dayOfMonth: day,
      firstDate: first.date,
      lastDate: last.date,
      amountCents: last.amountCents,
      active: addDays(nextDue, STANDING_ORDER_DAY_TOLERANCE) >= dataEnd,
      suspected: s.occurrences.length < 2,
      occurrences: s.occurrences,
      changes,
    });
  }
  orders.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      a.dayOfMonth - b.dayOfMonth ||
      b.amountCents - a.amountCents ||
      a.firstDate.localeCompare(b.firstDate),
  );
  return { orders, extraTransactionIds: extraTransactionIds.sort((a, b) => a - b) };
}

/** Monat, ab dem ein Dauerauftrag als beendet gilt (erste ausgebliebene Ausführung). */
export function endedSince(order: StandingOrder): string | null {
  if (order.active) return null;
  const last = order.occurrences[order.occurrences.length - 1] as StandingOrderOccurrence;
  return addMonths(dueDate(last.month, order.dayOfMonth), 1).slice(0, 7);
}
