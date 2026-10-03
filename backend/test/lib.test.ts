import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/lib/csv.js';
import { addDays, monthRange, parseGermanDate } from '../src/lib/date.js';
import { parseGermanAmount } from '../src/lib/money.js';
import { normalizeCounterparty } from '../src/lib/normalize.js';
import { decodeText } from '../src/lib/text.js';

describe('parseGermanAmount', () => {
  it.each([
    ['-7,75', -775],
    ['-1.234,56', -123456],
    ['1.234.567,89', 123456789],
    ['250,00', 25000],
    ['+3,20', 320],
    ['12', 1200],
    ['7,5', 750],
    ['0,00', 0],
    ['-0,01', -1],
    [' -27,88 ', -2788],
  ])('%s → %i Cent', (input, cents) => {
    expect(parseGermanAmount(input)).toBe(cents);
  });

  it('rechnet ohne Float-Rundungsfehler', () => {
    // 0,29 * 100 wäre als Float 28.999999999999996
    expect(parseGermanAmount('0,29')).toBe(29);
    expect(parseGermanAmount('1.000.000,07')).toBe(100000007);
  });

  it.each(['', 'abc', '1,234', '1.23,45', '12,345', '1.2345,00', '--1,00'])('lehnt „%s“ ab', (input) => {
    expect(parseGermanAmount(input)).toBeNull();
  });
});

describe('Datum', () => {
  it('wandelt TT.MM.JJJJ in ISO um', () => {
    expect(parseGermanDate('02.10.2026')).toBe('2026-10-02');
    expect(parseGermanDate('29.02.2028')).toBe('2028-02-29');
  });

  it('lehnt ungültige Tage ab', () => {
    expect(parseGermanDate('31.09.2026')).toBeNull();
    expect(parseGermanDate('29.02.2026')).toBeNull();
    expect(parseGermanDate('offen')).toBeNull();
    expect(parseGermanDate('2026-10-02')).toBeNull();
  });

  it('rechnet mit Tagen und Monaten', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(monthRange('2026-11-15', '2027-02-01')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });
});

describe('decodeText', () => {
  it('entfernt das BOM bei UTF-8', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x42, 0xc3, 0xa4]);
    expect(decodeText(bytes, 'utf-8')).toBe('Bä');
  });

  it('dekodiert Windows-1252 und ISO-8859-1 explizit', () => {
    // „Übertrag – 5 €“ in Windows-1252: Ü=0xDC, –=0x96, €=0x80
    const cp1252 = new Uint8Array([0xdc, 0x62, 0x20, 0x96, 0x20, 0x35, 0x20, 0x80]);
    expect(decodeText(cp1252, 'windows-1252')).toBe('Üb – 5 €');
    expect(decodeText(new Uint8Array([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]), 'iso-8859-1')).toBe('Müller');
  });

  it('wirft bei ungültigem UTF-8 statt still zu raten', () => {
    expect(() => decodeText(new Uint8Array([0x4d, 0xfc, 0x6c]), 'utf-8')).toThrow();
  });
});

describe('parseCsv', () => {
  it('trennt an Semikolons und beachtet Anführungszeichen', () => {
    const rows = parseCsv('a;"b;c";"d ""e"""\r\nf;g;h\r\n');
    expect(rows.map((r) => r.fields)).toEqual([
      ['a', 'b;c', 'd "e"'],
      ['f', 'g', 'h'],
    ]);
  });

  it('erlaubt Zeilenumbrüche in Feldern und zählt Zeilennummern richtig', () => {
    const rows = parseCsv('kopf;x\r\n"zeile\r\nzwei";1\r\n\r\nende;2');
    expect(rows).toEqual([
      { line: 1, fields: ['kopf', 'x'] },
      { line: 2, fields: ['zeile\nzwei', '1'] },
      { line: 4, fields: [''] },
      { line: 5, fields: ['ende', '2'] },
    ]);
  });

  it('behält das leere Feld nach einem Semikolon am Zeilenende', () => {
    expect(parseCsv('"a";"b";\n')[0]?.fields).toEqual(['a', 'b', '']);
  });
});

describe('normalizeCounterparty', () => {
  it('führt Schreibweisen mit und ohne Leerzeichen um Sonderzeichen zusammen', () => {
    expect(normalizeCounterparty('B+V Lebensversicherung AG')).toBe(normalizeCounterparty('B + V LEBENSVERSICHERUNG AG'));
  });

  it('entfernt Rechtsformen in Kurz- und Langform', () => {
    expect(normalizeCounterparty('Beispiel Versicherung Aktiengesellschaft')).toBe('beispiel versicherung');
    expect(normalizeCounterparty('Beispiel Versicherung AG')).toBe('beispiel versicherung');
    expect(normalizeCounterparty('Beispiel Lotterie Gesellschaft mit beschränkter Haftung')).toBe('beispiel lotterie');
    expect(normalizeCounterparty('Beispiel Lotterie GmbH')).toBe('beispiel lotterie');
    expect(normalizeCounterparty('Sportverein Musterstadt e.V.')).toBe('sportverein musterstadt');
    expect(normalizeCounterparty('Muster GmbH & Co. KG')).toBe('muster');
    expect(normalizeCounterparty('Beispiel SE')).toBe('beispiel');
  });

  it('streicht Zusätze wie „Niederlassung Luxemburg“', () => {
    expect(normalizeCounterparty('B+V Lebensversicherung AG Niederlassung Luxemburg')).toBe('b v lebensversicherung');
    expect(normalizeCounterparty('B + V LEBENSVERSICHERUNG AKTIENGESELLSCHAFT')).toBe('b v lebensversicherung');
  });

  it('ignoriert Groß-/Kleinschreibung', () => {
    expect(normalizeCounterparty('SUPERMARKT Beispiel')).toBe(normalizeCounterparty('supermarkt BEISPIEL'));
  });

  it('entfernt Ziffernfolgen, Referenz- und Datumsangaben auch mit Leerzeichen', () => {
    expect(normalizeCounterparty('Stadtwerke 01. 11.2026 RE-4711 0A0B0C')).toBe('stadtwerke');
    expect(normalizeCounterparty('PAYPAL *STREAMINGDIENST')).toBe('paypal streamingdienst');
  });

  it('schreibt Umlaute um, damit ASCII-Umschrift gleich ist', () => {
    expect(normalizeCounterparty('Bäckerei Müller')).toBe(normalizeCounterparty('BAECKEREI MUELLER'));
  });

  it('lässt Wörter stehen, die nur Rechtsformen enthalten', () => {
    expect(normalizeCounterparty('Agentur Segler')).toBe('agentur segler');
  });
});
