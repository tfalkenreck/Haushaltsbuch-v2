import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/connection.js';
import { addDays, monthRange } from '../src/lib/date.js';
import { createAccount } from '../src/services/accounts.js';
import { importFile } from '../src/services/imports.js';
import {
  confirmSuggestion,
  createRecurringItem,
  deleteRecurringItem,
  dismissSuggestion,
  listRecurring,
  resetTransactionRecurring,
  setTransactionRecurring,
  updateRecurringItem,
  type RecurringItem,
  type RecurringItemInput,
} from '../src/services/recurring.js';
import { listTransactions } from '../src/services/transactions.js';
import { createTestDb } from './helpers/db.js';
import { IBAN } from './helpers/fixtures.js';
import { volksbankCsv, type VbRow } from './helpers/volksbank-csv.js';

/*
 * Synthetische Daten Januar–September 2026:
 * Girokonto (Einnahmen) – Gehalt; Dauerauftrag 425 € aufs Ausgabenkonto
 * (Umbuchung); Muster Versicherung mit zwei Verträgen (Gläubiger-ID gleich,
 * Mandat verschieden, Gegenpartei unterschiedlich geschrieben); Telefon mit
 * schwankendem Betrag; Streaming 9,99 → ab Juni 12,99; Fitnessstudio bis Mai;
 * Wasser quartalsweise; ADAC-Jahresbeitrag einmal; PayPal-Lastschriften:
 * Audible bis April, dazu einmalige Einkäufe; REWE dreimal im Monat mit
 * wechselnder Mandatsreferenz.
 * Visa (Kreditkarte, ab Mai) – Kartenumsätze ohne Gegenpartei: PAYPAL *AUDIBLE
 * (ab Mai, Fortsetzung des Abos), PAYPAL *RING 8 €, zwei Spotify-Abos zu
 * 10,99 € am 8. und 22., einzelne Amazon-Käufe.
 */
const TODAY = '2026-10-03';
const MONTHS = monthRange('2026-01', '2026-09');
const REWE = [23.45, 67.8, 41.2, 88.15, 12.3, 55.55, 31.9, 74.05, 19.99, 46.6, 63.35, 28.7, 92.4, 37.15, 58.8, 15.25, 81.1, 44.4,
  26.6, 71.3, 49.05, 84.9, 17.45, 60.2, 35.75, 77.7, 21.1];
const cents = (euros: number) => Math.round(euros * 100);

