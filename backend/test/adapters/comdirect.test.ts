import { describe, expect, it } from 'vitest';
import { comdirectAdapter, splitComdirectText } from '../../src/adapters/comdirect.js';
import { fixture } from '../helpers/fixtures.js';

const parse = (path: string) => comdirectAdapter.parse(fixture(path));

describe('Comdirect-Fixtures', () => {
  it('liegen wirklich in Windows-1252 vor', () => {
    const bytes = Buffer.from(fixture('comdirect/girokonto.csv'));
    expect(bytes.includes(Buffer.from([0xe4]))).toBe(true); // ä
    expect(bytes.includes(Buffer.from([0xc3, 0xa4]))).toBe(false); // kein UTF-8-ä
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe('comdirect – Girokonto', () => {
  const result = parse('comdirect/girokonto.csv');

  it('liest alle Zeilen trotz Semikolon am Zeilenende', () => {
    expect(result.transactions).toHaveLength(6);
    expect(result.ignored).toEqual([]);
    expect(result.statementBalances).toEqual([]);
  });

  it('zerlegt den Buchungstext in Gegenpartei, Zweck und Referenz', () => {
    expect(result.transactions[0]).toMatchObject({
      bookingDate: '2026-10-02',
      valueDate: '2026-10-02',
      amountCents: -2788,
      currency: 'EUR',
      counterparty: 'Beispiel Versicherung Aktiengesellschaft',
      purpose: 'BEITRAG 00/000000000 10/26',
      bankReference: '0A0B0C0D0E0F0G0H/0000',
      bookingText: 'Lastschrift / Belastung',
      balanceAfterCents: null,
      counterpartyIban: null,
    });
  });

  it('dekodiert Umlaute aus Windows-1252', () => {
    expect(result.transactions[5]?.counterparty).toBe('Beispiel Lotterie Gesellschaft mit beschränkter Haftung');
  });

  it('setzt bei Bankentgelten die Bank als Gegenpartei und behält den Zeitraum im Zweck', () => {
    expect(result.transactions[1]).toMatchObject({
      counterparty: 'comdirect',
      bookingText: 'Kontoführungsentgelt',
      purpose: 'Entgelt Visa-Kreditkarte Zeitraum: 01.09.2026 bis 30.09.2026',
      valueDate: '2026-09-30',
    });
    expect(result.transactions[2]).toMatchObject({ counterparty: 'comdirect', bookingText: 'Entgelte', amountCents: -9 });
  });

  it('behält Datumsangaben mit Leerzeichen im Verwendungszweck', () => {
    expect(result.transactions[4]?.purpose).toBe('0000000 Tarif Plus lfd. Btr OP00000000 01.10.2026 - 01. 11.2026');
  });
});

describe('comdirect – Metadaten, vorgemerkte Umsätze, Fußzeilen', () => {
  const result = parse('comdirect/mit-metadaten.csv');

  it('sucht die Kopfzeile hinter den Metadaten', () => {
    expect(result.transactions.map((t) => t.amountCents)).toEqual([-5000, 123456, -10000]);
  });

  it('importiert „offen“-Zeilen nicht, sondern meldet sie', () => {
    expect(result.pending).toEqual([{ line: 6, reason: expect.stringContaining('Beispiel Streaming') }]);
  });

  it('übernimmt den neuen Kontostand aus den Metadaten', () => {
    expect(result.statementBalances).toEqual([{ accountIban: null, cents: 123456, date: null }]);
  });

  it('ignoriert die Fußzeile nach der Tabelle und meldet sie', () => {
    expect(result.ignored).toEqual([{ line: 13, reason: expect.stringContaining('Alter Kontostand') }]);
  });

  it('liest Empfänger und Gegen-IBAN, Semikolon und Zeilenumbruch im Buchungstext', () => {
    expect(result.transactions[0]).toMatchObject({
      counterparty: 'Erika Musterfrau',
      counterpartyIban: 'DE02120300000000202051',
      purpose: 'Geschenk; danke für alles',
      bookingText: 'Übertrag / Überweisung',
    });
    expect(result.transactions[1]).toMatchObject({
      counterparty: 'Max Mustermann',
      purpose: 'Dauerauftrag\nAusgabenkonto',
      amountCents: 123456,
    });
  });
});

describe('comdirect – falsche Datei', () => {
  it('erkennt eine Volksbank-Datei nicht', () => {
    expect(comdirectAdapter.detect(fixture('volksbank-owl/giro.csv'))).toBe(false);
    expect(() => parse('volksbank-owl/giro.csv')).toThrow('Comdirect-Adapter erkennt keine Kopfzeile.');
  });

  it('meldet eine zweite Tabelle hinter der ersten', () => {
    const text = [
      '"Buchungstag";"Wertstellung (Valuta)";"Vorgang";"Buchungstext";"Umsatz in EUR";',
      '"01.10.2026";"01.10.2026";"Entgelte";" Buchungstext: Test";"-1,00";',
      '',
      '"Umsätze Visa-Karte";',
      '"Buchungstag";"Umsatztag";"Vorgang";"Referenz";"Buchungstext";"Umsatz in EUR";',
      '"30.09.2026";"29.09.2026";"Visa-Umsatz";"X";"Händler";"-5,00";',
    ].join('\r\n');
    const result = comdirectAdapter.parse(new TextEncoder().encode(text));
    expect(result.transactions).toHaveLength(1);
    expect(result.ignored.map((i) => i.line)).toEqual([4, 5, 6]);
    expect(result.warnings).toEqual(['Ab Zeile 5 folgt eine weitere Tabelle – nur die erste wurde gelesen.']);
  });
});

describe('splitComdirectText', () => {
  it('lässt unbekannte Labels im Verwendungszweck', () => {
    expect(splitComdirectText('Auftraggeber: Firma X Buchungstext: Zweck Mandat: M-1 Ref. R/1')).toEqual({
      counterparty: 'Firma X',
      counterpartyIban: null,
      purpose: 'Zweck Mandat: M-1',
      reference: 'R/1',
    });
  });

  it('behält Text vor dem ersten Label', () => {
    expect(splitComdirectText('Bargeld Automat 4711 Buchungstext: Auszahlung').purpose).toBe(
      'Bargeld Automat 4711 Auszahlung',
    );
  });

  it('übernimmt eine ungültige Kontonummer in den Zweck statt sie zu verlieren', () => {
    expect(splitComdirectText('Empfänger: A Kto/IBAN: 12345 Buchungstext: B')).toMatchObject({
      counterparty: 'A',
      counterpartyIban: null,
      purpose: 'Kto/IBAN: 12345 B',
    });
  });
});
