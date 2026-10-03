import type { Db } from '../db/connection.js';
import { addDays } from '../lib/date.js';
import { AppError } from '../lib/errors.js';
import { baseItemKey, baseOf, contractKey, itemLabel } from '../lib/item-key.js';
import { nowIso } from '../lib/time.js';
import { coveredPeriods } from './coverage.js';
import { detectRecurringDebits, type Debit, type Interval } from './recurring-debits.js';

/**
 * Ausgaben am Ausgabenkonto vorbei (CLAUDE.md § 13): wiederkehrende
 * Abbuchungen, die noch direkt vom Einnahmenkonto laufen. Pro Posten
 * entscheidet der Mensch: „soll umgestellt werden“ oder „bleibt bewusst
 * hier“. Für umzustellende Posten wird ausgerechnet, um wie viel der
 * Dauerauftrag steigen müsste. Ist der Posten inzwischen auf dem
 * Ausgabenkonto angekommen, gilt er als umgestellt und zählt nicht doppelt.
 *
 * Quelle sind Konten mit Rolle `einnahmen`, Ziel Konten mit Rolle
 * `ausgaben` – nie über Namen oder Bank.
 */

export type BypassDecision = 'move' | 'keep';
/** active = läuft noch übers Einnahmenkonto; switched = jetzt auf dem Ausgabenkonto; ended = bleibt aus. */
export type BypassStatus = 'active' | 'switched' | 'ended';

export interface BypassItem {
  key: string;
  sourceAccountId: number;
  sourceAccountName: string;
  label: string;
  categoryPath: string | null;
  interval: Interval;
  count: number;
  firstDate: string;
  lastDate: string;
  lastAmountCents: number;
  monthlyCents: number;
  nextDueDate: string;
  status: BypassStatus;
  /** Erste Abbuchung auf dem Ausgabenkonto nach dem Wechsel. */
  switchedTo: { accountId: number; accountName: string; date: string } | null;
  decision: BypassDecision | null;
  targetAccountId: number | null;
  targetAccountName: string | null;
}

export interface PlannedIncrease {
  accountId: number;
  accountName: string;
  /** Anzahl umzustellender Posten. */
  count: number;
  /** Um so viel müsste der Dauerauftrag je Monat steigen. */
  monthlyCents: number;
}

export interface BypassOverview {
  items: BypassItem[];
  /** Konten mit Rolle `ausgaben` – mögliche Ziele. */
  targets: { id: number; name: string }[];
  plannedIncreases: PlannedIncrease[];
  /** Umzustellende Posten ohne festgelegtes Ziel (bei mehreren Ausgabenkonten). */
  unassignedMoves: number;
}

/** Bargeld ist kein Posten fürs Ausgabenkonto. */
const CASH = /bargeld|geldautomat|auszahlung|\batm\b/i;

/** Wie lange eine Abbuchung nach ihrem Termin ausbleiben darf, bevor sie als beendet bzw. umgestellt gilt. */
const OVERDUE_DAYS: Record<Interval, number> = { biweekly: 5, monthly: 7, quarterly: 14, semiannual: 21, annual: 31 };

interface DebitRow {
  id: number;
  account_id: number;
  date: string;
  amount_cents: number;
  counterparty: string;
  counterparty_normalized: string;
  purpose: string;
  booking_text: string;
  creditor_id: string | null;
  mandate_reference: string | null;
  category_path: string | null;
}

function loadDebits(db: Db, accountIds: number[]): DebitRow[] {
  if (accountIds.length === 0) return [];
  return db
    .prepare(
      `SELECT t.id, t.account_id, t.booking_date AS date, t.amount_cents, t.counterparty, t.counterparty_normalized,
              t.purpose, t.booking_text, t.creditor_id, t.mandate_reference,
              CASE WHEN p.id IS NULL THEN c.name ELSE p.name || ' › ' || c.name END AS category_path
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
        WHERE t.account_id IN (${accountIds.map(() => '?').join(', ')})
          AND t.amount_cents < 0 AND t.transfer_id IS NULL
        ORDER BY t.booking_date, t.id`,
    )
    .all(...accountIds) as DebitRow[];
}

const keyed = (r: DebitRow) => ({
  counterparty: r.counterparty,
  counterpartyNormalized: r.counterparty_normalized,
  purpose: r.purpose,
  creditorId: r.creditor_id,
  mandateReference: r.mandate_reference,
});

/** Letzter importierter Tag eines Kontos. */
function dataEnd(db: Db, accountId: number): string | null {
  const periods = coveredPeriods(db, accountId);
  const last = (db.prepare('SELECT max(booking_date) AS d FROM transactions WHERE account_id = ?').get(accountId) as { d: string | null }).d;
  const periodEnd = periods[periods.length - 1]?.end ?? null;
  return [last, periodEnd].filter((d): d is string => d !== null).sort().pop() ?? null;
}

interface DecisionRow {
  source_account_id: number;
  item_key: string;
  decision: BypassDecision;
  target_account_id: number | null;
}

