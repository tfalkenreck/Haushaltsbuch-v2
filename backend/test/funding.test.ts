import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/connection.js';
import { createAccount, getAccount } from '../src/services/accounts.js';
import { deleteManualBalance, setManualBalance } from '../src/services/balances.js';
import { listBypass, setBypassDecision, type BypassItem } from '../src/services/bypass.js';
import { getFunding } from '../src/services/funding.js';
import { importFile } from '../src/services/imports.js';
import { createTestDb } from './helpers/db.js';
import { fixture, IBAN } from './helpers/fixtures.js';

/*
 * Fixtures deckung/*.csv (synthetisch), Mai–September 2026:
 * - Einnahmenkonto: am 11. vier Daueraufträge aufs Ausgabenkonto (10, 60, 10, 100 €;
 *   im Juli am 13., weil der 11. ein Samstag ist; ab September 70 statt 60 €),
 *   am 20. ein weiterer über 25 €. Dazu Miete, Telefon, bis Juli eine Hausrat-
 *   versicherung, Bargeld und ein einmaliger Kauf.
 * - Ausgabenkonto (ohne Saldo): Strom 60 €, Versicherung 27,88 €, Streaming
 *   9,99 € → ab Juli 17,99 €, REWE schwankend, ab August Fitnessstudio 29,90 €
 *   und die Hausratversicherung 12,50 € (umgestellt), eine Erstattung im Juni.
 */
const TODAY = '2026-10-03';

let db: Db;
let giro: number;
let ausgaben: number;

beforeEach(() => {
  db = createTestDb();
  giro = createAccount(db, { name: 'Giro', role: 'einnahmen', bankAdapter: 'volksbank-owl', iban: IBAN.volksbankGiro }).id;
  ausgaben = createAccount(db, { name: 'Ausgaben', role: 'ausgaben', bankAdapter: 'comdirect', iban: IBAN.comdirectGiro }).id;
  for (const [accountId, path] of [
    [giro, 'deckung/giro.csv'],
    [ausgaben, 'deckung/comdirect.csv'],
  ] as const) {
    importFile(db, { accountId, fileName: path, bytes: fixture(path), periodStart: '2026-05-01', periodEnd: '2026-09-30' });
  }
});

