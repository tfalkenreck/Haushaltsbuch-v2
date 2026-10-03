import { describe, expect, it } from 'vitest';
import { detectInterval, detectRecurringDebits, monthlyEquivalent, type Debit } from '../src/services/recurring-debits.js';

describe('detectInterval', () => {
  it('erkennt die Intervalle mit Toleranz für Wochenenden', () => {
    expect(detectInterval(['2026-01-02', '2026-01-16', '2026-01-30', '2026-02-13'])).toBe('biweekly');
    expect(detectInterval(['2026-07-01', '2026-08-03', '2026-09-01'])).toBe('monthly');
    expect(detectInterval(['2026-01-15', '2026-04-15', '2026-07-15'])).toBe('quarterly');
    expect(detectInterval(['2026-01-02', '2026-07-01'])).toBe('semiannual');
    expect(detectInterval(['2025-03-01', '2026-03-02'])).toBe('annual');
  });

  it('erlaubt eine ausgelassene Abbuchung, verlangt bei Monatlichem drei', () => {
    expect(detectInterval(['2026-05-05', '2026-06-05', '2026-08-05'])).toBe('monthly');
    expect(detectInterval(['2026-08-05', '2026-09-05'])).toBeNull();
  });

  it('lehnt Unregelmäßiges ab', () => {
    expect(detectInterval(['2026-07-01', '2026-07-09', '2026-08-20', '2026-09-01'])).toBeNull();
    expect(detectInterval(['2026-07-01'])).toBeNull();
  });
});

describe('detectRecurringDebits', () => {
  let id = 1;
  const d = (date: string, amountCents: number, key = 'cp:telefon'): Debit => ({
    transactionId: id++,
    accountId: 1,
    date,
    amountCents,
    key,
    label: key.slice(3),
  });

  it('ist großzügig beim Betrag, erlaubt eine Ausreißerin', () => {
    const strom = [d('2026-05-02', -6000), d('2026-06-02', -6000), d('2026-07-02', -21000), d('2026-08-03', -6500)];
    expect(detectRecurringDebits(strom)).toMatchObject([{ interval: 'monthly', lastAmountCents: 6500, nextDueDate: '2026-09-03', count: 4 }]);
    const wild = [d('2026-05-02', -1000), d('2026-06-02', -5000), d('2026-07-02', -9000), d('2026-08-03', -500)];
    expect(detectRecurringDebits(wild)).toEqual([]);
  });

  it('rechnet auf den Monat um', () => {
    expect(monthlyEquivalent(12000, 'annual')).toBe(1000);
    expect(monthlyEquivalent(3000, 'quarterly')).toBe(1000);
    expect(monthlyEquivalent(1200, 'biweekly')).toBe(2600);
  });
});
