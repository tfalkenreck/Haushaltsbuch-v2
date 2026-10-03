import { describe, expect, it } from 'vitest';
import { formatCents, formatDate, formatMonth } from './format';

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
