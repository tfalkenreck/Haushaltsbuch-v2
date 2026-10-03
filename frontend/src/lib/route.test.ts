import { describe, expect, it } from 'vitest';
import { hrefFor, parseHash } from './route';

describe('parseHash', () => {
  it('liest Seite und Parameter', () => {
    const route = parseHash('#/buchungen?accountId=3&q=miete');
    expect(route.page).toBe('buchungen');
    expect(route.params.get('accountId')).toBe('3');
    expect(route.params.get('q')).toBe('miete');
  });

  it('fällt auf die Kontenseite zurück', () => {
    expect(parseHash('').page).toBe('konten');
    expect(parseHash('#/unbekannt').page).toBe('konten');
  });

  it('baut Links ohne leere Parameter', () => {
    expect(hrefFor('buchungen', { accountId: 3, q: '' })).toBe('#/buchungen?accountId=3');
    expect(hrefFor('import')).toBe('#/import');
  });
});
