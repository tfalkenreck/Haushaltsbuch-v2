import { describe, expect, it } from 'vitest';
import { balanceAt, dayEndBalances, type Movement } from '../src/services/balance-history.js';

describe('dayEndBalances', () => {
  it('findet den Tagesendstand unabhängig von der Reihenfolge der Zeilen', () => {
    // 1.000 → +200 → 1.200 → −50 → 1.150; Datei mit neuester Zeile zuerst oder zuletzt.
    const day: Movement[] = [
      { id: 2, date: '2026-09-01', amountCents: -5000, balanceAfterCents: 115000 },
      { id: 1, date: '2026-09-01', amountCents: 20000, balanceAfterCents: 120000 },
    ];
    expect(dayEndBalances(day)).toEqual([{ date: '2026-09-01', balanceCents: 115000, source: 'bank' }]);
    expect(dayEndBalances([...day].reverse())).toEqual([{ date: '2026-09-01', balanceCents: 115000, source: 'bank' }]);
  });

  it('überspringt Tage ohne Saldo', () => {
    expect(dayEndBalances([{ id: 1, date: '2026-09-01', amountCents: -100, balanceAfterCents: null }])).toEqual([]);
  });
});

describe('balanceAt', () => {
  const movements: Movement[] = [
    { id: 1, date: '2026-08-15', amountCents: -3000, balanceAfterCents: null },
    { id: 2, date: '2026-09-11', amountCents: 20000, balanceAfterCents: null },
    { id: 3, date: '2026-09-20', amountCents: -5000, balanceAfterCents: null },
  ];
  const anchor = { date: '2026-09-11', balanceCents: 10000, source: 'manual' as const };

  it('rechnet vom nächsten Anker vorwärts und rückwärts', () => {
    expect(balanceAt('2026-09-30', [anchor], movements)).toEqual({ balanceCents: 5000, source: 'manual', anchorDate: '2026-09-11' });
    expect(balanceAt('2026-08-31', [anchor], movements)).toMatchObject({ balanceCents: -10000 });
    expect(balanceAt('2026-08-01', [anchor], movements)).toMatchObject({ balanceCents: -7000 });
    expect(balanceAt('2026-09-11', [anchor], movements)).toMatchObject({ balanceCents: 10000 });
  });

  it('nimmt den nächstgelegenen Anker, bei Gleichstand den der Bank', () => {
    const bank = { date: '2026-09-20', balanceCents: 999, source: 'bank' as const };
    expect(balanceAt('2026-09-25', [anchor, bank], movements)).toMatchObject({ balanceCents: 999, source: 'bank' });
    expect(balanceAt('2026-09-20', [{ ...bank, source: 'manual' }, bank], movements)).toMatchObject({ source: 'bank' });
    expect(balanceAt('2026-09-25', [], movements)).toBeNull();
  });
});