describe('Deckungsprüfung', () => {
  it('erkennt mehrere Daueraufträge einzeln, auch gleiche am selben Tag, mit Änderungen', () => {
    const f = getFunding(db, ausgaben, TODAY);
    const orders = f.standingOrders.map((o) => ({
      day: o.dayOfMonth,
      amount: o.amountCents,
      count: o.occurrences.length,
      from: o.sourceAccountName,
      active: o.active,
      changes: o.changes,
    }));
    expect(orders).toEqual([
      { day: 11, amount: 10000, count: 5, from: 'Giro', active: true, changes: [] },
      { day: 11, amount: 7000, count: 5, from: 'Giro', active: true, changes: [{ date: '2026-09-11', fromCents: 6000, toCents: 7000 }] },
      { day: 11, amount: 1000, count: 5, from: 'Giro', active: true, changes: [] },
      { day: 11, amount: 1000, count: 5, from: 'Giro', active: true, changes: [] },
      { day: 20, amount: 2500, count: 5, from: 'Giro', active: true, changes: [] },
    ]);
    // Juli: am 13. ausgeführt, zählt zum Termin am 11.
    expect(f.standingOrders[0]?.occurrences.map((o) => o.date)).toContain('2026-07-13');
    expect(f.standingOrdersTotalCents).toBe(21500);
    expect(f.extraTransferCount).toBe(0);
  });

  it('summiert pro Monat Daueraufträge und Abbuchungen ohne Umbuchungen und bildet die Differenz', () => {
    const f = getFunding(db, ausgaben, TODAY);
    const months = f.months.map((m) => [m.month, m.status, m.standingOrdersCents, m.expensesCents, m.differenceCents]);
    expect(months).toEqual([
      ['2026-05', 'complete', 20500, 17787, 2713],
      ['2026-06', 'complete', 20500, 17787, 2713],
      ['2026-07', 'complete', 20500, 25587, -5087],
      ['2026-08', 'complete', 20500, 26827, -6327],
      ['2026-09', 'complete', 21500, 28827, -7327],
      ['2026-10', 'missing', 0, 0, 0],
    ]);
    expect(f.months[1]).toMatchObject({ debitsCents: 19287, creditsCents: 1500 });
  });

  it('zeigt den Verlauf: drei Unterdeckungen in Folge sind ein Trend, und sie wächst', () => {
    expect(getFunding(db, ausgaben, TODAY).trend).toMatchObject({
      status: 'trend',
      deficitStreak: 3,
      deficitSince: '2026-07',
      direction: 'growing',
      deficitMonthsInWindow: 3,
      windowMonths: ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'],
    });
  });

  it('empfiehlt einen Dauerauftrag mit Puffer für schwankende Posten', () => {
    const r = getFunding(db, ausgaben, TODAY).recommendation;
    // Durchschnitt (177,87 + 177,87 + 255,87 + 268,27 + 288,27) / 5 = 233,63;
    // 80.-Perzentil 268,27 → Puffer 34,64; aufgerundet auf 270,00 €.
    expect(r).toMatchObject({
      basisMonths: 5,
      averageExpensesCents: 23363,
      bufferCents: 3464,
      plannedMovesCents: 0,
      recommendedCents: 27000,
      currentCents: 21500,
      changeCents: 5500,
    });
    expect(r?.fluctuating.map((i) => i.label)).toEqual(['REWE Markt GmbH; Musterstadt', 'Fitnessstudio Beispiel', 'Muster Versicherung AG']);
  });

  it('benennt die gestiegenen Posten: teurer, neu, Preiserhöhung', () => {
    const causes = getFunding(db, ausgaben, TODAY).causes;
    expect(causes?.recentMonths).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(causes?.referenceMonths).toEqual(['2026-05', '2026-06']);
    expect(causes?.totalChangeCents).toBe(27080 - 17787);
    expect(causes?.items.map((i) => [i.label, i.beforeCents, i.recentCents, i.increaseCents, i.isNew])).toEqual([
      ['REWE Markt GmbH; Musterstadt', 8750, 13667, 4917, false],
      ['Fitnessstudio Beispiel', 0, 1993, 1993, true],
      ['Muster Versicherung AG', 0, 833, 833, true],
      ['Beispiel Streaming GmbH', 999, 1799, 800, false],
    ]);
    expect(causes?.items[3]?.priceChange).toEqual({ date: '2026-07-07', fromCents: 999, toCents: 1799 });
    expect(causes?.items[0]?.priceChange).toBeNull();
  });

  it('rechnet den Saldo aus einem von Hand erfassten Kontostand über die Buchungen', () => {
    const before = getFunding(db, ausgaben, TODAY);
    expect(before.hasBankBalances).toBe(false);
    expect(before.balance.status).toBe('unknown');

    const manual = setManualBalance(db, ausgaben, { date: '2026-09-30', amount: '150,00' });
    const f = getFunding(db, ausgaben, TODAY);
    expect(f.months.map((m) => m.balanceEndCents)).toEqual([31028, 33741, 28654, 22327, 15000, null]);
    expect(f.balance).toMatchObject({
      status: 'cushion',
      current: { balanceCents: 15000, date: '2026-09-30', source: 'manual' },
      // Unterdeckung im Schnitt 62,47 € → das Polster reicht noch 2 Monate.
      runwayMonths: 2,
      lowestCents: 15000,
      lowestMonth: '2026-09',
      changeCents: 15000 - 31028,
      changeSince: '2026-05',
    });
    expect(getAccount(db, ausgaben)).toMatchObject({ balanceCents: 15000, balanceSource: 'manual' });

    // Ein Stand mitten im Zeitraum: rückwärts und vorwärts gerechnet.
    deleteManualBalance(db, manual.id);
    setManualBalance(db, ausgaben, { date: '2026-07-31', amount: '-10,00' });
    const g = getFunding(db, ausgaben, TODAY);
    expect(g.months.map((m) => m.balanceEndCents)).toEqual([1374, 4087, -1000, -7327, -14654, null]);
    expect(g.balance).toMatchObject({ status: 'negative', runwayMonths: null });
  });

  it('nimmt bei Volksbank-Konten die Salden der Buchungen', () => {
    const f = getFunding(db, giro, TODAY);
    expect(f.hasBankBalances).toBe(true);
    expect(f.balance.current).toMatchObject({ balanceCents: 862855, date: '2026-09-25', source: 'bank' });
    expect(f.months[4]?.balanceEndCents).toBe(862855);
  });

  it('lehnt ungültige Kontostände ab', () => {
    expect(() => setManualBalance(db, ausgaben, { date: '2026-02-30', amount: '1,00' })).toThrow(/kein gültiges Datum/);
    expect(() => setManualBalance(db, ausgaben, { date: '2026-09-30', amount: '1.5' })).toThrow(/kein Betrag/);
  });
});

