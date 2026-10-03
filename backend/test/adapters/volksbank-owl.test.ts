import { describe, expect, it } from 'vitest';
import { merchantFromPurpose, volksbankOwlAdapter } from '../../src/adapters/volksbank-owl.js';
import { AdapterError } from '../../src/adapters/types.js';
import { fixture, IBAN } from '../helpers/fixtures.js';

const parse = (path: string) => volksbankOwlAdapter.parse(fixture(path));

describe('Volksbank-OWL-Fixtures', () => {
  it('liegen wirklich als UTF-8 mit BOM vor', () => {
    const bytes = fixture('volksbank-owl/giro.csv');
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    // „ä“ als UTF-8-Bytefolge C3 A4
    expect(Buffer.from(bytes).includes(Buffer.from([0xc3, 0xa4]))).toBe(true);
  });
});

describe('volksbank-owl – Girokonto', () => {
  const result = parse('volksbank-owl/giro.csv');

  it('liest alle Buchungen, auch nach einer Leerzeile mitten in der Datei', () => {
    expect(result.transactions).toHaveLength(10);
    expect(result.ignored).toEqual([]);
    expect(result.pending).toEqual([]);
  });

  it('bildet die Spalten laut docs/bankformate.md ab', () => {
    const t = result.transactions.find((x) => x.counterparty === 'BAECKEREI MUSTERMANN');
    expect(t).toMatchObject({
      bookingDate: '2026-10-02',
      valueDate: '2026-10-02',
      amountCents: -775,
      currency: 'EUR',
      counterpartyIban: 'DE02120300000000202051',
      bookingText: 'Kartenzahlung girocard',
      creditorId: 'DE00ZZZ00000000001',
      mandateReference: '111111',
      accountIban: IBAN.volksbankGiro,
      bankReference: null,
    });
    expect(t?.purpose).toMatch(/^B\.CKEREI MUSTERMANN\/Hauptstr\. 1/);
  });

  it('dekodiert Umlaute im Namen korrekt', () => {
    expect(result.transactions.filter((t) => t.counterparty === 'Bäckerei Müller')).toHaveLength(2);
  });

  it('parst Tausenderpunkt ohne Float', () => {
    expect(result.transactions.find((t) => t.purpose === 'Umbuchung Ausgabenkonto')?.amountCents).toBe(-123456);
  });

  it('behält Semikolon und Zeilenumbruch im Verwendungszweck', () => {
    const purposes = result.transactions.map((t) => t.purpose);
    expect(purposes).toContain('Abschlag Strom; Vertrag 4711 09/2026');
    expect(purposes).toContain('Rechnung 2026-09\nKundennummer 123456');
  });

  it('speichert den Saldo pro Zeile und erkennt die Kette als lückenlos', () => {
    expect(result.transactions.every((t) => t.balanceAfterCents !== null)).toBe(true);
    expect(result.warnings).toEqual([]);
    // jüngste Zeile: 1.000,00 + Summe aller Beträge
    const sum = result.transactions.reduce((s, t) => s + t.amountCents, 0);
    expect(result.statementBalances).toEqual([
      { accountIban: IBAN.volksbankGiro, cents: 100000 + sum, date: '2026-10-02' },
    ]);
  });

  it('leitet bei leerem Namen die Gegenpartei aus dem Verwendungszweck ab', () => {
    const t = result.transactions.find((x) => x.bookingText === 'Abschluss');
    expect(t?.counterparty).toBe('Abrechnung 30.09.2026');
    expect(t?.bookingDate).toBe('2026-09-30');
  });
});

describe('volksbank-owl – Saldo-Prüfung', () => {
  it('meldet eine fehlende Zeile über die Saldo-Kette', () => {
    const result = parse('volksbank-owl/giro-saldo-luecke.csv');
    expect(result.transactions).toHaveLength(3);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/Saldo passt nicht zwischen Zeile \d+ und \d+/);
  });
});