export function listBypass(db: Db): BypassOverview {
  const accounts = db.prepare('SELECT id, name, role, active FROM accounts').all() as {
    id: number;
    name: string;
    role: string;
    active: number;
  }[];
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const sources = accounts.filter((a) => a.role === 'einnahmen' && a.active === 1).map((a) => a.id);
  const targets = accounts.filter((a) => a.role === 'ausgaben');
  const activeTargets = targets.filter((a) => a.active === 1);
  const singleTarget = activeTargets.length === 1 ? (activeTargets[0] as { id: number }).id : null;

  const sourceDebits = loadDebits(db, sources).filter((r) => !CASH.test(`${r.booking_text} ${r.purpose}`));
  const byId = new Map(sourceDebits.map((r) => [r.id, r]));
  const recurring = detectRecurringDebits(
    sourceDebits.map(
      (r): Debit => ({
        transactionId: r.id,
        accountId: r.account_id,
        date: r.date,
        amountCents: r.amount_cents,
        key: contractKey(keyed(r)),
        label: itemLabel(r),
      }),
    ),
  );

  // Posten auf den Ausgabenkonten: Basis-Schlüssel → Abbuchungen.
  const onTargets = new Map<string, DebitRow[]>();
  for (const r of loadDebits(
    db,
    targets.map((t) => t.id),
  )) {
    const key = baseItemKey(keyed(r));
    const list = onTargets.get(key);
    if (list) list.push(r);
    else onTargets.set(key, [r]);
  }

  const decisions = new Map(
    (db.prepare('SELECT source_account_id, item_key, decision, target_account_id FROM bypass_decisions').all() as DecisionRow[]).map(
      (d) => [`${d.source_account_id}\u0000${d.item_key}`, d],
    ),
  );
  const ends = new Map(sources.map((id) => [id, dataEnd(db, id)]));

  const items = recurring.map((r): BypassItem => {
    const latest = byId.get(r.transactionIds[r.transactionIds.length - 1] as number) as DebitRow;
    const end = ends.get(r.accountId) ?? null;
    const overdue = end !== null && addDays(r.nextDueDate, OVERDUE_DAYS[r.interval]) < end;
    const later = (onTargets.get(baseOf(r.key)) ?? []).find((t) => t.date > r.lastDate);
    const status: BypassStatus = overdue ? (later ? 'switched' : 'ended') : 'active';
    const decision = decisions.get(`${r.accountId}\u0000${r.key}`);
    const targetId = decision?.target_account_id ?? (decision?.decision === 'move' ? singleTarget : null);
    return {
      key: r.key,
      sourceAccountId: r.accountId,
      sourceAccountName: names.get(r.accountId) ?? '',
      label: r.label,
      categoryPath: latest.category_path,
      interval: r.interval,
      count: r.count,
      firstDate: r.firstDate,
      lastDate: r.lastDate,
      lastAmountCents: r.lastAmountCents,
      monthlyCents: r.monthlyCents,
      nextDueDate: r.nextDueDate,
      status,
      switchedTo:
        status === 'switched' && later
          ? { accountId: later.account_id, accountName: names.get(later.account_id) ?? '', date: later.date }
          : null,
      decision: decision?.decision ?? null,
      targetAccountId: decision?.decision === 'move' ? targetId : null,
      targetAccountName: decision?.decision === 'move' && targetId !== null ? (names.get(targetId) ?? null) : null,
    };
  });

  const plannedIncreases: PlannedIncrease[] = [];
  let unassignedMoves = 0;
  for (const item of items) {
    if (item.decision !== 'move' || item.status !== 'active') continue;
    if (item.targetAccountId === null) {
      unassignedMoves += 1;
      continue;
    }
    let entry = plannedIncreases.find((p) => p.accountId === item.targetAccountId);
    if (!entry) {
      entry = { accountId: item.targetAccountId, accountName: item.targetAccountName ?? '', count: 0, monthlyCents: 0 };
      plannedIncreases.push(entry);
    }
    entry.count += 1;
    entry.monthlyCents += item.monthlyCents;
  }

  return {
    items,
    targets: activeTargets.map((t) => ({ id: t.id, name: t.name })),
    plannedIncreases,
    unassignedMoves,
  };
}

/** Umzustellende Posten für ein Ausgabenkonto (fließen in die Empfehlung, § 12.6). */
export function plannedMovesFor(db: Db, accountId: number): PlannedIncrease | null {
  return listBypass(db).plannedIncreases.find((p) => p.accountId === accountId) ?? null;
}

export interface BypassDecisionInput {
  sourceAccountId: number;
  key: string;
  /** null = Entscheidung zurücknehmen. */
  decision: BypassDecision | null;
  targetAccountId?: number | null | undefined;
}

/** „Soll umgestellt werden“ / „bleibt bewusst hier“ festhalten oder zurücknehmen. */
export function setBypassDecision(db: Db, input: BypassDecisionInput): void {
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(input.sourceAccountId)) throw new AppError(`Konto ${input.sourceAccountId} existiert nicht.`, 404);
  if (input.key.trim() === '') throw new AppError('Der Posten fehlt.');
  if (input.decision === null) {
    db.prepare('DELETE FROM bypass_decisions WHERE source_account_id = ? AND item_key = ?').run(input.sourceAccountId, input.key);
    return;
  }
  const targetId = input.decision === 'move' ? (input.targetAccountId ?? null) : null;
  if (targetId !== null) {
    if (targetId === input.sourceAccountId) throw new AppError('Ziel und Herkunft sind dasselbe Konto.');
    if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(targetId)) throw new AppError(`Konto ${targetId} existiert nicht.`, 404);
  }
  const now = nowIso();
  db.prepare(
    `INSERT INTO bypass_decisions (source_account_id, item_key, decision, target_account_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_account_id, item_key)
     DO UPDATE SET decision = excluded.decision, target_account_id = excluded.target_account_id, updated_at = excluded.updated_at`,
  ).run(input.sourceAccountId, input.key, input.decision, targetId, now, now);
}