function giroRows(): VbRow[] {
  const rows: VbRow[] = [];
  MONTHS.forEach((m, i) => {
    rows.push({ date: `${m}-01`, amountCents: 350000, counterparty: 'Arbeitgeber GmbH', bookingText: 'Gehalt', purpose: 'Lohn' });
    rows.push({
      date: `${m}-11`,
      amountCents: -42500,
      counterparty: 'Max Mustermann',
      counterpartyIban: IBAN.comdirectGiro,
      bookingText: 'Dauerauftrag',
      purpose: 'Haushalt',
    });
    rows.push({
      date: `${m}-15`,
      amountCents: -1250,
      counterparty: 'Muster Versicherung AG',
      purpose: `Hausrat ${m}`,
      creditorId: 'DE11ZZZ00000000001',
      mandateReference: 'M-HAUS-1',
    });
    rows.push({
      date: `${m}-15`,
      amountCents: -2788,
      counterparty: 'MUSTER VERSICHERUNG',
      purpose: `Kfz ${m}`,
      creditorId: 'DE11ZZZ00000000001',
      mandateReference: 'M-KFZ-2',
    });
    rows.push({
      date: `${m}-0${5 + (i % 3)}`,
      amountCents: -[3510, 4177, 3800, 5240, 3690, 3955, 4012, 3730, 3888][i]!,
      counterparty: 'Beispiel Telefon GmbH',
      purpose: `Rechnung ${m}`,
      creditorId: 'DE22ZZZ00000000002',
      mandateReference: 'TEL-9',
    });
    rows.push({
      date: `${m}-07`,
      amountCents: m < '2026-06' ? -999 : -1299,
      counterparty: 'Beispiel Streaming GmbH',
      purpose: 'Abo',
      creditorId: 'DE33ZZZ00000000003',
      mandateReference: 'STR-1',
    });
    if (m <= '2026-05') {
      rows.push({
        date: `${m}-03`,
        amountCents: -2990,
        counterparty: 'Fitnessstudio Beispiel',
        purpose: 'Mitgliedsbeitrag',
        creditorId: 'DE44ZZZ00000000004',
        mandateReference: 'FIT-1',
      });
    }
    if (m <= '2026-04') {
      rows.push({
        date: `${m}-20`,
        amountCents: -995,
        counterparty: 'PayPal Europe S.a.r.l. et Cie S.C.A',
        purpose: `10400000000${i} PP.1234.PP . Audible Ltd, Ihr Einkauf bei Audible Ltd`,
        creditorId: 'LU96ZZZ0000000000000000058',
        mandateReference: 'PAYPALMANDAT1',
      });
    }
    [2, 12, 24].forEach((day, k) => {
      rows.push({
        date: `${m}-${String(day).padStart(2, '0')}`,
        amountCents: -cents(REWE[i * 3 + k]!),
        counterparty: 'REWE Markt GmbH',
        bookingText: 'Kartenzahlung girocard',
        purpose: 'REWE SAGT DANKE',
        creditorId: 'DE00ZZZ00000000099',
        mandateReference: `R${i}${k}`,
      });
    });
  });
  for (const date of ['2026-01-15', '2026-04-15', '2026-07-15']) {
    rows.push({ date, amountCents: -4500, counterparty: 'Stadtwerke Beispiel GmbH', purpose: 'Wasser Abschlag' });
  }
  rows.push({ date: '2026-03-02', amountCents: -9400, counterparty: 'ADAC e.V.', purpose: 'Jahresbeitrag 2026 Mitgliedsnr 123' });
  rows.push({
    date: '2026-03-18',
    amountCents: -4990,
    counterparty: 'PayPal Europe S.a.r.l. et Cie S.C.A',
    purpose: '1040000000099 PP.1234.PP . Beispielshop GmbH, Ihr Einkauf bei Beispielshop GmbH',
    creditorId: 'LU96ZZZ0000000000000000058',
    mandateReference: 'PAYPALMANDAT1',
  });
  return rows;
}

/** Kartenumsatz: Händler und Kaufdatum stehen im Verwendungszweck, gebucht wird am Folgetag. */
function card(purchase: string, euros: number, merchant: string): VbRow {
  const de = `${purchase.slice(8, 10)}.${purchase.slice(5, 7)}.${purchase.slice(0, 4)}`;
  return {
    date: addDays(purchase, 1),
    amountCents: -cents(euros),
    bookingText: 'Basislastschrift',
    purpose: `${merchant}  GB  12345678901            EUR             ${euros}Umsatz vom ${de}      Visa Hauptkarte`,
  };
}

function visaRows(): VbRow[] {
  const rows: VbRow[] = [];
  for (const m of monthRange('2026-05', '2026-09')) {
    rows.push(card(`${m}-20`, 9.95, 'PAYPAL *AUDIBLE'));
    rows.push(card(`${m}-05`, 8, 'PAYPAL *RING'));
    rows.push(card(`${m}-08`, 10.99, 'SPOTIFY'));
    rows.push(card(`${m}-22`, 10.99, 'SPOTIFY'));
  }
  rows.push(card('2026-06-14', 34.9, 'AMAZON'));
  rows.push(card('2026-08-02', 12.5, 'AMAZON'));
  return rows.filter((r) => r.date <= '2026-09-30');
}

let db: Db;
let giro: number;
let visa: number;

function setup(): void {
  db = createTestDb();
  giro = createAccount(db, { name: 'Giro', role: 'einnahmen', bankAdapter: 'volksbank-owl', iban: IBAN.volksbankGiro }).id;
  visa = createAccount(db, { name: 'Visa', role: 'kreditkarte', bankAdapter: 'volksbank-owl', iban: IBAN.volksbankVisa }).id;
  const ausgaben = createAccount(db, { name: 'Ausgaben', role: 'ausgaben', bankAdapter: 'volksbank-owl', iban: IBAN.comdirectGiro }).id;
  const incoming = MONTHS.map(
    (m): VbRow => ({
      date: `${m}-11`,
      amountCents: 42500,
      counterparty: 'Max Mustermann',
      counterpartyIban: IBAN.volksbankGiro,
      bookingText: 'Gutschrift',
      purpose: 'Haushalt',
    }),
  );
  const imports: [number, string, Uint8Array, string][] = [
    [giro, 'giro.csv', volksbankCsv(IBAN.volksbankGiro, giroRows(), 100000), '2026-01-01'],
    [visa, 'visa.csv', volksbankCsv(IBAN.volksbankVisa, visaRows()), '2026-05-01'],
    [ausgaben, 'ausgaben.csv', volksbankCsv(IBAN.comdirectGiro, incoming), '2026-01-01'],
  ];
  for (const [accountId, fileName, bytes, periodStart] of imports) {
    importFile(db, { accountId, fileName, bytes, periodStart, periodEnd: '2026-09-30' });
  }
}

