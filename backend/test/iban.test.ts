import { describe, expect, it } from 'vitest';
import { isValidIban, normalizeIban } from '../src/lib/iban.js';

describe('IBAN', () => {
  it('normalisiert Leerzeichen und Kleinschreibung', () => {
    expect(normalizeIban(' de89 3704 0044 0532 0130 00 ')).toBe('DE89370400440532013000');
  });

  it('erkennt gültige Prüfziffern', () => {
    // Bekannte Beispiel-IBANs aus der ISO-/Bankendokumentation.
    expect(isValidIban('DE89370400440532013000')).toBe(true);
    expect(isValidIban('GB82WEST12345698765432')).toBe(true);
  });

  it('lehnt falsche Prüfziffern und Längen ab', () => {
    expect(isValidIban('DE89370400440532013001')).toBe(false);
    expect(isValidIban('DE8937040044053201300')).toBe(false);
    expect(isValidIban('DE89 3704 0044 0532 0130 00')).toBe(false);
    expect(isValidIban('')).toBe(false);
  });
});
