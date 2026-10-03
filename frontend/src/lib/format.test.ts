import { describe, expect, it } from 'vitest';
import { addMonthsIso, centsToInput, formatCents, formatDate, formatMonth } from './format';

describe('formatCents', () => {
  it.each([
    [0, '0,00 €'],
    [5, '0,05 €'],
    [-775, '−7,75 €'],
    [123456, '1.234,56 €'],
    [-123456789, '−1.234.567,89 €'],
    [29, '0,29 €'],
  ])('%i → %s', (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });

  it('zeigt auf Wunsch ein Plus bei Zuflüssen', () => {
    expect(formatCents(25000, { sign: true })).toBe('+250,00 €');
    expect(formatCents(0, { sign: true })).toBe('0,00 €');
  });
});

describe('formatDate / formatMonth', () => {
  it('formatiert deutsch', () => {
    expect(formatDate('2026-10-02')).toBe('02.10.2026');
    expect(formatDate(null)).toBe('–');
    expect(formatMonth('2026-03')).toBe('Mär 2026');
  });
});

describe('centsToInput / addMonthsIso', () => {
  it('belegt Betragsfelder vor und rechnet Termine', () => {
    expect(centsToInput(1299)).toBe('12,99');
    expect(centsToInput(5)).toBe('0,05');
    expect(centsToInput(123456)).toBe('1234,56');
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2026-11-15', 3)).toBe('2027-02-15');
  });
});
