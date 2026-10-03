import { describe, expect, it } from 'vitest';
import { addDays, addMonths } from '../src/lib/date.js';
import { normalizeCounterparty } from '../src/lib/normalize.js';
import { containsWords, contractKey, effectiveCounterparty, providerKey, recurringLabel } from '../src/lib/recurring-key.js';
import { detectRecurring, type DetectDebit } from '../src/services/recurring-detection.js';

let nextId = 1;
function debit(date: string, euros: number, key: string, extra: Partial<DetectDebit> = {}): DetectDebit {
  return {
    transactionId: nextId++,
    accountId: 1,
    date,
    amountCents: -Math.round(euros * 100),
    contractKey: key,
    providerKey: key,
    label: key,
    text: '',
    viaCardOrIntermediary: false,
    categoryId: null,
    ...extra,
  };
}

/** `count` Abbuchungen ab `start` im Abstand von `months` Monaten. */
function series(start: string, count: number, euros: number | number[], key: string, months = 1, extra: Partial<DetectDebit> = {}) {
  return Array.from({ length: count }, (_, i) =>
    debit(addMonths(start, i * months), Array.isArray(euros) ? (euros[i] as number) : euros, key, extra),
  );
}

const END = new Map([[1, '2026-09-30']]);

describe('Schlüssel für Fixkosten und Abos', () => {
  const tx = (counterparty: string, purpose: string, creditorId: string | null = null, mandateReference: string | null = null) => ({
    counterparty,
    counterpartyNormalized: normalizeCounterparty(counterparty),
    purpose,
    creditorId,
    mandateReference,
  });

  it('führt PayPal per Lastschrift und per Karte auf denselben Händler zusammen', () => {
    const lastschrift = tx(
      'PayPal Europe S.a.r.l. et Cie S.C.A',
      '1040000000001 PP.1234.PP . Audible Ltd, Ihr Einkauf bei Audible Ltd',
      'LU96ZZZ0000000000000000058',
      'PAYPALMANDAT1',
    );
    const karte = tx('PAYPAL *AUDIBLE', 'PAYPAL *AUDIBLE  GB  12345678901   EUR  9,95 Umsatz vom 20.05.2026');
    expect(effectiveCounterparty(lastschrift)).toBe('paypal audible');
    expect(effectiveCounterparty(karte)).toBe('paypal audible');
    // Gläubiger-ID und Mandat von PayPal sind für alle Einkäufe gleich – kein Schlüssel.
    expect(contractKey(lastschrift)).toBe('cp:paypal audible');
    expect(contractKey(karte)).toBe('cp:paypal audible');
    expect(recurringLabel(lastschrift)).toBe('PayPal: Audible Ltd');
  });

  it('bevorzugt die Gläubiger-ID vor der Schreibweise und trennt Verträge über die Mandatsreferenz', () => {
    const a = tx('Muster Versicherung AG', 'Hausrat', 'DE11ZZZ00000000001', 'M-HAUS-1');
    const b = tx('MUSTER VERSICHERUNG', 'Kfz', 'de11zzz00000000001', 'M-KFZ-2');
    expect(providerKey(a)).toBe(providerKey(b));
    expect(contractKey(a)).toBe('cid:DE11ZZZ00000000001|m:M-HAUS-1');
    expect(contractKey(b)).toBe('cid:DE11ZZZ00000000001|m:M-KFZ-2');
    expect(providerKey(tx('Stadtwerke Beispiel GmbH', 'Abschlag'))).toBe('cp:stadtwerke beispiel');
  });

  it('vergleicht Gegenparteien wortweise', () => {
    expect(containsWords('paypal ring', 'ring')).toBe(true);
    expect(containsWords('paypal ringo', 'ring')).toBe(false);
    expect(containsWords('anything', '')).toBe(false);
  });
});

