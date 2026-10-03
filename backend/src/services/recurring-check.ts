import { addDays, addMonths, daysBetween } from '../lib/date.js';
import type { Period } from './coverage.js';
import { lastPriceChange, type PriceChange } from './funding-analysis.js';
import type { Interval } from './recurring-debits.js';
import { DUE_TOLERANCE_DAYS } from './recurring-detection.js';

/**
 * Soll/Ist-Abgleich einer Fixkostenposition bzw. eines Abos (CLAUDE.md
 * § 14) – reine Funktion. Aus Termin und Intervall entstehen die
 * erwarteten Abbuchungen; jede wird mit der nächstgelegenen zugeordneten
 * Buchung (Toleranz je Intervall) abgeglichen: passt, Betrag weicht ab,
 * fehlt – oder liegt in einer Importlücke und ist damit unbekannt.
 */

/** So viele erwartete Termine werden ohne passende Buchung höchstens rückwirkend geprüft. */
export const LOOKBACK_WITHOUT_BOOKINGS = 3;
/** So viele Termine zeigt der Abgleich (neueste zuerst). */
export const OCCURRENCES_SHOWN = 12;
/** Kündigungstermin „bald“: innerhalb von 60 Tagen. */
export const CANCEL_SOON_DAYS = 60;

export type NoticeUnit = 'days' | 'weeks' | 'months';

export interface CheckItem {
  /** Soll-Betrag der Abbuchung, positiv. */
  amountCents: number;
  interval: Interval;
  nextDueDate: string | null;
  contractEndDate: string | null;
  noticePeriodValue: number | null;
  noticePeriodUnit: NoticeUnit | null;
  active: boolean;
}

export interface CheckBooking {
  transactionId: number;
  date: string;
  /** Abgebuchter Betrag, positiv. */
  amountCents: number;
}

export interface CheckContext {
  /** Letzter importierter Tag der betroffenen Konten; null = nichts importiert. */
  dataEnd: string | null;
  /** Von Importen abgedeckte Zeiträume. */
  covered: Period[];
  today: string;
}

/** ok = passt, differs = Betrag weicht ab, missing = fehlt, not_imported = Termin liegt in einer Importlücke. */
export type OccurrenceState = 'ok' | 'differs' | 'missing' | 'not_imported';

export interface Occurrence {
  dueDate: string;
  state: OccurrenceState;
  transactionId: number | null;
  date: string | null;
  amountCents: number | null;
}

/**
 * ok = letzte Abbuchung passt; differs = Betrag weicht vom Soll ab;
 * missing = die letzte erwartete Abbuchung fehlt; ended = mindestens zwei
 * erwartete Abbuchungen in Folge fehlen (beendet?); no_bookings = keine
 * einzige passende Buchung (Konto nicht importiert oder andere
 * Schreibweise?); not_due = noch nichts fällig; inactive = vom Menschen beendet.
 */
export type CheckStatus = 'ok' | 'differs' | 'missing' | 'ended' | 'no_bookings' | 'not_due' | 'inactive';

export interface CancelInfo {
  contractEndDate: string;
  /** Letzter Tag, an dem die Kündigung eingehen muss. */
  cancelBy: string;
  /** open = noch Zeit; soon = innerhalb von 60 Tagen; passed = Frist verstrichen; expired = Vertragsende überschritten. */
  state: 'open' | 'soon' | 'passed' | 'expired';
}

export interface ItemCheck {
  status: CheckStatus;
  /** Neueste zuerst, höchstens `OCCURRENCES_SHOWN`. */
  occurrences: Occurrence[];
  missingCount: number;
  /** Zugeordnete Buchungen, die zu keinem Termin passen (Nachzahlung, Sonderbuchung). */
  extraBookings: CheckBooking[];
  lastBooking: CheckBooking | null;
  /** Letzte Betragsänderung in den Buchungen (alter Betrag mindestens zweimal). */
  priceChange: PriceChange | null;
  /** Die letzten beiden Abbuchungen sind gleich, aber nicht das Soll → Soll anpassen? */
  suggestedAmountCents: number | null;
  /** Nächster Termin ab heute laut Plan. */
  nextDueDate: string | null;
  /** Der eingetragene Termin passt nicht zu den Buchungen; gerechnet wird mit dem Termin der letzten Buchung. */
  scheduleFromBookings: boolean;
  cancel: CancelInfo | null;
}

