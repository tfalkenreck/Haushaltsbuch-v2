import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/connection.js';
import { buildApp } from '../src/app.js';
import { monthRange } from '../src/lib/date.js';
import { createAccount } from '../src/services/accounts.js';
import { getFunding, setFundingStart } from '../src/services/funding.js';
import { importFile } from '../src/services/imports.js';
import { createTestDb } from './helpers/db.js';
import { IBAN } from './helpers/fixtures.js';
import { volksbankCsv, type VbRow } from './helpers/volksbank-csv.js';

/*
 * Muster aus dem ersten Echtdaten-Test (synthetisch nachgebildet):
 * Bis April zehn Daueraufträge am 11. über zusammen 1.310,50 €, die
 * Abbuchungen liegen bei ca. 1.308 € (Miete läuft noch übers Ausgabenkonto).
 * Im Mai Umstellung: fünf Daueraufträge enden, drei ändern den Betrag –
 * zusammen 425 €; die Abbuchungen sinken auf ca. 386 €. Seit Mai ist jeder
 * Monat mit ca. 37 € gedeckt und der Kontostand steigt.
 */
const BEFORE = [50000, 30000, 20000, 10000, 8000, 5000, 4000, 2500, 1050, 500];
const AFTER = [null, null, 21000, 10000, null, 5000, 4500, 2000, null, null];
const REWE: Record<string, number> = {
  '2026-01': 15000,
  '2026-02': 14000,
  '2026-03': 16000,
  '2026-04': 15000,
  '2026-05': 18000,
  '2026-06': 19000,
  '2026-07': 17500,
  '2026-08': 18500,
  '2026-09': 18500,
};

function scenario(lastMonth: string): { giro: VbRow[]; ausgaben: VbRow[] } {
  const giro: VbRow[] = [];
  const ausgaben: VbRow[] = [];
  for (const month of monthRange('2026-01', lastMonth)) {
    const switched = month >= '2026-05';
    giro.push({ date: `${month}-01`, amountCents: 350000, counterparty: 'Arbeitgeber GmbH', bookingText: 'Gehalt', purpose: 'Lohn' });
    (switched ? AFTER : BEFORE).forEach((amount, i) => {
      if (amount === null) return;
      giro.push({
        date: `${month}-11`,
        amountCents: -amount,
        counterparty: 'Max Mustermann',
        counterpartyIban: IBAN.comdirectGiro,
        bookingText: 'Dauerauftrag',
        purpose: `Haushalt ${i + 1}`,
      });
      ausgaben.push({
        date: `${month}-11`,
        amountCents: amount,
        counterparty: 'Max Mustermann',
        counterpartyIban: IBAN.volksbankGiro,
        bookingText: 'Gutschrift',
        purpose: `Haushalt ${i + 1}`,
      });
    });
    if (!switched) ausgaben.push({ date: `${month}-01`, amountCents: -90000, counterparty: 'Vermieter Beispiel', purpose: `Miete ${month}` });
    else giro.push({ date: `${month}-01`, amountCents: -90000, counterparty: 'Vermieter Beispiel', purpose: `Miete ${month}` });
    ausgaben.push({ date: `${month}-02`, amountCents: -9000, counterparty: 'Stadtwerke Beispiel', purpose: 'Abschlag Strom' });
    ausgaben.push({ date: `${month}-05`, amountCents: -4800, counterparty: 'Beispiel Telefon GmbH', purpose: 'Rechnung' });
    ausgaben.push({
      date: `${month}-15`,
      amountCents: switched ? -5000 : -12000,
      counterparty: switched ? 'Muster Haftpflicht' : 'Muster Versicherung AG',
      purpose: 'Beitrag',
    });
    if (switched) ausgaben.push({ date: `${month}-07`, amountCents: -1500, counterparty: 'Beispiel Streaming', purpose: 'Abo' });
    ausgaben.push({ date: `${month}-20`, amountCents: -(REWE[month] as number), counterparty: 'REWE Markt', purpose: 'Einkauf' });
  }
  return { giro, ausgaben };
}

let db: Db;
let giro: number;
let ausgaben: number;

function load(lastMonth: string, periodEnd: string) {
  db = createTestDb();
  giro = createAccount(db, { name: 'Giro', role: 'einnahmen', bankAdapter: 'volksbank-owl', iban: IBAN.volksbankGiro }).id;
  ausgaben = createAccount(db, { name: 'Ausgaben', role: 'ausgaben', bankAdapter: 'volksbank-owl', iban: IBAN.comdirectGiro }).id;
  const data = scenario(lastMonth);
  importFile(db, { accountId: giro, fileName: 'giro.csv', bytes: volksbankCsv(IBAN.volksbankGiro, data.giro, 500000), periodStart: '2026-01-01', periodEnd });
  importFile(db, { accountId: ausgaben, fileName: 'ausgaben.csv', bytes: volksbankCsv(IBAN.comdirectGiro, data.ausgaben, 20000), periodStart: '2026-01-01', periodEnd });
}

