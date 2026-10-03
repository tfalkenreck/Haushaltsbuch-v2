import { describe, expect, it } from 'vitest';
import { shiftMonth } from '../src/lib/date.js';
import {
  assessBalance,
  fundingCauses,
  fundingMonths,
  fundingRecommendation,
  fundingTrend,
  lastPriceChange,
  percentile,
  type FundingMonth,
  type FundingTransaction,
} from '../src/services/funding-analysis.js';

function month(m: string, difference: number, extra: Partial<FundingMonth> = {}): FundingMonth {
  return {
    month: m,
    status: 'complete',
    standingOrdersCents: 20000,
    otherTransfersCents: 0,
    debitsCents: 20000 - difference,
    creditsCents: 0,
    expensesCents: 20000 - difference,
    differenceCents: difference,
    balanceEndCents: null,
    ...extra,
  };
}

describe('fundingMonths', () => {
  it('trennt Daueraufträge, übrige Umbuchungen, Abbuchungen und Erstattungen', () => {
    const tx: FundingTransaction[] = [
      { id: 1, date: '2026-09-11', amountCents: 20000, isTransfer: true, key: 'a', label: 'A' },
      { id: 2, date: '2026-09-15', amountCents: 5000, isTransfer: true, key: 'b', label: 'B' },
      { id: 3, date: '2026-09-20', amountCents: -3000, isTransfer: true, key: 'c', label: 'C' },
      { id: 4, date: '2026-09-02', amountCents: -25000, isTransfer: false, key: 'd', label: 'D' },
      { id: 5, date: '2026-09-03', amountCents: 1000, isTransfer: false, key: 'e', label: 'E' },
      { id: 6, date: '2026-10-01', amountCents: -999, isTransfer: false, key: 'f', label: 'F' },
    ];
    const [row] = fundingMonths([{ month: '2026-09', status: 'complete', balanceEndCents: 123 }], tx, new Set([1]));
    expect(row).toEqual({
      month: '2026-09',
      status: 'complete',
      standingOrdersCents: 20000,
      otherTransfersCents: 2000,
      debitsCents: 25000,
      creditsCents: 1000,
      expensesCents: 24000,
      differenceCents: -4000,
      balanceEndCents: 123,
    });
  });
});

describe('fundingTrend', () => {
  it('unterscheidet Einzelfall, Trend und gedeckt; unvollständige Monate zählen nicht', () => {
    expect(fundingTrend([month('2026-07', 100), month('2026-08', -500)]).status).toBe('single');
    expect(fundingTrend([month('2026-07', -100), month('2026-08', -500), month('2026-09', -300)])).toMatchObject({
      status: 'trend',
      deficitStreak: 3,
      deficitSince: '2026-07',
      direction: 'growing',
    });
    expect(fundingTrend([month('2026-08', -500), month('2026-09', -300)]).direction).toBe('shrinking');
    expect(fundingTrend([month('2026-08', -500), month('2026-09', 0), month('2026-10', -900, { status: 'partial' })])).toMatchObject({
      status: 'covered',
      deficitStreak: 0,
      windowMonths: ['2026-08', '2026-09'],
    });
    expect(fundingTrend([month('2026-10', -900, { status: 'partial' })]).status).toBe('unknown');
  });

  it('betrachtet höchstens zwölf vollständige Monate', () => {
    const rows = Array.from({ length: 14 }, (_, i) => month(shiftMonth('2025-01', i), -100));
    expect(fundingTrend(rows).windowMonths).toHaveLength(12);
    expect(fundingTrend(rows).deficitStreak).toBe(14);
  });
});

describe('fundingRecommendation', () => {
  it('braucht mindestens drei vollständige Monate', () => {
    expect(fundingRecommendation([month('2026-08', 0), month('2026-09', 0)], [], 20000, 0)).toBeNull();
  });

  it('rundet Durchschnitt plus Puffer plus Umzustellendes auf volle 10 € auf', () => {
    const rows = [month('2026-07', 0), month('2026-08', -1000), month('2026-09', -2001)];
    // Abbuchungen 200,00 / 210,00 / 220,01 → Ø 210,00, 80.-Perzentil 220,01 → Puffer 10,01.
    expect(fundingRecommendation(rows, [], 20000, 1500)).toMatchObject({
      averageExpensesCents: 21000,
      bufferCents: 1001,
      recommendedCents: 24000,
      changeCents: 4000,
    });
  });

  it('nennt percentile nach Nearest-Rank', () => {
    expect(percentile([5, 1, 3, 2, 4], 80)).toBe(4);
    expect(percentile([7], 80)).toBe(7);
  });
});

describe('Ursachen', () => {
  it('findet die letzte Preisänderung', () => {
    expect(
      lastPriceChange([
        { date: '2026-05-07', amountCents: -999 },
        { date: '2026-06-07', amountCents: -999 },
        { date: '2026-07-07', amountCents: -1299 },
        { date: '2026-08-07', amountCents: -1299 },
      ]),
    ).toEqual({ date: '2026-07-07', fromCents: 999, toCents: 1299 });
    expect(lastPriceChange([{ date: '2026-06-07', amountCents: -999 }, { date: '2026-07-07', amountCents: -999 }])).toBeNull();
    // Schwankende Beträge (Supermarkt) sind keine Preiserhöhung.
    expect(
      lastPriceChange([
        { date: '2026-06-16', amountCents: -9500 },
        { date: '2026-07-16', amountCents: -15000 },
        { date: '2026-08-16', amountCents: -12000 },
      ]),
    ).toBeNull();
  });

  it('braucht einen Vergleichszeitraum', () => {
    expect(fundingCauses([month('2026-07', 0), month('2026-08', 0), month('2026-09', 0)], [])).toBeNull();
  });
});

describe('assessBalance', () => {
  it('meldet Minus und rechnet die Reichweite des Polsters', () => {
    const rows = [month('2026-08', -5000, { balanceEndCents: 20000 }), month('2026-09', -5000, { balanceEndCents: 15000 })];
    const trend = fundingTrend(rows);
    expect(assessBalance(rows, trend, { balanceCents: 15000, date: '2026-09-30', source: 'bank' })).toMatchObject({
      status: 'cushion',
      runwayMonths: 3,
      lowestCents: 15000,
      changeCents: -5000,
      changeSince: '2026-08',
    });
    expect(assessBalance(rows, trend, { balanceCents: -100, date: '2026-09-30', source: 'bank' })).toMatchObject({
      status: 'negative',
      runwayMonths: null,
    });
    expect(assessBalance(rows, trend, null).status).toBe('unknown');
  });
});