describe('Erkennung wiederkehrender Abbuchungen', () => {
  it('erkennt monatliche Abbuchungen trotz Wochenenden und schwankender Beträge', () => {
    const telefon = [
      debit('2026-01-05', 35.1, 'tel'),
      debit('2026-02-06', 41.77, 'tel'),
      debit('2026-03-05', 38, 'tel'),
      debit('2026-04-07', 52.4, 'tel'),
      debit('2026-05-05', 36.9, 'tel'),
    ];
    const [s, ...rest] = detectRecurring(telefon, END);
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ key: 'tel', interval: 'monthly', count: 5, lastAmountCents: 3690, ended: true, suspected: false });
  });

  it('erkennt 14-tägig, quartalsweise, halbjährlich und jährlich', () => {
    const biweekly = Array.from({ length: 6 }, (_, i) => debit(addDays('2026-06-05', 14 * i), 20, 'zwei'));
    const quarterly = series('2026-01-15', 3, 45, 'wasser', 3);
    const semiannual = series('2025-09-01', 3, 120, 'halb', 6);
    const annual = series('2024-11-01', 2, 300, 'jahr', 12);
    const result = detectRecurring([...biweekly, ...quarterly, ...semiannual, ...annual], new Map([[1, '2026-09-30']]));
    expect(Object.fromEntries(result.map((s) => [s.key, s.interval]))).toEqual({
      zwei: 'biweekly',
      wasser: 'quarterly',
      halb: 'semiannual',
      jahr: 'annual',
    });
    expect(result.find((s) => s.key === 'zwei')).toMatchObject({ count: 6, monthlyCents: 4333 });
  });

  it('erlaubt eine fehlende Abbuchung, aber nicht nur doppelte Abstände', () => {
    const gap = [debit('2026-01-10', 10, 'a'), debit('2026-02-10', 10, 'a'), debit('2026-04-10', 10, 'a'), debit('2026-05-10', 10, 'a')];
    expect(detectRecurring(gap, END)[0]).toMatchObject({ interval: 'monthly', count: 4 });
    // Zwei Abbuchungen im Halbjahresabstand sind kein Quartals-Abo mit Lücke.
    const twice = [debit('2026-01-10', 10, 'b'), debit('2026-07-10', 10, 'b')];
    expect(detectRecurring(twice, END)[0]).toMatchObject({ interval: 'semiannual' });
  });

  it('meldet Preiserhöhungen und beendete Abos', () => {
    const streaming = series('2026-01-07', 9, [9.99, 9.99, 9.99, 9.99, 9.99, 12.99, 12.99, 12.99, 12.99], 'stream');
    const fitness = series('2026-01-03', 5, 29.9, 'fit');
    const result = detectRecurring([...streaming, ...fitness], END);
    expect(result.find((s) => s.key === 'stream')).toMatchObject({
      ended: false,
      priceChange: { date: '2026-06-07', fromCents: 999, toCents: 1299 },
      nextDueDate: '2026-10-07',
    });
    expect(result.find((s) => s.key === 'fit')).toMatchObject({ ended: true, lastDate: '2026-05-03' });
  });

  it('trennt zwei Abos beim selben Anbieter und lässt einmalige Käufe außen vor', () => {
    const first = series('2026-03-08', 6, 10.99, 'cp:spotify');
    const second = series('2026-03-22', 6, 10.99, 'cp:spotify');
    const oneOff = [debit('2026-04-15', 49.9, 'cp:spotify'), debit('2026-07-01', 5, 'cp:spotify')];
    const result = detectRecurring([...first, ...second, ...oneOff], END);
    expect(result.map((s) => [s.key, s.count])).toEqual([
      ['cp:spotify', 6],
      ['cp:spotify@d22', 6],
    ]);
  });

  it('erkennt beim Supermarkt keine Zufallsketten, aber ein festes Abo zwischen Einkäufen', () => {
    const amounts = [23.45, 67.8, 41.2, 88.15, 12.3, 55.55, 31.9, 74.05, 19.99, 46.6, 63.35, 28.7, 92.4, 37.15, 58.8, 15.25, 81.1, 44.4];
    const rewe = amounts.map((a, i) => debit(addDays('2026-01-02', i * 10), a, 'cp:rewe markt'));
    expect(detectRecurring(rewe, END)).toEqual([]);

    const prime = series('2026-01-12', 8, 8.99, 'cp:amazon');
    const purchases = amounts.slice(0, 12).map((a, i) => debit(addDays('2026-01-04', i * 18), a, 'cp:amazon'));
    expect(detectRecurring([...prime, ...purchases], END).map((s) => [s.key, s.count, s.lastAmountCents])).toEqual([['cp:amazon', 8, 899]]);
  });

  it('gruppiert ein zweites Mal je Anbieter, wenn die Mandatsreferenz wechselt', () => {
    const list = ['A1', 'A2', 'A3', 'A4'].map((m, i) =>
      debit(addMonths('2026-03-15', i), 19.9, `cid:DE99ZZZ1|m:${m}`, { providerKey: 'cid:DE99ZZZ1' }),
    );
    expect(detectRecurring(list, END).map((s) => [s.key, s.count])).toEqual([['cid:DE99ZZZ1', 4]]);
  });

  it('vermutet einen einzelnen Jahresbeitrag als jährlich', () => {
    const adac = debit('2026-03-02', 94, 'cp:adac', { text: 'Lastschrift Jahresbeitrag 2026 Mitgliedsnr 123' });
    const old = debit('2025-06-02', 50, 'cp:verein', { text: 'Jahresbeitrag 2025' });
    const plain = debit('2026-03-03', 400, 'cp:kfz', { text: 'Beitrag' });
    expect(detectRecurring([adac, old, plain], END)).toEqual([
      expect.objectContaining({ key: 'cp:adac', interval: 'annual', count: 1, suspected: true, nextDueDate: '2027-03-02', monthlyCents: 783 }),
    ]);
  });
});
