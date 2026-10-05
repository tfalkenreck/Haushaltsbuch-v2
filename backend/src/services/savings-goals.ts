import type { Db } from '../db/connection.js';
import { isValidIsoDate, monthOf } from '../lib/date.js';
import { AppError } from '../lib/errors.js';
import { parseGermanAmount } from '../lib/money.js';
import { nowIso } from '../lib/time.js';
import { currentBalance, loadBalanceData } from './balances.js';
import { getForecast } from './forecast.js';
import { allocateBalances, planGoals, type GoalPlan, type PlanGoal } from './savings-plan.js';

/**
 * Sparziele (CLAUDE.md § 15): Betrag, Wunschdatum, Priorität. Der aktuelle
 * Stand ergibt sich aus dem Guthaben des zugeordneten Kontos (in der Regel
 * das Sparkonto), nicht aus Handpflege. Die nötige Monatsrate steht dem
 * prognostizierten Überschuss gegenüber (services/forecast.ts); die
 * Rückkopplung zeigt, um wie viele Monate ein Ziel früher erreicht wäre,
 * wenn ausgewählte Abos wegfielen.
 */

export interface SavingsGoalInput {
  name: string;
  /** Deutscher Betrag, z. B. „5.000“. */
  amount: string;
  targetDate?: string | null | undefined;
  priority?: number | undefined;
  /** Konto, dessen Guthaben den Stand bestimmt; weggelassen = das einzige aktive Sparkonto. */
  accountId?: number | null | undefined;
  active?: boolean | undefined;
}

export interface SavingsGoal {
  id: number;
  name: string;
  targetCents: number;
  targetDate: string | null;
  priority: number;
  accountId: number | null;
  accountName: string | null;
  active: boolean;
  /** Kontostand des zugeordneten Kontos unbekannt – Stand zählt als 0. */
  balanceUnknown: boolean;
  plan: GoalPlan | null;
  /** Derselbe Plan ohne die ausgewählten Abos; null = keine ausgewählt oder Ziel inaktiv. */
  withoutSelected: (GoalPlan & { monthsEarlier: number | null }) | null;
}

export interface SavingsOverview {
  currentMonth: string;
  /** Prognostizierter Überschuss je Monat (Durchschnitt der Prognose). */
  surplusCents: number;
  forecastMonths: number;
  /** Nötige Monatsraten aller offenen Ziele mit Wunschdatum zusammen. */
  neededTotalCents: number;
  goals: SavingsGoal[];
  accounts: { accountId: number; accountName: string; balanceCents: number | null; balanceDate: string | null; allocatedCents: number }[];
  /** Abos aus der Prognose, deren Wegfall durchgerechnet werden kann. */
  subscriptions: { id: number; name: string; monthlyCents: number; selected: boolean }[];
  /** Mehr Überschuss je Monat ohne die ausgewählten Abos. */
  selectedMonthlyCents: number;
}

interface GoalRow {
  id: number;
  name: string;
  target_cents: number;
  target_date: string | null;
  priority: number;
  account_id: number | null;
  account_name: string | null;
  active: number;
}

function loadGoals(db: Db): GoalRow[] {
  return db
    .prepare(
      `SELECT g.*, a.name AS account_name FROM savings_goals g LEFT JOIN accounts a ON a.id = g.account_id
        ORDER BY g.active DESC, g.priority, g.id`,
    )
    .all() as GoalRow[];
}

/**
 * Übersicht mit Plan. `without` = IDs von Fixkosten/Abos, deren Wegfall
 * durchgerechnet wird; weggelassen = alle Abos der Prognose.
 */