const manual = (extra: Partial<RecurringItemInput>): RecurringItemInput => ({
  kind: 'subscription',
  accountId: null,
  counterparty: '',
  amount: '1,00',
  interval: 'monthly',
  nextDueDate: '2026-10-01',
  ...extra,
});

const itemNamed = (name: string) => listRecurring(db, TODAY).items.find((i) => i.name === name) as RecurringItem;

describe('Erkennung von Fixkosten und Abos', () => {
  beforeEach(setup);

  it('schlägt wiederkehrende Abbuchungen vor – keine Umbuchungen, keine Einkäufe', () => {
    const { suggestions, items } = listRecurring(db, TODAY);
    expect(items).toEqual([]);
    // Laufende zuerst, nach Betrag je Monat; beendete am Ende.
    expect(suggestions.map((s) => [s.label, s.interval, s.count, s.lastAmountCents, s.accountName, s.ended])).toEqual([
      ['Beispiel Telefon GmbH', 'monthly', 9, 3888, 'Giro', false],
      ['MUSTER VERSICHERUNG', 'monthly', 9, 2788, 'Giro', false],
      ['Stadtwerke Beispiel GmbH', 'quarterly', 3, 4500, 'Giro', false],
      ['Beispiel Streaming GmbH', 'monthly', 9, 1299, 'Giro', false],
      ['Muster Versicherung AG', 'monthly', 9, 1250, 'Giro', false],
      ['SPOTIFY', 'monthly', 5, 1099, 'Visa', false],
      ['SPOTIFY', 'monthly', 5, 1099, 'Visa', false],
      ['PAYPAL *AUDIBLE', 'monthly', 9, 995, 'Visa', false],
      ['PAYPAL *RING', 'monthly', 5, 800, 'Visa', false],
      ['ADAC e.V.', 'annual', 1, 9400, 'Giro', false],
      ['Fitnessstudio Beispiel', 'monthly', 5, 2990, 'Giro', true],
    ]);
    const byLabel = (label: string) => suggestions.find((s) => s.label === label);
    expect(byLabel('ADAC e.V.')).toMatchObject({ suspected: true, nextDueDate: '2027-03-02' });
    expect(byLabel('Beispiel Streaming GmbH')?.priceChange).toEqual({ date: '2026-06-07', fromCents: 999, toCents: 1299 });
    // PayPal-Lastschrift (Januar–April) und Kartenumsatz (ab Mai) sind ein Abo.
    expect(byLabel('PAYPAL *AUDIBLE')).toMatchObject({ firstDate: '2026-01-20', kind: 'subscription' });
    expect(byLabel('PAYPAL *RING')?.kind).toBe('subscription');
    // Zwei Spotify-Abos: doppelt; zwei Verträge beim Versicherer mit verschiedenen Beträgen: nicht.
    expect(suggestions.filter((s) => s.label === 'SPOTIFY').map((s) => s.duplicates)).toEqual([['SPOTIFY'], ['SPOTIFY']]);
    expect(byLabel('Muster Versicherung AG')?.duplicates).toEqual([]);
  });

  it('übernimmt Vorschläge erst auf Knopfdruck und merkt sich verworfene', () => {
    const before = listRecurring(db, TODAY);
    const telefon = before.suggestions.find((s) => s.label === 'Beispiel Telefon GmbH')!;
    const { id } = confirmSuggestion(db, { key: telefon.key, kind: 'fixed_cost' }, TODAY);

    const after = listRecurring(db, TODAY);
    expect(after.suggestions.some((s) => s.key === telefon.key)).toBe(false);
    const item = after.items.find((i) => i.id === id)!;
    expect(item).toMatchObject({
      name: 'Beispiel Telefon GmbH',
      kind: 'fixed_cost',
      origin: 'auto',
      amountCents: 3888,
      accountName: 'Giro',
      creditorId: 'DE22ZZZ00000000002',
      mandateReference: 'TEL-9',
      bookingCount: 9,
      active: true,
    });
    // Telefon mit Verbrauch: der Betrag weicht vom Soll ab, aber keine Abbuchung fehlt.
    expect(item.check).toMatchObject({ missingCount: 0, nextDueDate: '2026-10-07' });
    expect(after.totals).toEqual({ count: 1, monthlyCents: 3888, fixedCostMonthlyCents: 3888, subscriptionMonthlyCents: 0 });

    const fitness = after.suggestions.find((s) => s.label === 'Fitnessstudio Beispiel')!;
    dismissSuggestion(db, fitness.key, TODAY);
    const dismissed = listRecurring(db, TODAY);
    expect(dismissed.suggestions.some((s) => s.key === fitness.key)).toBe(false);
    expect(dismissed.dismissed).toEqual([expect.objectContaining({ name: 'Fitnessstudio Beispiel', amountCents: 2990 })]);
    // Zurückholen = verworfenen Eintrag löschen.
    deleteRecurringItem(db, dismissed.dismissed[0]!.id);
    expect(listRecurring(db, TODAY).suggestions.some((s) => s.key === fitness.key)).toBe(true);
    expect(() => confirmSuggestion(db, { key: 'cp:gibt es nicht' }, TODAY)).toThrow(/gibt es nicht/);
  });

  it('erkennt ein übernommenes Abo wieder, wenn es auf die Karte umzieht', () => {
    const audible = listRecurring(db, TODAY).suggestions.find((s) => s.label === 'PAYPAL *AUDIBLE')!;
    const { id } = confirmSuggestion(db, { key: audible.key, name: 'Audible' }, TODAY);
    const item = listRecurring(db, TODAY).items.find((i) => i.id === id)!;
    expect(item).toMatchObject({ name: 'Audible', accountName: 'Visa', counterparty: 'PAYPAL *AUDIBLE', creditorId: null });
    // Das Abo hängt am Kartenkonto; die Lastschriften vom Giro gehören nicht mehr dazu.
    expect(item.bookingCount).toBe(5);
    expect(item.check.status).toBe('ok');
  });
});

