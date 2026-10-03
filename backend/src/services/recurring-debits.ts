import { addDays, addMonths, daysBetween } from '../lib/date.js';

/**
 * Wiederkehrende Abbuchungen erkennen – reine Funktion. Grundlage für
 * „Ausgaben am Ausgabenkonto vorbei“ (CLAUDE.md § 13): Kandidaten mit
 * Betrag, Intervall und Gegenpartei. Bewusst schlicht; die vollständige
 * Abo-Erkennung (§ 14) folgt in Phase 6.
 */

export type Interval = 'biweekly' | 'monthly' | 'quarterly' | 'semiannual' | 'annual';

/** Abstand zweier Abbuchungen in Tagen je Intervall (Toleranz für Wochenenden und Feiertage). */
export const INTERVAL_DAYS: Record<Interval, { min: number; max: number; minCount: number }> = {
  biweekly: { min: 12, max: 16, minCount: 4 },
  monthly: { min: 26, max: 35, minCount: 3 },
  quarterly: { min: 84, max: 98, minCount: 2 },
  semiannual: { min: 175, max: 190, minCount: 2 },
  annual: { min: 350, max: 380, minCount: 2 },
};

/** Nächster Termin nach `date` im gegebenen Intervall. */
export function nextDue(date: string, interval: Interval): string {
  switch (interval) {
    case 'biweekly':
      return addDays(date, 14);
    case 'monthly':
      return addMonths(date, 1);
    case 'quarterly':
      return addMonths(date, 3);
    case 'semiannual':
      return addMonths(date, 6);
    case 'annual':
      return addMonths(date, 12);
  }
}

export interface Debit {
  transactionId: number;
  accountId: number;
  date: string;
  /** Abbuchung (< 0). */
  amountCents: number;
  /** Vertragsschlüssel (siehe lib/item-key.ts). */
  key: string;
  label: string;
}

export interface RecurringDebit {
  key: string;
  accountId: number;
  label: string;
  interval: Interval;
  count: number;
  firstDate: string;
  lastDate: string;
  /** Betrag der letzten Abbuchung, positiv. */
  lastAmountCents: number;
  /** Auf einen Monat umgerechnet, positiv. */
  monthlyCents: number;
  /** Nächster erwarteter Termin. */
  nextDueDate: string;
  transactionIds: number[];
}

/** Betrag je Monat bei gegebenem Intervall, auf Cent gerundet. */
export function monthlyEquivalent(amountCents: number, interval: Interval): number {
  switch (interval) {
    case 'biweekly':
      return Math.round((amountCents * 26) / 12);
    case 'monthly':
      return amountCents;
    case 'quarterly':
      return Math.round(amountCents / 3);
    case 'semiannual':
      return Math.round(amountCents / 6);
    case 'annual':
      return Math.round(amountCents / 12);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/**
 * Intervall einer Reihe von Abbuchungsdaten: der mittlere Abstand legt es
 * fest; jeder Abstand muss passen, wobei eine ausgelassene Abbuchung
 * (doppelter Abstand) erlaubt ist. Zu wenige Abbuchungen → `null`.
 */
export function detectInterval(dates: string[]): Interval | null {
  if (dates.length < 2) return null;
  const sorted = [...dates].sort();
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i - 1] as string, sorted[i] as string));
  const mid = median(gaps);
  const entry = (Object.entries(INTERVAL_DAYS) as [Interval, (typeof INTERVAL_DAYS)[Interval]][]).find(
    ([, r]) => mid >= r.min && mid <= r.max,
  );
  if (!entry) return null;
  const [interval, range] = entry;
  if (sorted.length < range.minCount) return null;
  const fits = (gap: number) => (gap >= range.min && gap <= range.max) || (gap >= 2 * range.min && gap <= 2 * range.max);
  return gaps.every(fits) ? interval : null;
}

/**
 * Wiederkehrende Abbuchungen je Konto und Vertragsschlüssel. Beim Betrag
 * großzügig (Strom mit Nachzahlung, Telefon mit Verbrauch): jede Abbuchung
 * darf bis zur Hälfte vom mittleren Betrag abweichen, eine Ausreißerin ist
 * erlaubt.
 */
export function detectRecurringDebits(debits: Debit[]): RecurringDebit[] {
  const groups = new Map<string, Debit[]>();
  for (const d of debits) {
    if (d.amountCents >= 0) continue;
    const key = `${d.accountId}\u0000${d.key}`;
    const list = groups.get(key);
    if (list) list.push(d);
    else groups.set(key, [d]);
  }

  const result: RecurringDebit[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.transactionId - b.transactionId);
    const interval = detectInterval(list.map((d) => d.date));
    if (interval === null) continue;
    const amounts = list.map((d) => -d.amountCents);
    const mid = median(amounts);
    const outliers = amounts.filter((a) => a * 2 < mid || a * 2 > mid * 3).length;
    if (outliers > 1) continue;

    const first = list[0] as Debit;
    const last = list[list.length - 1] as Debit;
    result.push({
      key: last.key,
      accountId: last.accountId,
      label: last.label,
      interval,
      count: list.length,
      firstDate: first.date,
      lastDate: last.date,
      lastAmountCents: -last.amountCents,
      monthlyCents: monthlyEquivalent(-last.amountCents, interval),
      nextDueDate: nextDue(last.date, interval),
      transactionIds: list.map((d) => d.transactionId),
    });
  }
  return result.sort((a, b) => b.monthlyCents - a.monthlyCents || a.label.localeCompare(b.label));
}