describe('Ausgaben am Ausgabenkonto vorbei', () => {
  const item = (label: string) => listBypass(db).items.find((i) => i.label === label) as BypassItem;

  it('listet wiederkehrende Abbuchungen vom Einnahmenkonto mit Betrag und Intervall', () => {
    const overview = listBypass(db);
    expect(overview.items.map((i) => [i.label, i.interval, i.lastAmountCents, i.status])).toEqual([
      ['Vermieter Beispiel', 'monthly', 95000, 'active'],
      ['Beispiel Telefon GmbH', 'monthly', 3999, 'active'],
      ['Muster Versicherung AG', 'monthly', 1250, 'switched'],
    ]);
    // Bargeld, Umbuchungen und Einmaliges sind keine Kandidaten.
    expect(item('Muster Versicherung AG').switchedTo).toEqual({ accountId: ausgaben, accountName: 'Ausgaben', date: '2026-08-15' });
    expect(overview.targets).toEqual([{ id: ausgaben, name: 'Ausgaben' }]);
  });

  it('merkt sich die Entscheidung und rechnet aus, um wie viel der Dauerauftrag steigen müsste', () => {
    const telefon = item('Beispiel Telefon GmbH');
    setBypassDecision(db, { sourceAccountId: giro, key: telefon.key, decision: 'move' });
    setBypassDecision(db, { sourceAccountId: giro, key: item('Vermieter Beispiel').key, decision: 'keep' });

    const overview = listBypass(db);
    expect(overview.items.map((i) => [i.label, i.decision, i.targetAccountName])).toEqual([
      ['Vermieter Beispiel', 'keep', null],
      ['Beispiel Telefon GmbH', 'move', 'Ausgaben'],
      ['Muster Versicherung AG', null, null],
    ]);
    expect(overview.plannedIncreases).toEqual([{ accountId: ausgaben, accountName: 'Ausgaben', count: 1, monthlyCents: 3999 }]);

    // Fließt in die Empfehlung ein: 233,63 + 34,64 + 39,99 = 308,26 → 310,00 €.
    const r = getFunding(db, ausgaben, TODAY).recommendation;
    expect(r).toMatchObject({ plannedMovesCents: 3999, recommendedCents: 31000, changeCents: 9500 });

    setBypassDecision(db, { sourceAccountId: giro, key: telefon.key, decision: null });
    expect(item('Beispiel Telefon GmbH').decision).toBeNull();
    expect(listBypass(db).plannedIncreases).toEqual([]);
  });

  it('zählt einen umgestellten Posten nicht doppelt', () => {
    const versicherung = item('Muster Versicherung AG');
    setBypassDecision(db, { sourceAccountId: giro, key: versicherung.key, decision: 'move' });
    // Schon auf dem Ausgabenkonto angekommen: steckt in den Abbuchungen, nicht zusätzlich in der Empfehlung.
    expect(listBypass(db).plannedIncreases).toEqual([]);
    expect(getFunding(db, ausgaben, TODAY).recommendation?.plannedMovesCents).toBe(0);
  });
});