describe('Fixkosten und Abos von Hand', () => {
  beforeEach(setup);

  it('legt ein Abo von Hand an und findet die Buchungen über die Gegenpartei', () => {
    createRecurringItem(db, manual({ name: 'Ring', counterparty: 'Ring', amount: '8,00', nextDueDate: '2026-10-05' }));
    const ring = itemNamed('Ring');
    expect(ring).toMatchObject({ origin: 'manual', amountCents: 800, bookingCount: 5, monthlyCents: 800 });
    expect(ring.check).toMatchObject({ status: 'ok', nextDueDate: '2026-10-05', missingCount: 0 });
    // Die Buchungen gehören jetzt dem Posten – kein Vorschlag mehr dafür.
    expect(listRecurring(db, TODAY).suggestions.some((s) => s.label === 'PAYPAL *RING')).toBe(false);
  });

  it('gleicht Soll und Ist ab: Preiserhöhung, fehlende Abbuchung, nichts gefunden', () => {
    createRecurringItem(db, manual({ name: 'Streaming', counterparty: 'Beispiel Streaming', amount: '9,99', nextDueDate: '2026-10-07', accountId: giro }));
    expect(itemNamed('Streaming').check).toMatchObject({
      status: 'differs',
      suggestedAmountCents: 1299,
      priceChange: { date: '2026-06-07', fromCents: 999, toCents: 1299 },
    });

    createRecurringItem(db, manual({ name: 'Fitness', kind: 'fixed_cost', counterparty: 'Fitnessstudio Beispiel', amount: '29,90', nextDueDate: '2026-10-03' }));
    expect(itemNamed('Fitness').check).toMatchObject({ status: 'ended', lastBooking: { date: '2026-05-03' } });

    // Ohne passende Buchung (wie Audible/Ring im Echtdaten-Test): Konto nicht importiert oder andere Schreibweise.
    createRecurringItem(db, manual({ name: 'Zeitung', counterparty: 'Zeitungsverlag Beispiel', amount: '20,00', nextDueDate: '2026-10-10', accountId: giro }));
    expect(itemNamed('Zeitung').check).toMatchObject({ status: 'no_bookings', missingCount: 3 });
  });

  it('nennt die Kündigungsfrist zum Vertragsende', () => {
    createRecurringItem(
      db,
      manual({ name: 'Fitness', kind: 'fixed_cost', counterparty: 'Fitnessstudio Beispiel', amount: '29,90', contractEndDate: '2027-01-31', noticePeriodValue: 3, noticePeriodUnit: 'months' }),
    );
    expect(itemNamed('Fitness')).toMatchObject({
      contractEndDate: '2027-01-31',
      noticePeriodValue: 3,
      noticePeriodUnit: 'months',
      check: { cancel: { cancelBy: '2026-10-31', state: 'soon' } },
    });
  });

  it('meldet doppelte Abos und zählt nur aktive Posten', () => {
    createRecurringItem(db, manual({ name: 'Spotify 1', counterparty: 'Spotify', amount: '10,99', nextDueDate: '2026-10-08' }));
    createRecurringItem(db, manual({ name: 'Spotify 2', counterparty: 'Spotify', amount: '10,99', nextDueDate: '2026-10-22' }));
    expect(itemNamed('Spotify 1')).toMatchObject({ bookingCount: 5, duplicates: ['Spotify 2'], check: { status: 'ok' } });
    expect(itemNamed('Spotify 2')).toMatchObject({ bookingCount: 5, duplicates: ['Spotify 1'], check: { status: 'ok' } });

    const id = itemNamed('Spotify 2').id;
    updateRecurringItem(db, id, manual({ name: 'Spotify 2', counterparty: 'Spotify', amount: '10,99', nextDueDate: '2026-10-22', active: false }));
    const overview = listRecurring(db, TODAY);
    expect(overview.items.find((i) => i.id === id)?.check.status).toBe('inactive');
    expect(overview.items.find((i) => i.name === 'Spotify 1')?.duplicates).toEqual([]);
    expect(overview.totals).toMatchObject({ count: 1, monthlyCents: 1099, subscriptionMonthlyCents: 1099 });
  });

  it('lehnt ungültige Eingaben ab', () => {
    expect(() => createRecurringItem(db, manual({ counterparty: 'X', amount: 'viel' }))).toThrow(/kein Betrag/);
    expect(() => createRecurringItem(db, manual({ counterparty: 'X', nextDueDate: '2026-02-30' }))).toThrow(/nächster Termin/);
    expect(() => createRecurringItem(db, manual({ counterparty: 'X', noticePeriodValue: 3 }))).toThrow(/braucht ein Vertragsende/);
    expect(() => createRecurringItem(db, manual({ counterparty: '' }))).toThrow(/Name oder Gegenpartei/);
  });
});