const MONTHS: Record<Interval, number> = { biweekly: 0, monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };

/** k-ter Termin relativ zu `anchor` (k darf negativ sein); Monatsende wird begrenzt, ohne Drift. */
export function dueAt(anchor: string, interval: Interval, k: number): string {
  return interval === 'biweekly' ? addDays(anchor, 14 * k) : addMonths(anchor, MONTHS[interval] * k);
}

/** Alle Termine im Bereich [from, to]. */
export function dueDatesBetween(anchor: string, interval: Interval, from: string, to: string): string[] {
  if (from > to) return [];
  const approxDays = interval === 'biweekly' ? 14 : MONTHS[interval] * 30.44;
  let k = Math.floor(daysBetween(anchor, from) / approxDays) - 1;
  while (dueAt(anchor, interval, k) >= from) k -= 1;
  const dates: string[] = [];
  for (let d = dueAt(anchor, interval, k); d <= to; d = dueAt(anchor, interval, ++k)) {
    if (d >= from) dates.push(d);
  }
  return dates;
}

/** Abstand eines Datums zum nächstgelegenen Termin des Plans, in Tagen. */
export function distanceToSchedule(anchor: string, interval: Interval, date: string): number {
  const tolerance = DUE_TOLERANCE_DAYS[interval];
  const span = interval === 'biweekly' ? 14 : MONTHS[interval] * 31;
  const dates = dueDatesBetween(anchor, interval, addDays(date, -span - tolerance), addDays(date, span + tolerance));
  return Math.min(...dates.map((d) => Math.abs(daysBetween(d, date))), Number.MAX_SAFE_INTEGER);
}

function isCovered(covered: Period[], date: string): boolean {
  return covered.some((p) => p.start <= date && date <= p.end);
}

/** Kündigungstermin zum Vertragsende. */
export function cancelInfo(item: CheckItem, today: string): CancelInfo | null {
  if (!item.contractEndDate) return null;
  const end = item.contractEndDate;
  const value = item.noticePeriodValue ?? 0;
  const cancelBy =
    item.noticePeriodUnit === 'months'
      ? addMonths(end, -value)
      : item.noticePeriodUnit === 'weeks'
        ? addDays(end, -7 * value)
        : addDays(end, -value);
  const state = today > end ? 'expired' : today > cancelBy ? 'passed' : daysBetween(today, cancelBy) <= CANCEL_SOON_DAYS ? 'soon' : 'open';
  return { contractEndDate: end, cancelBy, state };
}

