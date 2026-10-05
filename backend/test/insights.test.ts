import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/connection.js';
import { monthRange } from '../src/lib/date.js';
import { createAccount } from '../src/services/accounts.js';
import { getAttention, type AttentionItem } from '../src/services/attention.js';
import { getBudget } from '../src/services/budget.js';
import { completeMonthsBefore, completenessIndex } from '../src/services/completeness.js';
import { getForecast } from '../src/services/forecast.js';
import { importFile } from '../src/services/imports.js';
import { detectIncome } from '../src/services/income.js';
import { getMonthOverview } from '../src/services/overview.js';
import { createRecurringItem } from '../src/services/recurring.js';
import { createRule } from '../src/services/rules.js';
import { createSavingsGoal, deleteSavingsGoal, getSavingsOverview, updateSavingsGoal } from '../src/services/savings-goals.js';
import { createTestDb } from './helpers/db.js';
import { IBAN } from './helpers/fixtures.js';
import { volksbankCsv, type VbRow } from './helpers/volksbank-csv.js';

/*
 * Synthetischer Haushalt Januar–September 2026, heute ist der 05.10.2026:
 * Girokonto (Einnahmen): Gehalt 3.500 € am 1., Miete 900 € am 3.,
 *   Dauerauftrag 425 € aufs Ausgabenkonto am 11., 200 € aufs Sparkonto am
 *   15., REWE dreimal im Monat (300 €, im August 400 €), Pizzeria 50 € am 20.,
 *   Jahresbeitrag Versicherung 240 € im März; im September dazu eine
 *   REWE-Erstattung über 20 € und ein unkategorisierter Einkauf über 15 €.
 * Ausgabenkonto: Dauerauftrag 425 € rein, Netflix 12,99 €, Strom 80 €, ab
 *   Juli ein Kredit über 400 € (→ Unterdeckung, drei Monate in Folge).
 * Sparkonto: 200 € rein, Startguthaben 1.000 €.
 */
const TODAY = '2026-10-05';
const MONTHS = monthRange('2026-01', '2026-09');

let db: Db;
let giro: number;
let ausgaben: number;
let spar: number;
const category = (name: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number }).id;

function giroRows(): VbRow[] {
  const rows: VbRow[] = [];
  for (const m of MONTHS) {
    rows.push({ date: `${m}-01`, amountCents: 350000, counterparty: 'Arbeitgeber GmbH', bookingText: 'Gehalt', purpose: 'Lohn' });
    rows.push({ date: `${m}-03`, amountCents: -90000, counterparty: 'Wohnbau Beispiel GmbH', purpose: 'Miete' });
    rows.push({ date: `${m}-11`, amountCents: -42500, counterparty: 'Ich', counterpartyIban: IBAN.comdirectGiro, bookingText: 'Dauerauftrag', purpose: 'Haushalt' });
    rows.push({ date: `${m}-15`, amountCents: -20000, counterparty: 'Ich', counterpartyIban: IBAN.volksbankSpar, bookingText: 'Dauerauftrag', purpose: 'Sparen' });
    const rewe = m === '2026-08' ? [9000, 11000, 20000] : [9000, 11000, 10000];
    [6, 16, 26].forEach((day, i) => {
      rows.push({ date: `${m}-${day < 10 ? `0${day}` : day}`, amountCents: -(rewe[i] as number), counterparty: 'REWE Markt', bookingText: 'Kartenzahlung' });
    });
    rows.push({ date: `${m}-20`, amountCents: -5000, counterparty: 'Pizzeria Beispiel', bookingText: 'Kartenzahlung' });
  }
  rows.push({ date: '2026-03-02', amountCents: -24000, counterparty: 'Beispiel Versicherung AG', purpose: 'Jahresbeitrag 2026' });
  rows.push({ date: '2026-09-08', amountCents: 2000, counterparty: 'REWE Markt', bookingText: 'Gutschrift', purpose: 'Erstattung' });
  rows.push({ date: '2026-09-09', amountCents: -1500, counterparty: 'Unbekannt Shop', bookingText: 'Kartenzahlung' });
  return rows;
}

