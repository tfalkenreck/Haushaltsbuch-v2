import { describe, expect, it } from 'vitest';
import { shiftMonth } from '../src/lib/date.js';
import {
  assessBalance,
  detectFundingSwitch,
  fundingCauses,
  fundingMonths,
  fundingRecommendation,
  fundingTrend,
  lastPriceChange,
  percentile,
  standingOrderLevel,
  type FundingMonth,
  type LevelOrder,
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

  it('nimmt den Puffer aus der Schwankung der Monatssumme, nicht aus der Summe der Schwankungen einzelner Posten', () => {
    // Strom und Lebensmittel schwanken je um 100 €, gleichen sich im Monat aber aus:
    // die monatliche Abbuchungssumme ist immer 300 € → kein Puffer.
    const tx: FundingTransaction[] = [];
    const amounts: [string, number, number][] = [
      ['2026-07', 5000, 25000],
      ['2026-08', 15000, 15000],
      ['2026-09', 25000, 5000],
    ];
    amounts.forEach(([m, strom, rewe], i) => {
      tx.push({ id: i * 2 + 1, date: `${m}-02`, amountCents: -strom, isTransfer: false, key: 'strom', label: 'Strom' });
      tx.push({ id: i * 2 + 2, date: `${m}-20`, amountCents: -rewe, isTransfer: false, key: 'rewe', label: 'REWE' });
    });
    const rows = amounts.map(([m]) => month(m, 0, { standingOrdersCents: 30000, debitsCents: 30000, expensesCents: 30000 }));
    const r = fundingRecommendation(rows, tx, 30000, 0);
    expect(r).toMatchObject({ bufferCents: 0, minExpensesCents: 30000, maxExpensesCents: 30000, verdict: 'fits', changeCents: 0 });
    // Die schwankenden Posten werden nur zur Information genannt.
    expect(r?.fluctuating.map((i) => i.label)).toEqual(['REWE', 'Strom']);
  });

  it('sagt „passt“, wenn jeder Monat gedeckt ist und der Saldo nicht fällt', () => {
    const rows = [month('2026-07', 3000), month('2026-08', 500), month('2026-09', 4000)];
    expect(fundingRecommendation(rows, [], 20000, 0, null, { changeCents: 7500 })).toMatchObject({
      verdict: 'fits',
      allMonthsCovered: true,
      minSurplusCents: 500,
      balanceFalling: false,
      recommendedCents: 20000,
      changeCents: 0,
    });
    // Umzustellende Posten bis zur kleinsten Überdeckung passen noch hinein …
    expect(fundingRecommendation(rows, [], 20000, 500, null, { changeCents: 7500 })?.verdict).toBe('fits');
    // … darüber hinaus wird um den Rest erhöht (auf volle 10 €).
    expect(fundingRecommendation(rows, [], 20000, 1999, null, { changeCents: 7500 })).toMatchObject({
      verdict: 'increase',
      recommendedCents: 22000,
      changeCents: 2000,
    });
    // Fällt der Saldo trotzdem (z. B. Umbuchungen weg vom Konto), gilt die volle Rechnung.
    expect(fundingRecommendation(rows, [], 20000, 0, null, { changeCents: -100 })).toMatchObject({
      balanceFalling: true,
      neededCents: 20000,
      verdict: 'fits',
    });
    expect(fundingRecommendation(rows, [], 15000, 0, null, { changeCents: -100 })).toMatchObject({
      verdict: 'increase',
      recommendedCents: 20000,
    });
  });

  it('rechnet nur mit Monaten ab dem Startmonat', () => {
    const rows = [month('2026-05', -90000), month('2026-06', 100), month('2026-07', 200), month('2026-08', 300)];
    expect(fundingRecommendation(rows, [], 20000, 0)?.verdict).toBe('increase');
    expect(fundingRecommendation(rows, [], 20000, 0, '2026-06')).toMatchObject({ basisMonths: 3, verdict: 'fits' });
    expect(fundingRecommendation(rows, [], 20000, 0, '2026-07')).toBeNull();
    expect(fundingTrend(rows, '2026-06')).toMatchObject({ status: 'covered', windowMonths: ['2026-06', '2026-07', '2026-08'] });
  });

  it('nennt percentile nach Nearest-Rank', () => {
    expect(percentile([5, 1, 3, 2, 4], 80)).toBe(4);
    expect(percentile([7], 80)).toBe(7);
  });
});

describe('Umstellung der Daueraufträge', () => {
  const order = (occurrences: [string, number][], active = true): LevelOrder => ({
    active,
    occurrences: occurrences.map(([m, amountCents]) => ({ month: m, amountCents })),
  });

  it('summiert die laufenden Daueraufträge je Monat, auch über eine ausgelassene Ausführung', () => {
    const orders = [
      order([['2026-01', 10000], ['2026-03', 10000], ['2026-04', 12000]]),
      order([['2026-01', 5000], ['2026-02', 5000]], false),
    ];
    expect(['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-09'].map((m) => standingOrderLevel(orders, m))).toEqual([
      0, 15000, 15000, 10000, 12000, 12000,
    ]);
  });

  it('findet die letzte deutliche Änderung, nicht kleine Anpassungen', () => {
    const rows = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'].map((m) => month(m, 0));
    const big = [order([['2026-01', 100000], ['2026-02', 100000]], false), order(rows.map((r) => [r.month, 30000]))];
    expect(detectFundingSwitch(rows, big)).toEqual({ month: '2026-03', fromCents: 130000, toCents: 30000 });
    // 200 € → 210 € (5 %) ist keine Umstellung.
    const small = [order([['2026-01', 20000], ['2026-02', 20000], ['2026-03', 21000], ['2026-04', 21000]])];
    expect(detectFundingSwitch(rows, small)).toBeNull();
  });

  it('lässt sich von teilweise importierten Monaten am Anfang und um Lücken nicht täuschen', () => {
    const rows = [
      month('2026-01', 0, { status: 'partial' }),
      month('2026-02', 0),
      month('2026-03', 0),
      month('2026-04', 0, { status: 'partial' }),
      month('2026-05', 0, { status: 'missing' }),
      month('2026-06', 0, { status: 'partial' }),
      month('2026-07', 0),
    ];
    // Erste Ausführung erst im Februar (Import ab Mitte Januar); die Reihe
    // reißt an der Importlücke ab und beginnt im Juli neu.
    const orders = [order([['2026-02', 42500], ['2026-03', 42500]], false), order([['2026-07', 42500]])];
    expect(detectFundingSwitch(rows, orders)).toBeNull();
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
