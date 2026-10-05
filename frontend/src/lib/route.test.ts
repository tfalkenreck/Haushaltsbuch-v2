import { describe, expect, it } from 'vitest';
import { hrefFor, parseHash } from './route';

describe('parseHash', () => {
  it('liest Seite und Parameter', () => {
    const route = parseHash('#/buchungen?accountId=3&q=miete');
    expect(route.page).toBe('buchungen');
    expect(route.params.get('accountId')).toBe('3');
    expect(route.params.get('q')).toBe('miete');
  });

  it('kennt die Seiten für Kategorien und Regeln', () => {
    expect(parseHash('#/kategorien').page).toBe('kategorien');
    expect(parseHash('#/regeln').page).toBe('regeln');
    expect(parseHash('#/umbuchungen?status=suggested').page).toBe('umbuchungen');
    expect(parseHash('#/deckung?accountId=2').page).toBe('deckung');
    expect(parseHash('#/fixkosten?fromTx=5').page).toBe('fixkosten');
    expect(parseHash('#/buchungen?uncategorized=1').params.get('uncategorized')).toBe('1');
  });

  it('fällt auf die Übersicht (Startseite) zurück', () => {
    expect(parseHash('').page).toBe('uebersicht');
    expect(parseHash('#/unbekannt').page).toBe('uebersicht');
  });

  it('kennt die Auswertungsseiten', () => {
    expect(parseHash('#/budget?month=2026-09&span=3').page).toBe('budget');
    expect(parseHash('#/prognose').page).toBe('prognose');
    expect(parseHash('#/sparziele').page).toBe('sparziele');
    expect(parseHash('#/uebersicht?accountId=2').params.get('accountId')).toBe('2');
  });

  it('baut Links ohne leere Parameter', () => {
    expect(hrefFor('buchungen', { accountId: 3, q: '' })).toBe('#/buchungen?accountId=3');
    expect(hrefFor('import')).toBe('#/import');
  });
});
