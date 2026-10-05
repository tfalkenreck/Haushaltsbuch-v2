import type { Db } from '../db/connection.js';
import { baseItemKey, itemLabel } from '../lib/item-key.js';
import { coveredPeriods } from './coverage.js';
import type { Interval } from './recurring-debits.js';
import { detectRecurring, type DetectDebit } from './recurring-detection.js';

/**
 * Wiederkehrende Eingänge (Gehalt, Kindergeld, Rente …) – Grundlage des
 * Nettoeinkommens im Budget 50/30/20 und der Einnahmen in der Prognose
 * (CLAUDE.md § 15). Nicht alle Gutschriften: Erstattungen und einmalige
 * Eingänge verzerren das Einkommen. Umbuchungen zählen nie.
 *
 * Verfahren wie bei Fixkosten und Abos (services/recurring-detection.ts):
 * Gutschriften derselben Gegenpartei werden je Intervall zu Ketten
 * verbunden (monatlich ab drei Eingängen, Betrag zwischen Hälfte und
 * Doppeltem). Nichts davon wird gespeichert; die Erkennung läuft bei jeder
 * Anzeige.
 */

export interface IncomeSource {
  key: string;
  label: string;
  accountId: number;
  accountName: string;
  interval: Interval;
  count: number;
  firstDate: string;
  lastDate: string;
  /** Letzter Eingang, positiv. */
  lastAmountCents: number;
  /** Auf einen Monat umgerechnet. */
  monthlyCents: number;
  nextDueDate: string;
  /** Länger als ein Intervall (plus Toleranz) kein Eingang mehr. */
  ended: boolean;
  transactionIds: number[];
}

export interface IncomeDetection {
  sources: IncomeSource[];
  /** Buchungen, die zu einem wiederkehrenden Eingang gehören. */
  transactionIds: Set<number>;
}

interface CreditRow {
  id: number;
  account_id: number;
  booking_date: string;
  amount_cents: number;
  counterparty: string;
  counterparty_normalized: string;
  purpose: string;
  creditor_id: string | null;
  category_id: number | null;
}

/** Letzter importierter Tag je Konto: Ende des letzten Importzeitraums oder letzte Buchung. */
export function dataEndByAccount(db: Db): Map<number, string> {
  const result = new Map<number, string>();
  const lastBooking = new Map(
    (db.prepare('SELECT account_id, max(booking_date) AS d FROM transactions GROUP BY account_id').all() as { account_id: number; d: string }[]).map(
      (r) => [r.account_id, r.d],
    ),
  );
  for (const { id } of db.prepare('SELECT id FROM accounts').all() as { id: number }[]) {
    const periods = coveredPeriods(db, id);
    const end = [periods[periods.length - 1]?.end, lastBooking.get(id)].filter((d): d is string => d !== undefined).sort().pop();
    if (end !== undefined) result.set(id, end);
  }
  return result;
}

/** Quelle ohne die Liste ihrer Buchungen (für die Antwort). */
export function withoutIds(s: IncomeSource): Omit<IncomeSource, 'transactionIds'> {
  const { transactionIds, ...rest } = s;
  void transactionIds;
  return rest;
}

export function detectIncome(db: Db): IncomeDetection {
  const rows = db
    .prepare(
      `SELECT id, account_id, booking_date, amount_cents, counterparty, counterparty_normalized, purpose, creditor_id, category_id
         FROM transactions WHERE amount_cents > 0 AND transfer_id IS NULL ORDER BY booking_date, id`,
    )
    .all() as CreditRow[];
  const names = new Map((db.prepare('SELECT id, name FROM accounts').all() as { id: number; name: string }[]).map((a) => [a.id, a.name]));

  // Die Erkennung arbeitet mit Abbuchungen (< 0); Gutschriften gehen mit umgekehrtem Vorzeichen hinein.
  const detected = detectRecurring(
    rows.map((r): DetectDebit => {
      const key = baseItemKey({
        counterparty: r.counterparty,
        counterpartyNormalized: r.counterparty_normalized,
        purpose: r.purpose,
        creditorId: r.creditor_id,
        mandateReference: null,
      });
      return {
        transactionId: r.id,
        accountId: r.account_id,
        date: r.booking_date,
        amountCents: -r.amount_cents,
        contractKey: key,
        providerKey: key,
        label: itemLabel(r),
        text: '',
        viaCardOrIntermediary: false,
        categoryId: r.category_id,
      };
    }),
    dataEndByAccount(db),
  ).filter((s) => !s.suspected);

  const sources = detected
    .map(
      (s): IncomeSource => ({
        key: s.key,
        label: s.label,
        accountId: s.accountId,
        accountName: names.get(s.accountId) ?? '',
        interval: s.interval,
        count: s.count,
        firstDate: s.firstDate,
        lastDate: s.lastDate,
        lastAmountCents: s.lastAmountCents,
        monthlyCents: s.monthlyCents,
        nextDueDate: s.nextDueDate,
        ended: s.ended,
        transactionIds: s.transactionIds,
      }),
    )
    .sort((a, b) => Number(a.ended) - Number(b.ended) || b.monthlyCents - a.monthlyCents || a.label.localeCompare(b.label));
  return { sources, transactionIds: new Set(sources.flatMap((s) => s.transactionIds)) };
}
