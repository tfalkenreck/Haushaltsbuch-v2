import { describe, expect, it } from 'vitest';
import { averageCents, medianCents, permille } from '../src/lib/stats.js';
import { allocateBalances, monthsUntil, planGoals, type PlanGoal } from '../src/services/savings-plan.js';

describe('Statistik in Cent', () => {
  it('Median: ungerade Anzahl mittlerer Wert, gerade Anzahl Mittel der beiden mittleren', () => {
    expect(medianCents([300, 100, 200])).toBe(200);
    expect(medianCents([-40000, -30000, -30000, 0, 0, 0])).toBe(-15000);
    expect(medianCents([1, 2])).toBe(2);
    expect(medianCents([])).toBe(0);
  });

  it('Durchschnitt und Promille', () => {
    expect(averageCents([100, 101])).toBe(101);
    expect(permille(1, 3)).toBe(333);
    expect(permille(5, 0)).toBe(0);
  });
});

describe('Sparziele staffeln', () => {
  const goals: PlanGoal[] = [
    { id: 1, accountId: 9, targetCents: 300000, targetMonth: null },
    { id: 2, accountId: 9, targetCents: 500000, targetMonth: '2027-06' },
    { id: 3, accountId: null, targetCents: 100000, targetMonth: '2026-11' },
  ];

  it('teilt das Guthaben nach Priorität zu, jedes Ziel höchstens bis zum Zielbetrag', () => {
    const allocated = allocateBalances(goals, new Map([[9, 350000]]));
    expect([...allocated]).toEqual([
      [1, 300000],
      [2, 50000],
      [3, 0],
    ]);
    expect(allocateBalances(goals, new Map()).get(1)).toBe(0);
  });

  it('erreicht Ziele nacheinander mit dem Überschuss', () => {
    const allocated = allocateBalances(goals, new Map([[9, 350000]]));
    const [a, b, c] = planGoals(goals, allocated, 100000, '2026-10');
    expect(a).toMatchObject({ remainingCents: 0, monthsToReach: 0, reachMonth: null, onTrack: null });
    expect(b).toMatchObject({ remainingCents: 450000, monthsToReach: 5, reachMonth: '2027-02', monthsAvailable: 8, neededMonthlyCents: 56250, onTrack: true });
    // Kommt erst nach Ziel 2 dran: 550.000 / 100.000 → 6 Monate, Wunsch November = 1 Monat.
    expect(c).toMatchObject({ monthsToReach: 6, reachMonth: '2027-03', monthsAvailable: 1, neededMonthlyCents: 100000, onTrack: false });
  });

  it('ohne Überschuss wird kein Ziel erreicht', () => {
    const [, b] = planGoals(goals, new Map(), 0, '2026-10');
    expect(b).toMatchObject({ monthsToReach: null, reachMonth: null, onTrack: false });
  });

  it('zählt Monatsenden bis vor den Wunschmonat, mindestens eins', () => {
    expect(monthsUntil('2026-10', '2027-06')).toBe(8);
    expect(monthsUntil('2026-10', '2026-10')).toBe(1);
    expect(monthsUntil('2026-10', '2026-01')).toBe(1);
  });
});
