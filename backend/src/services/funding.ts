import type { Db } from '../db/connection.js';
import { monthBounds } from '../lib/date.js';
import { AppError } from '../lib/errors.js';
import { baseItemKey, itemLabel } from '../lib/item-key.js';
import { balanceOn, currentBalance, listManualBalances, loadBalanceData, type ManualBalance } from './balances.js';
import { plannedMovesFor, type PlannedIncrease } from './bypass.js';
import { getCoverage } from './coverage.js';
import {
  assessBalance,
  fundingCauses,
  fundingMonths,
  fundingRecommendation,
  fundingTrend,
  type BalanceAssessment,
  type FundingCauses,
  type FundingMonth,
  type FundingRecommendation,
  type FundingTransaction,
  type FundingTrend,
} from './funding-analysis.js';
import { detectStandingOrders, endedSince, type IncomingTransfer, type StandingOrder } from './standing-orders.js';

/**
 * Deckungsprüfung (CLAUDE.md § 12): Reicht der Dauerauftrag für das, was
 * tatsächlich vom Konto abgebucht wird? Gilt für jedes Konto, nicht nur
 * für ein bestimmtes – die Oberfläche bietet die Konten mit Rolle
 * `ausgaben` an (laut § 5 „per Dauerauftrag gespeist“).
 */

export interface StandingOrderView extends StandingOrder {
  sourceAccountName: string | null;
  /** Monat der ersten ausgebliebenen Ausführung, wenn beendet. */
  endedSince: string | null;
}

export interface FundingAnalysis {
  accountId: number;
  accountName: string;
  role: string;
  /** Letzter importierter Tag. */
  dataEnd: string | null;
  standingOrders: StandingOrderView[];
  /** Summe der laufenden Daueraufträge je Monat. */
  standingOrdersTotalCents: number;
  /** Umbuchungen aufs Konto, die keinem Dauerauftrag zugeordnet sind. */
  extraTransferCount: number;
  months: FundingMonth[];
  trend: FundingTrend;
  recommendation: FundingRecommendation | null;
  causes: FundingCauses | null;
  balance: BalanceAssessment;
  /** Die Bank liefert Salden je Buchung; sonst braucht es einen Kontostand von Hand. */
  hasBankBalances: boolean;
  manualBalances: ManualBalance[];
  /** Posten, die laut § 13 auf dieses Konto umziehen sollen. */
  plannedMoves: PlannedIncrease | null;
}

interface TxRow {
  id: number;
  booking_date: string;
  amount_cents: number;
  transfer_id: number | null;
  counterparty: string;
  counterparty_normalized: string;
  purpose: string;
  creditor_id: string | null;
  mandate_reference: string | null;
}

export function getFunding(db: Db, accountId: number, today: string): FundingAnalysis {
  const account = db.prepare('SELECT id, name, role FROM accounts WHERE id = ?').get(accountId) as
    | { id: number; name: string; role: string }
    | undefined;
  if (!account) throw new AppError(`Konto ${accountId} existiert nicht.`, 404);
  const names = new Map((db.prepare('SELECT id, name FROM accounts').all() as { id: number; name: string }[]).map((a) => [a.id, a.name]));

  const rows = db
    .prepare(
      `SELECT id, booking_date, amount_cents, transfer_id, counterparty, counterparty_normalized, purpose,
              creditor_id, mandate_reference
         FROM transactions WHERE account_id = ? ORDER BY booking_date, id`,
    )
    .all(accountId) as TxRow[];

  const coverage = getCoverage(db, accountId, today);
  const lastPeriodEnd = coverage.periods[coverage.periods.length - 1]?.end ?? null;
  const lastBooking = rows[rows.length - 1]?.booking_date ?? null;
  const dataEnd = [lastPeriodEnd, lastBooking].filter((d): d is string => d !== null).sort().pop() ?? null;

  // 1. Daueraufträge unter den Umbuchungen aufs Konto.
  const incoming = (
    db
      .prepare(
        `SELECT t.id, t.booking_date, t.amount_cents, tr.from_account_id,
                (SELECT group_concat(o.booking_text || ' ' || o.purpose, ' ') FROM transactions o
                  WHERE o.transfer_id = t.transfer_id) AS text
           FROM transactions t JOIN transfers tr ON tr.id = t.transfer_id
          WHERE t.account_id = ? AND t.amount_cents > 0`,
      )
      .all(accountId) as { id: number; booking_date: string; amount_cents: number; from_account_id: number | null; text: string | null }[]
  ).map(
    (r): IncomingTransfer => ({
      transactionId: r.id,
      date: r.booking_date,
      amountCents: r.amount_cents,
      sourceAccountId: r.from_account_id === accountId ? null : r.from_account_id,
      text: r.text ?? '',
    }),
  );
  const detected = detectStandingOrders(incoming, dataEnd ?? today);
  const standingOrderTxIds = new Set(detected.orders.flatMap((o) => o.occurrences.map((x) => x.transactionId)));

  // 2.–3. Monatszeilen mit Saldo am Monatsende.
  const transactions = rows.map(
    (r): FundingTransaction => ({
      id: r.id,
      date: r.booking_date,
      amountCents: r.amount_cents,
      isTransfer: r.transfer_id !== null,
      key: baseItemKey({
        counterparty: r.counterparty,
        counterpartyNormalized: r.counterparty_normalized,
        purpose: r.purpose,
        creditorId: r.creditor_id,
        mandateReference: r.mandate_reference,
      }),
      label: itemLabel(r),
    }),
  );
  const balanceData = loadBalanceData(db, accountId);
  const months = fundingMonths(
    coverage.months.map((m) => {
      const end = monthBounds(m.month).last;
      const at = m.status === 'missing' ? null : balanceOn(balanceData, dataEnd !== null && end > dataEnd ? dataEnd : end);
      return { month: m.month, status: m.status, balanceEndCents: at?.balanceCents ?? null };
    }),
    transactions,
    standingOrderTxIds,
  );

  // 4.–7. Verlauf, Saldo, Empfehlung, Ursachen.
  const trend = fundingTrend(months);
  const current = currentBalance(balanceData);
  const standingOrdersTotalCents = detected.orders.filter((o) => o.active).reduce((s, o) => s + o.amountCents, 0);
  const plannedMoves = plannedMovesFor(db, accountId);

  return {
    accountId,
    accountName: account.name,
    role: account.role,
    dataEnd,
    standingOrders: detected.orders.map((o) => ({
      ...o,
      sourceAccountName: o.sourceAccountId === null ? null : (names.get(o.sourceAccountId) ?? null),
      endedSince: endedSince(o),
    })),
    standingOrdersTotalCents,
    extraTransferCount: detected.extraTransactionIds.length,
    months,
    trend,
    recommendation: fundingRecommendation(months, transactions, standingOrdersTotalCents, plannedMoves?.monthlyCents ?? 0),
    causes: fundingCauses(months, transactions),
    balance: assessBalance(
      months,
      trend,
      current ? { balanceCents: current.balanceCents, date: current.date, source: current.source } : null,
    ),
    hasBankBalances: balanceData.hasBankBalances,
    manualBalances: listManualBalances(db, accountId),
    plannedMoves,
  };
}