describe('Buchungen von Hand zuordnen', () => {
  beforeEach(setup);

  it('markiert eine Buchung als wiederkehrend, entfernt eine Fehlerkennung und hebt beides wieder auf', () => {
    const { id } = createRecurringItem(db, manual({ name: 'Ring', counterparty: 'Ring', amount: '8,00', nextDueDate: '2026-10-05' }));
    const ringTx = listTransactions(db, { recurringItemId: id }).items;
    expect(ringTx).toHaveLength(5);
    expect(ringTx[0]).toMatchObject({ recurringItemId: id, recurringItemName: 'Ring', recurringSource: 'auto' });

    // Fehlerkennung entfernen: diese Buchung gehört nicht dazu.
    const wrong = ringTx[2]!;
    setTransactionRecurring(db, wrong.id, null);
    expect(itemNamed('Ring')).toMatchObject({ bookingCount: 4, check: { missingCount: 1, status: 'ok' } });
    expect(listTransactions(db, { q: 'PAYPAL *RING', from: wrong.bookingDate, to: wrong.bookingDate }).items[0]).toMatchObject({
      recurringItemId: null,
      recurringSource: 'manual',
    });

    // Eine einmalige Amazon-Buchung von Hand zuordnen.
    const amazon = listTransactions(db, { q: 'AMAZON' }).items[0]!;
    setTransactionRecurring(db, amazon.id, id);
    expect(itemNamed('Ring').bookingCount).toBe(5);
    expect(listTransactions(db, { recurringItemId: id }).items.find((t) => t.id === amazon.id)?.recurringSource).toBe('manual');

    resetTransactionRecurring(db, wrong.id);
    resetTransactionRecurring(db, amazon.id);
    expect(itemNamed('Ring').bookingCount).toBe(5);

    // Löschen gibt von Hand zugeordnete Buchungen frei.
    setTransactionRecurring(db, amazon.id, id);
    deleteRecurringItem(db, id);
    expect(listTransactions(db, { q: 'AMAZON' }).items.every((t) => t.recurringSource === null)).toBe(true);
  });

  it('lässt Umbuchungen und Gutschriften nicht als Fixkosten markieren', () => {
    const { id } = createRecurringItem(db, manual({ name: 'X', counterparty: 'X' }));
    const transfer = listTransactions(db, { accountId: giro, transfers: 'only' }).items[0]!;
    expect(() => setTransactionRecurring(db, transfer.id, id)).toThrow(/Umbuchungen/);
    const salary = listTransactions(db, { accountId: giro, q: 'Lohn' }).items[0]!;
    expect(() => setTransactionRecurring(db, salary.id, id)).toThrow(/Nur Abbuchungen/);
  });
});