function ausgabenRows(): VbRow[] {
  const rows: VbRow[] = [];
  for (const m of MONTHS) {
    rows.push({ date: `${m}-11`, amountCents: 42500, counterparty: 'Ich', counterpartyIban: IBAN.volksbankGiro, bookingText: 'Gutschrift', purpose: 'Haushalt' });
    rows.push({ date: `${m}-05`, amountCents: -1299, counterparty: 'Netflix', purpose: 'Abo' });
    rows.push({ date: `${m}-20`, amountCents: -8000, counterparty: 'Stadtwerke Beispiel', purpose: 'Strom Abschlag' });
    if (m >= '2026-07') rows.push({ date: `${m}-25`, amountCents: -40000, counterparty: 'Beispielbank Kredit', purpose: 'Rate' });
  }
  return rows;
}

function sparRows(): VbRow[] {
  return MONTHS.map((m) => ({ date: `${m}-15`, amountCents: 20000, counterparty: 'Ich', counterpartyIban: IBAN.volksbankGiro, bookingText: 'Gutschrift', purpose: 'Sparen' }));
}

function setup(): void {
  db = createTestDb();
  giro = createAccount(db, { name: 'Giro', role: 'einnahmen', bankAdapter: 'volksbank-owl', iban: IBAN.volksbankGiro }).id;
  ausgaben = createAccount(db, { name: 'Ausgaben', role: 'ausgaben', bankAdapter: 'volksbank-owl', iban: IBAN.comdirectGiro }).id;
  spar = createAccount(db, { name: 'Spar', role: 'sparen', bankAdapter: 'volksbank-owl', iban: IBAN.volksbankSpar }).id;
  const rules: [string, string][] = [
    ['Arbeitgeber', 'Einkommen'],
    ['Wohnbau', 'Wohnen & Nebenkosten'],
    ['Stadtwerke', 'Wohnen & Nebenkosten'],
    ['REWE', 'Lebensmittel'],
    ['Pizzeria', 'Restaurants & Cafés'],
    ['Netflix', 'Abos & Mitgliedschaften'],
    ['Versicherung', 'Versicherungen'],
    ['Kredit', 'Sonstiges'],
  ];
  for (const [pattern, name] of rules) {
    createRule(db, { field: 'counterparty', patternType: 'contains', pattern, categoryId: category(name) });
  }
  const imports: [number, Uint8Array][] = [
    [giro, volksbankCsv(IBAN.volksbankGiro, giroRows(), 500000)],
    [ausgaben, volksbankCsv(IBAN.comdirectGiro, ausgabenRows(), 0)],
    [spar, volksbankCsv(IBAN.volksbankSpar, sparRows(), 100000)],
  ];
  for (const [accountId, bytes] of imports) {
    importFile(db, { accountId, fileName: `${accountId}.csv`, bytes, periodStart: '2026-01-01', periodEnd: '2026-09-30' });
  }
}

beforeEach(setup);

describe('Vollständigkeit der Monate', () => {
  it('ist vollständig, wenn jedes aktive Konto den Monat abdeckt', () => {
    const index = completenessIndex(db, TODAY);
    expect(index.statusOf('2026-09').status).toBe('complete');
    expect(index.statusOf('2026-10').status).toBe('missing');
    expect(index.statusOf('2026-10').incomplete.map((a) => a.accountName)).toEqual(['Giro', 'Ausgaben', 'Spar']);
    expect(completeMonthsBefore(index, '2026-10', 3)).toEqual(['2026-07', '2026-08', '2026-09']);
  });

  it('nennt Konten, die erst später importiert wurden, ohne den Monat unvollständig zu machen', () => {
    const visa = createAccount(db, { name: 'Visa', role: 'kreditkarte', bankAdapter: 'volksbank-owl', iban: IBAN.volksbankVisa }).id;
    importFile(db, {
      accountId: visa,
      fileName: 'visa.csv',
      bytes: volksbankCsv(IBAN.volksbankVisa, [{ date: '2026-09-10', amountCents: -1000, purpose: 'AMAZON' }]),
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
    });
    const index = completenessIndex(db, TODAY);
    const aug = index.statusOf('2026-08');
    expect(aug.status).toBe('complete');
    expect(aug.notYetImported.map((a) => a.accountName)).toEqual(['Visa']);
  });
});