export function getSavingsOverview(db: Db, today: string, without?: number[]): SavingsOverview {
  const current = monthOf(today);
  const forecast = getForecast(db, today);
  const horizon = forecast.months.length;
  const surplus = forecast.averageSurplusCents;

  const subscriptionItems = forecast.fixedItems.filter((i) => i.kind === 'subscription');
  const selectedIds = new Set(without ?? subscriptionItems.map((i) => i.id));
  // Monatswert eines Postens = seine Abbuchungen in der Prognose ÷ Prognosemonate (Jahresabos anteilig).
  const monthlyOf = (total: number) => Math.round(-total / horizon);
  const selectedMonthly = forecast.fixedItems.filter((i) => selectedIds.has(i.id)).reduce((s, i) => s + monthlyOf(i.totalCents), 0);

  const rows = loadGoals(db);
  const accountIds = [...new Set(rows.map((r) => r.account_id).filter((id): id is number => id !== null))];
  const balances = new Map<number, { balanceCents: number; date: string }>();
  for (const id of accountIds) {
    const b = currentBalance(loadBalanceData(db, id));
    if (b) balances.set(id, { balanceCents: b.balanceCents, date: b.date });
  }

  const active = rows.filter((r) => r.active === 1);
  const planInput: PlanGoal[] = active.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    targetCents: r.target_cents,
    targetMonth: r.target_date === null ? null : monthOf(r.target_date),
  }));
  const allocated = allocateBalances(planInput, new Map([...balances].map(([id, b]) => [id, b.balanceCents])));
  const plans = new Map(planGoals(planInput, allocated, surplus, current).map((p) => [p.id, p]));
  const alternative =
    selectedMonthly > 0 ? new Map(planGoals(planInput, allocated, surplus + selectedMonthly, current).map((p) => [p.id, p])) : null;

  const goals: SavingsGoal[] = rows.map((r) => {
    const plan = plans.get(r.id) ?? null;
    const alt = alternative?.get(r.id) ?? null;
    return {
      id: r.id,
      name: r.name,
      targetCents: r.target_cents,
      targetDate: r.target_date,
      priority: r.priority,
      accountId: r.account_id,
      accountName: r.account_name,
      active: r.active === 1,
      balanceUnknown: r.account_id !== null && !balances.has(r.account_id),
      plan,
      withoutSelected:
        plan && alt
          ? {
              ...alt,
              monthsEarlier: plan.monthsToReach !== null && alt.monthsToReach !== null ? plan.monthsToReach - alt.monthsToReach : null,
            }
          : null,
    };
  });

  return {
    currentMonth: current,
    surplusCents: surplus,
    forecastMonths: horizon,
    neededTotalCents: [...plans.values()].reduce((s, p) => s + (p.neededMonthlyCents ?? 0), 0),
    goals,
    accounts: accountIds.map((id) => ({
      accountId: id,
      accountName: rows.find((r) => r.account_id === id)?.account_name ?? '',
      balanceCents: balances.get(id)?.balanceCents ?? null,
      balanceDate: balances.get(id)?.date ?? null,
      allocatedCents: active.filter((r) => r.account_id === id).reduce((s, r) => s + (allocated.get(r.id) ?? 0), 0),
    })),
    subscriptions: subscriptionItems.map((i) => ({ id: i.id, name: i.name, monthlyCents: monthlyOf(i.totalCents), selected: selectedIds.has(i.id) })),
    selectedMonthlyCents: selectedMonthly,
  };
}

// ---------------------------------------------------------------------------
// Anlegen, ändern, löschen
// ---------------------------------------------------------------------------

interface Validated {
  name: string;
  targetCents: number;
  targetDate: string | null;
  priority: number;
  accountId: number | null;
  active: boolean;
}

function validate(db: Db, input: SavingsGoalInput): Validated {
  const name = input.name.trim();
  if (!name) throw new AppError('Bitte einen Namen angeben.');
  const cents = parseGermanAmount(input.amount);
  if (cents === null || cents <= 0) throw new AppError(`„${input.amount}“ ist kein Zielbetrag (Beispiel: 5.000 oder 1.250,50).`);
  const targetDate = input.targetDate || null;
  if (targetDate !== null && !isValidIsoDate(targetDate)) throw new AppError(`„${targetDate}“ ist kein gültiges Wunschdatum.`);
  const priority = input.priority ?? 1;
  if (!Number.isInteger(priority) || priority < 1) throw new AppError('Die Priorität muss eine ganze Zahl ab 1 sein (1 = am wichtigsten).');
  let accountId: number | null;
  if (input.accountId === undefined) {
    const savings = db.prepare("SELECT id FROM accounts WHERE role = 'sparen' AND active = 1").all() as { id: number }[];
    accountId = savings.length === 1 ? (savings[0] as { id: number }).id : null;
  } else {
    accountId = input.accountId;
    if (accountId !== null && !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) {
      throw new AppError(`Konto ${accountId} existiert nicht.`, 404);
    }
  }
  return { name, targetCents: cents, targetDate, priority, accountId, active: input.active ?? true };
}

export function createSavingsGoal(db: Db, input: SavingsGoalInput): { id: number } {
  const v = validate(db, input);
  const now = nowIso();
  const result = db
    .prepare(
      `INSERT INTO savings_goals (name, target_cents, target_date, priority, account_id, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(v.name, v.targetCents, v.targetDate, v.priority, v.accountId, v.active ? 1 : 0, now, now);
  return { id: Number(result.lastInsertRowid) };
}

export function updateSavingsGoal(db: Db, id: number, input: SavingsGoalInput): void {
  if (!db.prepare('SELECT 1 FROM savings_goals WHERE id = ?').get(id)) throw new AppError(`Sparziel ${id} existiert nicht.`, 404);
  const v = validate(db, input);
  db.prepare(
    `UPDATE savings_goals SET name = ?, target_cents = ?, target_date = ?, priority = ?, account_id = ?, active = ?, updated_at = ?
      WHERE id = ?`,
  ).run(v.name, v.targetCents, v.targetDate, v.priority, v.accountId, v.active ? 1 : 0, nowIso(), id);
}

export function deleteSavingsGoal(db: Db, id: number): void {
  const result = db.prepare('DELETE FROM savings_goals WHERE id = ?').run(id);
  if (result.changes === 0) throw new AppError(`Sparziel ${id} existiert nicht.`, 404);
}