describe('Deckungsprüfung nach einer Umstellung der Daueraufträge', () => {
  beforeEach(() => load('2026-09', '2026-09-30'));

  it('erkennt die Umstellung im Mai und wertet erst ab dann aus', () => {
    const f = getFunding(db, ausgaben, '2026-10-03');
    expect(f.standingOrdersTotalCents).toBe(42500);
    expect(f.standingOrders.filter((o) => !o.active)).toHaveLength(5);
    expect(f.standingOrders.flatMap((o) => o.changes.map((c) => [c.date, c.fromCents, c.toCents]))).toEqual(
      expect.arrayContaining([
        ['2026-05-11', 20000, 21000],
        ['2026-05-11', 4000, 4500],
        ['2026-05-11', 2500, 2000],
      ]),
    );
    expect(f.evaluation).toMatchObject({
      startMonth: '2026-05',
      source: 'switch',
      detectedSwitch: { month: '2026-05', fromCents: 131050, toCents: 42500 },
      manualStartMonth: null,
      basisMonths: ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'],
      sufficient: true,
    });
    // Die Monate davor bleiben in der Monatsübersicht sichtbar.
    expect(f.months.map((m) => [m.month, m.standingOrdersCents, m.expensesCents, m.differenceCents])).toEqual([
      ['2026-01', 131050, 130800, 250],
      ['2026-02', 131050, 129800, 1250],
      ['2026-03', 131050, 131800, -750],
      ['2026-04', 131050, 130800, 250],
      ['2026-05', 42500, 38300, 4200],
      ['2026-06', 42500, 39300, 3200],
      ['2026-07', 42500, 37800, 4700],
      ['2026-08', 42500, 38800, 3700],
      ['2026-09', 42500, 38800, 3700],
      ['2026-10', 0, 0, 0],
    ]);
  });

  it('empfiehlt keine Erhöhung, wenn seit der Umstellung jeder Monat gedeckt ist und der Saldo steigt', () => {
    const f = getFunding(db, ausgaben, '2026-10-03');
    expect(f.trend).toMatchObject({
      status: 'covered',
      deficitStreak: 0,
      windowMonths: ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'],
      deficitMonthsInWindow: 0,
      averageStandingOrdersCents: 42500,
      averageExpensesCents: 38600,
    });
    expect(f.balance.changeSince).toBe('2026-04');
    expect(f.balance.changeCents).toBe(4200 + 3200 + 4700 + 3700 + 3700);
    expect(f.recommendation).toMatchObject({
      basisMonths: 5,
      averageExpensesCents: 38600,
      minExpensesCents: 37800,
      maxExpensesCents: 39300,
      // 80.-Perzentil der Monatssummen (388,00) minus Durchschnitt (386,00).
      bufferCents: 200,
      allMonthsCovered: true,
      minSurplusCents: 3200,
      balanceFalling: false,
      verdict: 'fits',
      recommendedCents: 42500,
      currentCents: 42500,
      changeCents: 0,
    });
  });

  it('vergleicht bei „Was ist teurer geworden“ nur Monate seit der Umstellung', () => {
    const c = getFunding(db, ausgaben, '2026-10-03').causes;
    expect(c?.recentMonths).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(c?.referenceMonths).toEqual(['2026-05', '2026-06']);
    // Die umgezogene Miete und die alte Versicherung tauchen nicht als Veränderung auf.
    expect(c?.items).toEqual([]);
  });

  it('lässt den Startmonat von Hand überschreiben und wieder automatisch werden', () => {
    setFundingStart(db, ausgaben, '2026-01');
    const all = getFunding(db, ausgaben, '2026-10-03');
    expect(all.evaluation).toMatchObject({ startMonth: '2026-01', source: 'manual', manualStartMonth: '2026-01' });
    expect(all.evaluation.detectedSwitch?.month).toBe('2026-05');
    // Über alle Monate gemittelt entsteht genau der Fehler aus dem Echtdaten-Test: +885 €.
    expect(all.recommendation).toMatchObject({ verdict: 'increase', recommendedCents: 131000, changeCents: 88500 });

    setFundingStart(db, ausgaben, '2026-07');
    expect(getFunding(db, ausgaben, '2026-10-03').evaluation).toMatchObject({
      basisMonths: ['2026-07', '2026-08', '2026-09'],
      sufficient: true,
    });

    setFundingStart(db, ausgaben, null);
    expect(getFunding(db, ausgaben, '2026-10-03').evaluation).toMatchObject({ startMonth: '2026-05', source: 'switch' });
    expect(() => setFundingStart(db, ausgaben, '2026-13')).toThrow(/kein gültiger Monat/);
  });

  it('nimmt den Startmonat über die API entgegen', async () => {
    const app = buildApp({ db });
    const res = await app.inject({ method: 'PUT', url: `/api/accounts/${ausgaben}/funding/start`, payload: { month: '2026-06' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().evaluation).toMatchObject({ startMonth: '2026-06', source: 'manual' });
    const reset = await app.inject({ method: 'PUT', url: `/api/accounts/${ausgaben}/funding/start`, payload: { month: null } });
    expect(reset.json().evaluation).toMatchObject({ startMonth: '2026-05', source: 'switch' });
    const bad = await app.inject({ method: 'PUT', url: `/api/accounts/${ausgaben}/funding/start`, payload: { month: 'Mai' } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});

describe('Deckungsprüfung kurz nach einer Umstellung', () => {
  it('sagt offen, dass zwei Monate seit der Umstellung nicht reichen', () => {
    load('2026-06', '2026-06-30');
    const f = getFunding(db, ausgaben, '2026-07-03');
    expect(f.evaluation).toMatchObject({ startMonth: '2026-05', basisMonths: ['2026-05', '2026-06'], sufficient: false });
    expect(f.recommendation).toBeNull();
    expect(f.causes).toBeNull();
    expect(f.trend).toMatchObject({ status: 'covered', windowMonths: ['2026-05', '2026-06'] });
  });

  it('erkennt die Umstellung auch im laufenden, teilweise importierten Monat', () => {
    load('2026-05', '2026-05-20');
    const f = getFunding(db, ausgaben, '2026-05-20');
    expect(f.evaluation).toMatchObject({ startMonth: '2026-05', basisMonths: [], sufficient: false });
    expect(f.trend.status).toBe('unknown');
  });
});