describe('Monatsübersicht', () => {
  it('zählt Einnahmen und Ausgaben ohne Umbuchungen, Standard ist der letzte vollständige Monat', () => {
    const o = getMonthOverview(db, {}, TODAY);
    expect(o.month).toBe('2026-09');
    expect(o.completeness.status).toBe('complete');
    // Gehalt + Erstattung; Miete, REWE, Pizzeria, Shop, Netflix, Strom, Kredit.
    expect(o.totals.incomeCents).toBe(352000);
    expect(o.totals.expensesCents).toBe(90000 + 30000 + 5000 + 1500 + 1299 + 8000 + 40000);
    expect(o.totals.balanceCents).toBe(352000 - 175799);
    // Dauerauftrag und Sparen: je zwei Seiten.
    expect(o.transfers).toEqual({ count: 4, inflowCents: 62500, outflowCents: 62500 });
    expect(o.uncategorized).toEqual({ count: 1, outflowCents: 1500, inflowCents: 0 });
  });

  it('listet Ausgaben je Kategorie absteigend mit Anteil und Vormonat', () => {
    const o = getMonthOverview(db, { month: '2026-09' }, TODAY);
    expect(o.categories.map((c) => c.name)).toEqual([
      'Wohnen & Nebenkosten',
      'Sonstiges',
      'Lebensmittel',
      'Restaurants & Cafés',
      'ohne Kategorie',
      'Abos & Mitgliedschaften',
    ]);
    const food = o.categories.find((c) => c.name === 'Lebensmittel');
    expect(food).toMatchObject({ outflowCents: 30000, inflowCents: 2000, previousOutflowCents: 40000, changeCents: -10000 });
    expect(food?.sharePermille).toBe(Math.round((30000 * 1000) / 175799));
    expect(o.previous.month).toBe('2026-08');
    expect(o.previous.expensesCents).toBe(90000 + 40000 + 5000 + 1299 + 8000 + 40000);
  });

  it('zeigt zwölf Monate Verlauf und kennzeichnet unvollständige', () => {
    const o = getMonthOverview(db, { month: '2026-10' }, TODAY);
    expect(o.history).toHaveLength(12);
    expect(o.history[0]?.month).toBe('2025-11');
    expect(o.history[0]?.status).toBe('missing');
    expect(o.history[11]).toMatchObject({ month: '2026-10', status: 'missing', incomeCents: 0, expensesCents: 0 });
    expect(o.completeness.status).toBe('missing');
    expect(o.availableMonths[0]).toBe('2026-10');
    expect(o.availableMonths[o.availableMonths.length - 1]).toBe('2026-01');
  });

  it('rechnet pro Konto', () => {
    const o = getMonthOverview(db, { month: '2026-09', accountId: ausgaben }, TODAY);
    expect(o.totals).toMatchObject({ incomeCents: 0, expensesCents: 49299 });
    expect(o.transfers.count).toBe(1);
  });
});