describe('volksbank-owl – Visa (gleicher Parser)', () => {
  const result = parse('volksbank-owl/visa.csv');

  it('nimmt das Umsatzdatum aus „Umsatz vom“ als Buchungsdatum', () => {
    const t = result.transactions.find((x) => x.amountCents === -1525);
    expect(t).toMatchObject({ bookingDate: '2026-09-30', valueDate: '2026-10-01' });
  });

  it('leitet den Händler aus dem Verwendungszweck ab', () => {
    expect(result.transactions.map((t) => t.counterparty)).toEqual([
      'AUSGLEICH KARTENKONTO',
      'PAYPAL *STREAMINGDIENST',
      'JAHRESGEBUEHR VISA',
      'REWE MARKT GMBH',
    ]);
  });

  it('enthält das Auslandseinsatzentgelt im Betrag', () => {
    const t = result.transactions.find((x) => x.counterparty === 'PAYPAL *STREAMINGDIENST');
    expect(t?.amountCents).toBe(-1525);
    expect(t?.purpose).toContain('AUSLANDSUMS.');
  });

  it('nutzt den Buchungstag, wenn „Umsatz vom“ fehlt', () => {
    expect(result.transactions.find((x) => x.counterparty === 'JAHRESGEBUEHR VISA')?.bookingDate).toBe('2026-10-01');
  });

  it('liefert den negativen Saldo als offenen Kartenbetrag, Stichtag = Buchungstag', () => {
    expect(result.warnings).toEqual([]);
    expect(result.statementBalances).toEqual([{ accountIban: IBAN.volksbankVisa, cents: -13735, date: '2026-10-02' }]);
  });
});

describe('volksbank-owl – Sparkonto', () => {
  it('liest Zinsen ohne Gegenpartei-Namen', () => {
    const result = parse('volksbank-owl/sparkonto.csv');
    expect(result.transactions.map((t) => [t.bookingDate, t.amountCents, t.counterparty])).toEqual([
      ['2026-09-30', 42, 'Zinsen 3. Quartal'],
      ['2026-09-11', 10000, 'Max Mustermann'],
      ['2026-08-11', 10000, 'Max Mustermann'],
    ]);
  });
});

describe('volksbank-owl – mehrere Auftragskonten', () => {
  it('liefert die Auftragskonto-IBAN jeder Zeile und je Konto einen Saldo', () => {
    const result = parse('volksbank-owl/mehrere-konten.csv');
    expect(new Set(result.transactions.map((t) => t.accountIban))).toEqual(
      new Set([IBAN.volksbankGiro, IBAN.volksbankSpar]),
    );
    expect(result.statementBalances.map((b) => b.accountIban).sort()).toEqual(
      [IBAN.volksbankGiro, IBAN.volksbankSpar].sort(),
    );
    expect(result.warnings).toEqual([]);
  });
});

describe('volksbank-owl – falsche Dateien', () => {
  it('erkennt eine Comdirect-Datei nicht', () => {
    expect(volksbankOwlAdapter.detect(fixture('comdirect/girokonto.csv'))).toBe(false);
    expect(() => parse('comdirect/girokonto.csv')).toThrow(AdapterError);
  });

  it('meldet fehlende Kopfzeile mit Adapternamen', () => {
    const bytes = new TextEncoder().encode('irgendwas;anderes\r\n1;2\r\n');
    expect(() => volksbankOwlAdapter.parse(bytes)).toThrow('Volksbank-Adapter erkennt keine Kopfzeile.');
  });

  it('meldet Fußzeilen als ignoriert statt sie zu importieren', () => {
    const text = [
      '﻿Buchungstag;IBAN Auftragskonto;Name Zahlungsbeteiligter;Verwendungszweck;Betrag',
      `01.10.2026;${IBAN.volksbankGiro};Test;Zweck;-1,00`,
      ';;;Summe;-1,00',
    ].join('\r\n');
    const result = volksbankOwlAdapter.parse(new TextEncoder().encode(text));
    expect(result.transactions).toHaveLength(1);
    expect(result.ignored).toEqual([{ line: 3, reason: expect.stringContaining('kein Buchungstag') }]);
  });
});

describe('merchantFromPurpose', () => {
  it.each([
    ['PAYPAL *STREAMINGDIENST  GB  12345678901', 'PAYPAL *STREAMINGDIENST'],
    ['REWE MARKT GMBH  MUSTERSTADT  DE  Umsatz vom 28.09.2026', 'REWE MARKT GMBH'],
    ['HOTEL BEISPIEL FR 12345 Umsatz vom 01.09.2026', 'HOTEL BEISPIEL'],
    ['EINFACHER TEXT', 'EINFACHER TEXT'],
  ])('%s → %s', (purpose, merchant) => {
    expect(merchantFromPurpose(purpose)).toBe(merchant);
  });
});