describe('Fixkosten-API', () => {
  let app: FastifyInstance;
  beforeEach(() => {
    setup();
    app = buildApp({ db });
  });
  afterEach(async () => {
    await app.close();
  });

  it('legt an, ändert, übernimmt, verwirft und löscht', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/recurring',
      payload: { kind: 'subscription', accountId: visa, counterparty: 'Ring', amount: '8,00', interval: 'monthly', nextDueDate: '2026-10-05' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(created.json().overview.items[0]).toMatchObject({ id, name: 'Ring', bookingCount: 5 });

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/recurring/${id}`,
      payload: { name: 'Ring Protect', kind: 'subscription', accountId: visa, counterparty: 'Ring', amount: '10,00', interval: 'monthly', nextDueDate: '2026-10-05', notes: 'Kamera' },
    });
    expect(updated.json().items[0]).toMatchObject({ name: 'Ring Protect', amountCents: 1000, notes: 'Kamera', check: { status: 'differs' } });

    const overview = (await app.inject({ method: 'GET', url: '/api/recurring' })).json();
    const telefon = overview.suggestions.find((s: { label: string }) => s.label === 'Beispiel Telefon GmbH');
    const confirmed = await app.inject({ method: 'POST', url: '/api/recurring/suggestions/confirm', payload: { key: telefon.key } });
    expect(confirmed.statusCode).toBe(201);
    const adac = overview.suggestions.find((s: { label: string }) => s.label === 'ADAC e.V.');
    const dismissed = await app.inject({ method: 'POST', url: '/api/recurring/suggestions/dismiss', payload: { key: adac.key } });
    expect(dismissed.json().dismissed).toHaveLength(1);

    const tx = listTransactions(db, { recurringItemId: id }).items[0]!;
    expect((await app.inject({ method: 'PUT', url: `/api/transactions/${tx.id}/recurring`, payload: { itemId: null } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/transactions/${tx.id}/recurring` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/transactions?recurringItemId=${id}` })).json().total).toBe(5);

    const removed = await app.inject({ method: 'DELETE', url: `/api/recurring/${id}` });
    expect(removed.json().items.some((i: { id: number }) => i.id === id)).toBe(false);
    expect((await app.inject({ method: 'DELETE', url: `/api/recurring/${id}` })).statusCode).toBe(404);
  });

  it('prüft Eingaben', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/recurring',
      payload: { kind: 'abo', accountId: null, counterparty: 'X', amount: '1,00', interval: 'monthly', nextDueDate: '2026-10-05' },
    });
    expect(bad.statusCode).toBe(400);
    const badAmount = await app.inject({
      method: 'POST',
      url: '/api/recurring',
      payload: { kind: 'subscription', accountId: null, counterparty: 'X', amount: 'x', interval: 'weekly', nextDueDate: '2026-10-05' },
    });
    expect(badAmount.statusCode).toBe(400);
  });
});