describe('Offene Punkte', () => {
  const kinds = (items: AttentionItem[]) => items.map((i) => i.kind);

  it('meldet Unterdeckung, Vorschläge, Unkategorisiertes und unbestätigte Umbuchungen', () => {
    const items = getAttention(db, TODAY);
    expect(kinds(items)).toEqual(
      expect.arrayContaining(['funding_deficit', 'recurring_suggestions', 'uncategorized', 'transfers_suggested']),
    );
    expect(items[0]).toMatchObject({ kind: 'funding_deficit', severity: 'bad', accountId: ausgaben, trendStatus: 'trend', deficitSince: '2026-07', deficitStreak: 3 });
    expect(items.find((i) => i.kind === 'uncategorized')).toMatchObject({ count: 1, outflowCents: 1500 });
    expect(items.find((i) => i.kind === 'transfers_suggested')).toMatchObject({ count: 18 });
    expect(kinds(items)).not.toContain('import_stale');
    expect(kinds(items)).not.toContain('import_gap');
  });

  it('meldet lange nicht importierte Konten und Importlücken', () => {
    importFile(db, {
      accountId: spar,
      fileName: 'spar-nov.csv',
      bytes: volksbankCsv(IBAN.volksbankSpar, [{ date: '2026-11-15', amountCents: 500, purpose: 'Zinsen' }], 280000),
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
    });
    const items = getAttention(db, '2026-12-10');
    const stale = items.filter((i) => i.kind === 'import_stale');
    expect(stale.map((i) => (i as { accountName: string }).accountName)).toEqual(['Giro', 'Ausgaben']);
    expect(items.find((i) => i.kind === 'import_gap')).toMatchObject({ accountName: 'Spar', gaps: [{ start: '2026-10-01', end: '2026-10-31' }] });
  });

  it('meldet fehlende Abbuchungen, Preiserhöhungen und nahende Kündigungsfristen', () => {
    createRecurringItem(db, { kind: 'subscription', accountId: null, counterparty: 'Netflix', amount: '9,99', interval: 'monthly', nextDueDate: '2026-10-05' });
    createRecurringItem(db, {
      kind: 'fixed_cost',
      accountId: null,
      counterparty: 'Fitness Beispiel',
      amount: '30,00',
      interval: 'monthly',
      nextDueDate: '2026-10-01',
      contractEndDate: '2026-12-31',
      noticePeriodValue: 1,
      noticePeriodUnit: 'months',
    });
    createRecurringItem(db, { kind: 'fixed_cost', accountId: null, counterparty: 'Stadtwerke Beispiel', amount: '80,00', interval: 'monthly', nextDueDate: '2026-10-20' });
    db.prepare("DELETE FROM transactions WHERE counterparty = 'Stadtwerke Beispiel' AND booking_date >= '2026-09-01'").run();
    const items = getAttention(db, TODAY);
    expect(items.find((i) => i.kind === 'recurring_price')).toMatchObject({ entries: [{ name: 'Netflix', sollCents: 999, lastCents: 1299 }] });
    expect(items.find((i) => i.kind === 'recurring_missing')).toMatchObject({
      entries: [{ name: 'Stadtwerke Beispiel', dueDate: '2026-09-20', ended: false }],
    });
    expect(items.find((i) => i.kind === 'recurring_cancel')).toMatchObject({
      entries: [{ name: 'Fitness Beispiel', cancelBy: '2026-11-30', contractEndDate: '2026-12-31' }],
    });
  });
});

describe('Budget 50/30/20', () => {
  it('leitet das Nettoeinkommen aus den wiederkehrenden Eingängen ab, nicht aus allen Gutschriften', () => {
    const income = detectIncome(db);
    expect(income.sources.map((s) => s.label)).toEqual(['Arbeitgeber GmbH']);
    const b = getBudget(db, { month: '2026-09' }, TODAY);
    expect(b.income).toMatchObject({ actualCents: 350000, expectedCents: 350000, basisCents: 350000, basisSource: 'actual', allCreditsCents: 352000 });
  });

  it('vergleicht Ist und Ziel je Bucket, Sparen inklusive Umbuchungen aufs Sparkonto', () => {
    const b = getBudget(db, { month: '2026-09' }, TODAY);
    const need = b.buckets.find((x) => x.bucket === 'need');
    const want = b.buckets.find((x) => x.bucket === 'want');
    const save = b.buckets.find((x) => x.bucket === 'save');
    // Wohnen 980 €, Lebensmittel 300 € minus 20 € Erstattung.
    expect(need).toMatchObject({ targetCents: 175000, actualCents: 98000 + 28000, deviationCents: 126000 - 175000 });
    expect(want).toMatchObject({ targetCents: 105000, actualCents: 5000 + 1299 });
    expect(save).toMatchObject({ targetCents: 70000, actualCents: 20000, savingsTransfersCents: 20000 });
    expect(b.unassigned).toMatchObject({ uncategorizedCents: 1500, totalCents: 41500 });
    expect(b.unassigned.categories).toEqual([{ categoryId: category('Sonstiges'), path: 'Sonstiges', actualCents: 40000 }]);
  });

  it('zeigt die Abweichung je Kategorie gegenüber dem Median der Monate davor', () => {
    const b = getBudget(db, { month: '2026-09' }, TODAY);
    expect(b.typicalMonths).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
    const food = b.buckets.find((x) => x.bucket === 'need')?.categories.find((c) => c.path === 'Lebensmittel');
    expect(food).toMatchObject({ actualCents: 28000, typicalCents: 30000, deviationCents: -2000 });
  });

  it('mittelt über mehrere Monate', () => {
    const b = getBudget(db, { month: '2026-09', span: 3 }, TODAY);
    expect(b.months.map((m) => m.month)).toEqual(['2026-07', '2026-08', '2026-09']);
    const food = b.buckets.find((x) => x.bucket === 'need')?.categories.find((c) => c.path === 'Lebensmittel');
    expect(food?.actualCents).toBe(Math.round((30000 + 40000 + 28000) / 3));
  });

  it('nimmt im unvollständigen Monat das erwartete Einkommen', () => {
    const b = getBudget(db, { month: '2026-10' }, TODAY);
    expect(b.allComplete).toBe(false);
    expect(b.income).toMatchObject({ actualCents: 0, basisSource: 'expected', basisCents: 350000 });
  });
});

