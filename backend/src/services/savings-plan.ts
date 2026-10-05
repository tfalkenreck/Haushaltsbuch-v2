import { shiftMonth } from '../lib/date.js';

/**
 * Staffelung von Sparzielen (CLAUDE.md § 15) – reine Funktionen.
 *
 * - Stand: Das Guthaben eines Kontos wird den Zielen dieses Kontos in der
 *   Reihenfolge ihrer Priorität zugeteilt (kleinere Zahl zuerst), jedes
 *   bekommt höchstens seinen Zielbetrag.
 * - Plan: Der prognostizierte monatliche Überschuss fließt vollständig in
 *   das wichtigste noch offene Ziel, danach ins nächste. Ein Überschuss
 *   eines Monats ist an dessen Ende verfügbar.
 * - Nötige Monatsrate: Rest ÷ Monate bis zum Wunschmonat (Monatsenden vor
 *   dem Wunschmonat, mindestens eins), aufgerundet auf ganze Cent.
 */

export interface PlanGoal {
  id: number;
  accountId: number | null;
  targetCents: number;
  /** Wunschmonat `YYYY-MM`; null = ohne Wunschdatum. */
  targetMonth: string | null;
}

export interface GoalPlan {
  id: number;
  /** Zugeteilter Stand aus dem Kontoguthaben. */
  currentCents: number;
  remainingCents: number;
  /** Monate, bis das Ziel mit dem Überschuss erreicht ist; 0 = schon erreicht, null = nie (kein Überschuss). */
  monthsToReach: number | null;
  /** Monat, an dessen Ende das Ziel erreicht ist; null = schon erreicht oder nie. */
  reachMonth: string | null;
  /** Monatsenden bis zum Wunschmonat. */
  monthsAvailable: number | null;
  /** Nötige Rate, um den Wunschmonat allein zu schaffen. */
  neededMonthlyCents: number | null;
  /** Erreicht bis zum Wunschmonat; null = ohne Wunschdatum. */
  onTrack: boolean | null;
}

/**
 * Teilt Kontoguthaben den Zielen zu (Ziele bereits nach Priorität sortiert).
 * Konten ohne bekannten Stand (`balances` ohne Eintrag) tragen nichts bei.
 */
export function allocateBalances(goals: PlanGoal[], balances: ReadonlyMap<number, number>): Map<number, number> {
  const left = new Map(balances);
  const result = new Map<number, number>();
  for (const g of goals) {
    const available = g.accountId === null ? 0 : Math.max(0, left.get(g.accountId) ?? 0);
    const take = Math.min(available, g.targetCents);
    result.set(g.id, take);
    if (g.accountId !== null && left.has(g.accountId)) left.set(g.accountId, available - take);
  }
  return result;
}

/** Monatsenden von `current` bis vor `target` (mindestens 1). */
export function monthsUntil(current: string, target: string): number {
  const diff = (Number(target.slice(0, 4)) - Number(current.slice(0, 4))) * 12 + Number(target.slice(5, 7)) - Number(current.slice(5, 7));
  return Math.max(1, diff);
}

export function planGoals(goals: PlanGoal[], allocated: ReadonlyMap<number, number>, surplusCents: number, current: string): GoalPlan[] {
  let cumulative = 0;
  return goals.map((g) => {
    const currentCents = allocated.get(g.id) ?? 0;
    const remainingCents = Math.max(0, g.targetCents - currentCents);
    cumulative += remainingCents;
    let monthsToReach: number | null;
    if (remainingCents === 0) monthsToReach = 0;
    else if (surplusCents <= 0) monthsToReach = null;
    else monthsToReach = Math.ceil(cumulative / surplusCents);
    const monthsAvailable = g.targetMonth === null ? null : monthsUntil(current, g.targetMonth);
    return {
      id: g.id,
      currentCents,
      remainingCents,
      monthsToReach,
      reachMonth: monthsToReach === null || monthsToReach === 0 ? null : shiftMonth(current, monthsToReach - 1),
      monthsAvailable,
      neededMonthlyCents: remainingCents === 0 ? 0 : monthsAvailable === null ? null : Math.ceil(remainingCents / monthsAvailable),
      onTrack: monthsAvailable === null ? null : monthsToReach !== null && monthsToReach <= monthsAvailable,
    };
  });
}