export function checkItem(item: CheckItem, bookings: CheckBooking[], ctx: CheckContext): ItemCheck {
  const sorted = [...bookings].sort((a, b) => a.date.localeCompare(b.date) || a.transactionId - b.transactionId);
  const tolerance = DUE_TOLERANCE_DAYS[item.interval];
  const last = sorted[sorted.length - 1] ?? null;

  // Plan: eingetragener Termin; passt die letzte Buchung nicht dazu, der Termin der letzten Buchung.
  let anchor = item.nextDueDate ?? (last ? last.date : null);
  let scheduleFromBookings = false;
  if (anchor && last && distanceToSchedule(anchor, item.interval, last.date) > tolerance) {
    anchor = last.date;
    scheduleFromBookings = true;
  }

  const occurrences: Occurrence[] = [];
  const extraBookings: CheckBooking[] = [];
  if (anchor && ctx.dataEnd) {
    const first = sorted[0];
    const lookback = dueAt(ctx.dataEnd, item.interval, -LOOKBACK_WITHOUT_BOOKINGS);
    const coverStart = ctx.covered[0]?.start ?? ctx.dataEnd;
    const from = first ? addDays(first.date, -tolerance) : lookback > coverStart ? lookback : coverStart;
    // Erst fällig, wenn die Toleranz bis zum Ende der Importe verstrichen ist.
    const to = addDays(ctx.dataEnd, -tolerance);
    const used = new Set<number>();
    for (const due of dueDatesBetween(anchor, item.interval, from, to)) {
      let best: CheckBooking | null = null;
      for (const b of sorted) {
        if (used.has(b.transactionId)) continue;
        const distance = Math.abs(daysBetween(due, b.date));
        if (distance > tolerance) continue;
        if (!best || distance < Math.abs(daysBetween(due, best.date))) best = b;
      }
      if (best) {
        used.add(best.transactionId);
        occurrences.push({
          dueDate: due,
          state: best.amountCents === item.amountCents ? 'ok' : 'differs',
          transactionId: best.transactionId,
          date: best.date,
          amountCents: best.amountCents,
        });
      } else {
        occurrences.push({
          dueDate: due,
          state: isCovered(ctx.covered, due) ? 'missing' : 'not_imported',
          transactionId: null,
          date: null,
          amountCents: null,
        });
      }
    }
    // Buchungen zu Terminen, deren Toleranz noch läuft, zählen schon mit.
    const pending = dueDatesBetween(anchor, item.interval, addDays(to, 1), addDays(ctx.dataEnd, tolerance));
    for (const b of sorted) {
      if (used.has(b.transactionId)) continue;
      const due = pending.find((d) => Math.abs(daysBetween(d, b.date)) <= tolerance && !occurrences.some((o) => o.dueDate === d));
      if (due) {
        used.add(b.transactionId);
        occurrences.push({
          dueDate: due,
          state: b.amountCents === item.amountCents ? 'ok' : 'differs',
          transactionId: b.transactionId,
          date: b.date,
          amountCents: b.amountCents,
        });
      } else {
        extraBookings.push(b);
      }
    }
  } else {
    extraBookings.push(...sorted);
  }
  occurrences.sort((a, b) => b.dueDate.localeCompare(a.dueDate));

  let trailingMissing = 0;
  for (const o of occurrences) {
    if (o.state !== 'missing') break;
    trailingMissing += 1;
  }
  const latestBooked = occurrences.find((o) => o.transactionId !== null);
  let status: CheckStatus;
  if (!item.active) status = 'inactive';
  else if (sorted.length === 0) status = occurrences.some((o) => o.state === 'missing') ? 'no_bookings' : 'not_due';
  else if (trailingMissing >= 2) status = 'ended';
  else if (trailingMissing === 1) status = 'missing';
  else if (latestBooked?.state === 'differs') status = 'differs';
  else status = 'ok';

  const lastTwo = sorted.slice(-2);
  const suggestedAmountCents =
    lastTwo.length === 2 && lastTwo[0]?.amountCents === lastTwo[1]?.amountCents && lastTwo[1]?.amountCents !== item.amountCents
      ? (lastTwo[1]?.amountCents ?? null)
      : null;

  let nextDueDate: string | null = null;
  if (anchor) {
    const upcoming = dueDatesBetween(anchor, item.interval, ctx.today, dueAt(ctx.today, item.interval, 2));
    nextDueDate = upcoming[0] ?? null;
  }

  return {
    status,
    occurrences: occurrences.slice(0, OCCURRENCES_SHOWN),
    missingCount: occurrences.filter((o) => o.state === 'missing').length,
    extraBookings,
    lastBooking: last,
    priceChange: lastPriceChange(sorted.map((b) => ({ date: b.date, amountCents: -b.amountCents }))),
    suggestedAmountCents,
    nextDueDate,
    scheduleFromBookings,
    cancel: cancelInfo(item, ctx.today),
  };
}