describe('Prognose', () => {
  beforeEach(() => {
    createRecurringItem(db, {
      kind: 'subscription',
      accountId: null,
      counterparty: 'Netflix',
      amount: '12,99',
      interval: 'monthly',
      nextDueDate: '2026-10-05',
      categoryId: category('Abos & Mitgliedschaften'),
    });
    createRecurringItem(db, {
      kind: 'fixed_cost',
      accountId: null,
      counterparty: 'Beispiel Versicherung',
      amount: '240,00',
      interval: 'annual',
      nextDueDate: '2027-03-02',
      categoryId: category('Versicherungen'),
    });
  });

  it('rechnet Fixkosten an ihren Terminen, variable Kategorien über den Median, Einnahmen aus dem Gehalt', () => {
    const f = getForecast(db, TODAY);
    expect(f.months[0]).toBe('2026-10');
    expect(f.months).toHaveLength(12);
    expect(f.basisMonths).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
    expect(f.income.map((s) => s.label)).toEqual(['Arbeitgeber GmbH']);

    const row = (name: string) => f.categories.find((c) => c.name === name);
    expect(row('Wohnen & Nebenkosten')).toMatchObject({ variableCents: -98000 });
    // 300, 300, 300, 300, 400, 280 € → Median 300 €.
    expect(row('Lebensmittel')).toMatchObject({ variableCents: -30000 });
    // Kredit erst seit Juli: 0, 0, 0, 400, 400, 400 → Median 200 €.
    expect(row('Sonstiges')).toMatchObject({ variableCents: -20000 });
    // Netflix nur als Fixkosten, nicht zusätzlich variabel.
    expect(row('Abos & Mitgliedschaften')).toMatchObject({ variableCents: 0, fixedMonths: Array(12).fill(-1299) });
    // Jahresbeitrag im März 2027.
    const insurance = row('Versicherungen');
    expect(insurance?.months[5]).toBe(-24000);
    expect(insurance?.totalCents).toBe(-24000);
    // Einmaliger Einkauf ohne Kategorie: Median 0, keine Zeile.
    expect(row('ohne Kategorie')).toBeUndefined();

    const monthly = 350000 - 98000 - 30000 - 5000 - 20000 - 1299;
    expect(f.totals[0]).toMatchObject({ incomeCents: 350000, fixedCents: -1299, balanceCents: monthly });
    expect(f.totals[5]?.balanceCents).toBe(monthly - 24000);
    expect(f.averageSurplusCents).toBe(Math.round((12 * monthly - 24000) / 12));
    expect(f.startBalance.knownAccounts).toBe(3);
    expect(f.totals[0]?.projectedBalanceCents).toBe(f.startBalance.totalCents + monthly);
  });

  it('lässt beendete Posten weg', () => {
    createRecurringItem(db, { kind: 'subscription', accountId: null, counterparty: 'Pizzeria Beispiel', amount: '50,00', interval: 'monthly', nextDueDate: '2026-07-20' });
    db.prepare("DELETE FROM transactions WHERE counterparty = 'Pizzeria Beispiel' AND booking_date >= '2026-08-01'").run();
    const f = getForecast(db, TODAY);
    expect(f.excludedItems).toEqual([expect.objectContaining({ name: 'Pizzeria Beispiel', reason: 'ended' })]);
  });
});

