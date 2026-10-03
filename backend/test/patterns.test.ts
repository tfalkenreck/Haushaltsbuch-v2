import { describe, expect, it } from 'vitest';
import { compilePattern, patternProblem, suggestSearchText } from '../src/lib/patterns.js';

describe('Suchtext (contains)', () => {
  it('findet Teiltexte ohne Rücksicht auf Groß-/Kleinschreibung', () => {
    const m = compilePattern('contains', 'rewe');
    expect(m('REWE MARKT GMBH')).toBe(true);
    expect(m('Supermarkt Rewe')).toBe(true);
    expect(m('ALDI')).toBe(false);
  });

  it('nimmt Sonderzeichen wörtlich', () => {
    expect(compilePattern('contains', 'H&M')('H&M Hennes & Mauritz')).toBe(true);
    expect(compilePattern('contains', 'H&M')('HM Fashion')).toBe(false);
    expect(compilePattern('contains', 'real,-')('real,- SB-Warenhaus')).toBe(true);
    expect(compilePattern('contains', 'real,-')('Realschule')).toBe(false);
    expect(compilePattern('contains', 'a.b')('axb')).toBe(false);
    expect(compilePattern('contains', '*')('Stern * Markt')).toBe(true);
    expect(compilePattern('contains', '*')('Markt')).toBe(false);
  });

  it('behandelt mehrfachen Leerraum und Zeilenumbrüche wie ein Leerzeichen', () => {
    expect(compilePattern('contains', 'REWE  MARKT')('REWE MARKT\nGMBH')).toBe(true);
    expect(compilePattern('contains', 'markt gmbh')('REWE MARKT\nGMBH')).toBe(true);
  });

  it('kennt Umlaute', () => {
    expect(compilePattern('contains', 'BÄCKEREI')('Bäckerei Müller')).toBe(true);
  });
});

describe('Ausdruck mit Platzhaltern (wildcard)', () => {
  it('muss den ganzen Text treffen', () => {
    const m = compilePattern('wildcard', 'REWE*');
    expect(m('rewe markt')).toBe(true);
    expect(m('Supermarkt Rewe')).toBe(false);
  });

  it('kennt * und ?, alles andere wörtlich', () => {
    expect(compilePattern('wildcard', '*Vertrag ????*')('Abschlag Vertrag 4711 09/2026')).toBe(true);
    expect(compilePattern('wildcard', '*Vertrag ????*')('Vertrag 47')).toBe(false);
    expect(compilePattern('wildcard', '*(GB)*')('Shop (GB) Ltd')).toBe(true);
    expect(compilePattern('wildcard', 'a.c')('abc')).toBe(false);
    expect(compilePattern('wildcard', '*H&M*')('H&M Hennes')).toBe(true);
  });

  it('trifft auch über Zeilenumbrüche hinweg', () => {
    expect(compilePattern('wildcard', '*miete*')('Überweisung\nMiete Oktober')).toBe(true);
  });
});

describe('Musterprüfung', () => {
  it('lehnt leere und reine Platzhalter-Muster ab', () => {
    expect(patternProblem('contains', '   ')).toMatch(/leer/);
    expect(patternProblem('wildcard', '* ?')).toMatch(/festes Zeichen/);
    expect(patternProblem('contains', '*')).toBeNull();
    expect(patternProblem('wildcard', 'REWE*')).toBeNull();
  });
});

describe('Suchtext-Vorschlag', () => {
  it('nimmt die Wörter bis zur ersten Nummer', () => {
    expect(suggestSearchText('AMAZON PAYMENTS EUROPE 302-1234567')).toBe('AMAZON PAYMENTS EUROPE');
    expect(suggestSearchText('Stadtwerke Musterstadt GmbH')).toBe('Stadtwerke Musterstadt GmbH');
  });

  it('überspringt Nummern am Anfang', () => {
    expect(suggestSearchText('0000000 Tarif Plus')).toBe('Tarif Plus');
    expect(suggestSearchText('12345 678')).toBeNull();
  });

  it('begrenzt die Wortzahl', () => {
    expect(suggestSearchText('eins zwei drei vier', 3)).toBe('eins zwei drei');
  });
});
