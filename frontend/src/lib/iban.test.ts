import { describe, expect, it } from 'vitest';
import { formatIban } from './iban';

describe('formatIban', () => {
  it('gruppiert in Vierergruppen', () => {
    expect(formatIban('DE17123456780000000001')).toBe('DE17 1234 5678 0000 0000 01');
  });

  it('verträgt bereits formatierte Eingaben', () => {
    expect(formatIban('DE17 1234 5678 0000 0000 01')).toBe('DE17 1234 5678 0000 0000 01');
  });
});