describe('Sparziele', () => {
  it('nimmt den Stand aus dem Sparkonto und staffelt nach Priorität', () => {
    createSavingsGoal(db, { name: 'Notgroschen', amount: '3.000', priority: 1 });
    createSavingsGoal(db, { name: 'Urlaub', amount: '5.000', priority: 2, targetDate: '2027-06-30' });
    const s = getSavingsOverview(db, TODAY);
    const surplus = getForecast(db, TODAY).averageSurplusCents;
    expect(s.surplusCents).toBe(surplus);
    expect(s.accounts).toEqual([{ accountId: spar, accountName: 'Spar', balanceCents: 280000, balanceDate: '2026-09-15', allocatedCents: 280000 }]);
    const [first, second] = s.goals;
    expect(first).toMatchObject({ name: 'Notgroschen', accountId: spar, plan: { currentCents: 280000, remainingCents: 20000, monthsToReach: 1, reachMonth: '2026-10' } });
    const months = Math.ceil(520000 / surplus);
    expect(second?.plan).toMatchObject({ currentCents: 0, remainingCents: 500000, monthsToReach: months, monthsAvailable: 8, neededMonthlyCents: 62500, onTrack: true });
  });

  it('rechnet durch, wie viel früher ein Ziel ohne Abos erreicht wäre', () => {
    createRecurringItem(db, { kind: 'subscription', accountId: null, counterparty: 'Netflix', amount: '12,99', interval: 'monthly', nextDueDate: '2026-10-05' });
    createSavingsGoal(db, { name: 'Auto', amount: '100.000', priority: 1 });
    const all = getSavingsOverview(db, TODAY);
    expect(all.subscriptions).toEqual([expect.objectContaining({ name: 'Netflix', monthlyCents: 1299, selected: true })]);
    expect(all.selectedMonthlyCents).toBe(1299);
    const goal = all.goals[0];
    const base = Math.ceil((10000000 - 280000) / all.surplusCents);
    const without = Math.ceil((10000000 - 280000) / (all.surplusCents + 1299));
    expect(goal?.plan?.monthsToReach).toBe(base);
    expect(goal?.withoutSelected).toMatchObject({ monthsToReach: without, monthsEarlier: base - without });

    const none = getSavingsOverview(db, TODAY, []);
    expect(none.selectedMonthlyCents).toBe(0);
    expect(none.goals[0]?.withoutSelected).toBeNull();
  });

  it('lässt sich ändern und löschen', () => {
    const { id } = createSavingsGoal(db, { name: 'Rad', amount: '800', priority: 1 });
    updateSavingsGoal(db, id, { name: 'E-Bike', amount: '2.400,50', priority: 2, targetDate: '2027-04-01', accountId: null, active: false });
    const goal = getSavingsOverview(db, TODAY).goals[0];
    expect(goal).toMatchObject({ name: 'E-Bike', targetCents: 240050, priority: 2, accountId: null, active: false, plan: null });
    deleteSavingsGoal(db, id);
    expect(getSavingsOverview(db, TODAY).goals).toEqual([]);
    expect(() => createSavingsGoal(db, { name: 'X', amount: '0' })).toThrow(/kein Zielbetrag/);
  });
});

describe('API', () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = buildApp({ db });
  });
  afterEach(async () => {
    await app.close();
  });

  it('liefert Übersicht, offene Punkte, Budget und Prognose', async () => {
    for (const url of ['/api/overview?month=2026-09', '/api/attention', '/api/budget?span=3', '/api/forecast?months=6']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
    }
    const bad = await app.inject({ method: 'GET', url: '/api/budget?span=2' });
    expect(bad.statusCode).toBe(400);
  });

  it('legt Sparziele an und rechnet ohne ausgewählte Abos', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/savings-goals', payload: { name: 'Urlaub', amount: '1.000' } });
    expect(created.statusCode).toBe(201);
    const res = await app.inject({ method: 'GET', url: '/api/savings-goals?without=' });
    expect(res.statusCode).toBe(200);
    expect(res.json().goals[0]).toMatchObject({ name: 'Urlaub', accountId: spar });
    const invalid = await app.inject({ method: 'GET', url: '/api/savings-goals?without=a,b' });
    expect(invalid.statusCode).toBe(400);
  });
});
