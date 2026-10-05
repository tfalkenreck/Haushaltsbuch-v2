import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/connection.js';
import { createAccount } from '../src/services/accounts.js';
import { listCategories } from '../src/services/categories.js';
import { importFile, undoImport } from '../src/services/imports.js';
import { createRule } from '../src/services/rules.js';
import { listTransactions, setTransactionCategory, uncategorizedSummary } from '../src/services/transactions.js';
import {
  confirmOwnIbanPairs,
  confirmTransfer,
  countOwnIbanPairs,
  detectTransfers,
  dissolveTransfer,
  listCardRules,
  listTransfers,
  markTransfer,
  resetTransfer,
  unmarkTransfer,
  type Transfer,
} from '../src/services/transfers.js';
import { addDays } from '../src/lib/date.js';
import { createTestDb } from './helpers/db.js';
import { fixture, IBAN } from './helpers/fixtures.js';
import { volksbankCsv, type VbRow } from './helpers/volksbank-csv.js';

let db: Db;
let giro: number;
let ausgaben: number;
let spar: number;
let visa: number;

beforeEach(() => {
  db = createTestDb();
  giro = createAccount(db, { name: 'Giro', role: 'einnahmen', bankAdapter: 'volksbank-owl', iban: IBAN.volksbankGiro }).id;
  ausgaben = createAccount(db, { name: 'Ausgaben', role: 'ausgaben', bankAdapter: 'comdirect', iban: IBAN.comdirectGiro }).id;
  spar = createAccount(db, { name: 'Spar', role: 'sparen', bankAdapter: 'volksbank-owl', iban: IBAN.volksbankSpar }).id;
  visa = createAccount(db, { name: 'Visa', role: 'kreditkarte', bankAdapter: 'volksbank-owl', iban: IBAN.volksbankVisa }).id;
});

function run(accountId: number, path: string) {
  return importFile(db, { accountId, fileName: path, bytes: fixture(path) });
}

function importAll() {
  run(giro, 'umbuchungen/giro.csv');
  run(ausgaben, 'umbuchungen/comdirect.csv');
  run(spar, 'volksbank-owl/sparkonto.csv');
  run(visa, 'umbuchungen/visa.csv');
}

function tx(accountId: number, amountCents: number, date?: string): number {
  const row = db
    .prepare(`SELECT id FROM transactions WHERE account_id = ? AND amount_cents = ? ${date ? 'AND booking_date = ?' : ''} ORDER BY id`)
    .get(...(date ? [accountId, amountCents, date] : [accountId, amountCents])) as { id: number } | undefined;
  if (!row) throw new Error(`Buchung ${amountCents} auf Konto ${accountId} fehlt`);
  return row.id;
}

function transferOf(txId: number): Transfer | undefined {
  return listTransfers(db).find((t) => t.transactions.some((x) => x.id === txId));
}

function category(name: string): number {
  return listCategories(db).find((c) => c.name === name)?.id as number;
}

describe('Erkennung beim Import', () => {
  it('erkennt Paare, vermutete einseitige Umbuchungen und die Kartenabrechnung', () => {
    importAll();
    const transfers = listTransfers(db);

    // Dauerauftrag Giro → Ausgabenkonto: Paar über Betrag, Datum (1 Tag) und IBAN.
    expect(transferOf(tx(giro, -123456))).toMatchObject({
      kind: 'pair',
      origin: 'auto',
      status: 'suggested',
      fromAccountName: 'Giro',
      toAccountName: 'Ausgaben',
      amountCents: 123456,
      counterMissing: false,
    });
    expect(transferOf(tx(ausgaben, 123456))?.id).toBe(transferOf(tx(giro, -123456))?.id);

    // Sparrate September: Paar; August: Giro für August nicht importiert → einseitig über die IBAN.
    expect(transferOf(tx(spar, 10000, '2026-09-11'))).toMatchObject({ kind: 'pair', fromAccountName: 'Giro', toAccountName: 'Spar' });
    expect(transferOf(tx(spar, 10000, '2026-08-11'))).toMatchObject({
      kind: 'one_sided',
      fromAccountName: 'Giro',
      toAccountName: 'Spar',
      counterMissing: true,
      reason: 'Gegen-IBAN gehört zum Konto „Giro“',
    });

    // Tagesgeld bei einer anderen Bank: nur der Verwendungszweck.
    expect(transferOf(tx(giro, -2500))).toMatchObject({ kind: 'one_sided', toAccountId: null, reason: 'Verwendungszweck enthält „Umbuchung“' });

    // Kartenabrechnung 1:n: Abbuchung + Ausgleich tragen die Umbuchung, Zeitraum nach Kaufdatum.
    const card = transferOf(tx(giro, -10235));
    expect(card).toMatchObject({
      kind: 'card_settlement',
      fromAccountName: 'Giro',
      toAccountName: 'Visa',
      amountCents: 10235,
      periodStart: '2026-09-10',
      periodEnd: '2026-09-28',
      counterMissing: false,
      card: { purchaseCount: 3, purchasesCents: 10235, differenceCents: 0 },
    });
    expect(card?.transactions.map((t) => t.amountCents).sort()).toEqual([-10235, 10235].sort());

    // Überweisung an Erika und ihre Rückzahlung aufs Ausgabenkonto sind keine Umbuchung.
    expect(transferOf(tx(giro, -5000))).toBeUndefined();
    expect(transferOf(tx(ausgaben, 5000))).toBeUndefined();
    // Kartenumsätze bleiben Ausgaben.
    expect(transferOf(tx(visa, -4210))).toBeUndefined();

    expect(transfers).toHaveLength(5);
  });

  it('erkennt dasselbe unabhängig von der Import-Reihenfolge', () => {
    run(visa, 'umbuchungen/visa.csv');
    run(spar, 'volksbank-owl/sparkonto.csv');
    run(ausgaben, 'umbuchungen/comdirect.csv');
    const result = run(giro, 'umbuchungen/giro.csv');
    expect(result.transfersDetected).toBeGreaterThan(0);

    const kinds = listTransfers(db).map((t) => `${t.kind}:${t.amountCents}`).sort();
    expect(kinds).toEqual(['card_settlement:10235', 'one_sided:10000', 'one_sided:2500', 'pair:10000', 'pair:123456'].sort());
  });

  it('ergänzt eine einseitige Umbuchung, sobald die Gegenbuchung importiert wird', () => {
    run(giro, 'umbuchungen/giro.csv');
    // Ausgabenkonto noch nicht importiert: Gegen-IBAN gehört zum angelegten Konto → einseitig.
    expect(transferOf(tx(giro, -123456))).toMatchObject({ kind: 'one_sided', toAccountName: 'Ausgaben' });
    // Kreditkarte nur mit „Kreditkarte“ im Text und ohne Kartenumsätze: bleibt Ausgabe.
    expect(transferOf(tx(giro, -10235))).toBeUndefined();

    run(ausgaben, 'umbuchungen/comdirect.csv');
    run(visa, 'umbuchungen/visa.csv');
    expect(transferOf(tx(giro, -123456))).toMatchObject({ kind: 'pair', counterMissing: false });
    expect(transferOf(tx(ausgaben, 123456))?.id).toBe(transferOf(tx(giro, -123456))?.id);
    expect(transferOf(tx(giro, -10235))).toMatchObject({ kind: 'card_settlement', counterMissing: false });
  });

  it('meldet bei der Kartenabrechnung eine Abweichung zur Summe der Kartenumsätze', () => {
    run(visa, 'volksbank-owl/visa.csv'); // Ausgleich 250,00 €, Umsätze nur 87,35 €
    const settlement = listTransfers(db).find((t) => t.kind === 'card_settlement');
    expect(settlement).toMatchObject({ amountCents: 25000, counterMissing: true, fromAccountId: null });
    expect(settlement?.card?.differenceCents).toBe(25000 - (settlement?.card?.purchasesCents ?? 0));
    expect(settlement?.card?.differenceCents).not.toBe(0);
  });

  it('ändert keine bestehende Kategorie – weder per Regel noch von Hand gesetzt', () => {
    createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'max mustermann', categoryId: category('Sparen') });
    run(ausgaben, 'umbuchungen/comdirect.csv');
    const manual = tx(ausgaben, 123456);
    setTransactionCategory(db, manual, category('Einkommen'));
    run(giro, 'umbuchungen/giro.csv');

    const rows = db
      .prepare('SELECT id, category_id, category_source, transfer_id FROM transactions WHERE id IN (?, ?)')
      .all(manual, tx(giro, -123456)) as { id: number; category_id: number; category_source: string; transfer_id: number }[];
    expect(rows.every((r) => r.transfer_id !== null)).toBe(true);
    expect(rows.find((r) => r.id === manual)).toMatchObject({ category_id: category('Einkommen'), category_source: 'manual' });
    expect(rows.find((r) => r.id !== manual)).toMatchObject({ category_id: category('Sparen'), category_source: 'rule' });
  });
});

describe('Kartenabrechnung mit Abrechnungsdatum', () => {
  it('nimmt Kartenumsätze nach Buchungstag der Bank bis zum Abrechnungsdatum – Kauf vor, Buchung nach dem Datum zählt zur nächsten', () => {
    run(giro, 'kartenabrechnung/giro.csv');
    run(visa, 'kartenabrechnung/visa.csv');
    const settlements = listTransfers(db)
      .filter((t) => t.kind === 'card_settlement')
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    expect(settlements).toHaveLength(2);
    expect(settlements[0]).toMatchObject({
      amountCents: 8000,
      periodDate: 'bank_booking_date',
      periodStart: '2026-08-05',
      periodEnd: '2026-08-18',
      counterMissing: false,
      card: { purchaseCount: 1, purchasesCents: 8000, differenceCents: 0, rule: { date: 'bank_booking_date', cutoff: 'inclusive' }, boundaries: [] },
    });
    // Tankstelle: gekauft 17.08., gebucht 19.08. → September-Abrechnung.
    // Elektromarkt: gekauft 17.09., gebucht 19.09. → nicht in der Abrechnung vom 18.09.
    expect(settlements[1]).toMatchObject({
      amountCents: 19840,
      periodDate: 'bank_booking_date',
      periodStart: '2026-08-19',
      periodEnd: '2026-09-18',
      counterMissing: false,
      card: { purchaseCount: 3, purchasesCents: 19840, differenceCents: 0 },
    });
    // Kartenumsätze zählen weiter mit ihrem Kaufdatum.
    expect(db.prepare('SELECT booking_date FROM transactions WHERE account_id = ? AND amount_cents = -6499').get(visa)).toEqual({
      booking_date: '2026-09-17',
    });
  });

  it('berechnet Abrechnungen mit Abrechnungsdatum nach der Regel der Karte neu, auch bestätigte', () => {
    run(giro, 'kartenabrechnung/giro.csv');
    run(visa, 'kartenabrechnung/visa.csv');
    const september = listTransfers(db).find((t) => t.amountCents === 19840) as Transfer;
    confirmTransfer(db, september.id);
    db.prepare("UPDATE transfers SET period_date = NULL, period_start = '2026-08-19', period_end = '2026-09-21' WHERE id = ?").run(september.id);
    expect(listTransfers(db).find((t) => t.id === september.id)?.card?.differenceCents).not.toBe(0);

    detectTransfers(db);
    expect(listTransfers(db).find((t) => t.id === september.id)).toMatchObject({
      status: 'confirmed',
      periodDate: 'bank_booking_date',
      periodEnd: '2026-09-18',
      card: { differenceCents: 0 },
    });
  });
});

describe('Zuordnungsregel der Karte', () => {
  const de = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  /** Kartenumsatz: gekauft `purchase`, gebucht `booked`. */
  const card = (purchase: string, booked: string, euros: number): VbRow => ({
    date: booked,
    amountCents: -euros * 100,
    bookingText: 'Basislastschrift',
    purpose: `HAENDLER ${euros}  DE  12345678901   EUR  ${euros},00Umsatz vom ${de(purchase)}      Visa Hauptkarte`,
  });
  const credit = (statementDate: string, euros: number): VbRow => ({
    date: addDays(statementDate, 2),
    amountCents: euros * 100,
    bookingText: 'Gutschrift',
    purpose: `Ausgleich Kartenkonto Abrechnung vom ${de(statementDate)}`,
  });
  const purchases = [
    card('2026-06-01', '2026-06-02', 50),
    card('2026-06-18', '2026-06-19', 20),
    card('2026-07-05', '2026-07-06', 40),
    card('2026-07-17', '2026-07-19', 30),
    card('2026-08-10', '2026-08-11', 25),
    card('2026-09-01', '2026-09-02', 60),
    card('2026-09-18', '2026-09-19', 15),
  ];
  const importVisa = (rows: VbRow[]) =>
    importFile(db, { accountId: visa, fileName: 'visa.csv', bytes: volksbankCsv(IBAN.volksbankVisa, rows), periodStart: '2026-06-01', periodEnd: '2026-09-30' });
  const settlements = () =>
    listTransfers(db)
      .filter((t) => t.kind === 'card_settlement')
      .sort((a, b) => (a.periodEnd ?? '').localeCompare(b.periodEnd ?? ''));

  it('wählt je Karte die Regel, nach der die Abrechnungen aufgehen, und zeigt sie an', () => {
    // Die Bank rechnet nach Kaufdatum ab, Stichtag ausschließlich.
    importVisa([...purchases, credit('2026-06-18', 50), credit('2026-07-18', 90), credit('2026-08-18', 25), credit('2026-09-18', 60)]);
    expect(listCardRules(db)).toEqual([
      expect.objectContaining({ accountName: 'Visa', rule: { date: 'booking_date', cutoff: 'exclusive' }, statements: 4, checked: 3 }),
    ]);
    const list = settlements();
    expect(list.map((t) => [t.periodStart, t.periodEnd, t.periodDate, t.card?.differenceCents])).toEqual([
      ['2026-06-01', '2026-06-17', 'booking_date', 0],
      ['2026-06-18', '2026-07-17', 'booking_date', 0],
      ['2026-07-18', '2026-08-17', 'booking_date', 0],
      ['2026-08-18', '2026-09-17', 'booking_date', 0],
    ]);
    // Auch bestätigte Abrechnungen folgen der Regel der Karte.
    expect(list[1]?.card?.rule).toEqual({ date: 'booking_date', cutoff: 'exclusive' });
  });

  it('zeigt bei verbleibender Abweichung die Umsätze um die Grenze und die Gegenabweichung der Nachbarabrechnung', () => {
    // Ein Kauf am Stichtag (18.07.), den die Bank schon am 17.07. bucht und noch in die Juli-Abrechnung nimmt.
    importVisa([
      ...purchases,
      card('2026-07-18', '2026-07-17', 10),
      credit('2026-06-18', 50),
      credit('2026-07-18', 100),
      credit('2026-08-18', 25),
      credit('2026-09-18', 60),
    ]);
    const [, july, august] = settlements();
    expect(july?.card).toMatchObject({ differenceCents: 1000, rule: { date: 'booking_date', cutoff: 'exclusive' } });
    expect(august?.card?.differenceCents).toBe(-1000);
    const end = july?.card?.boundaries.find((b) => b.side === 'end');
    expect(end).toMatchObject({ neighborTransferId: august?.id, neighborDifferenceCents: -1000, counterDeviation: true });
    expect(end?.purchases.map((x) => [x.date, x.amountCents, x.inPeriod, x.explains])).toEqual([
      ['2026-07-17', -3000, true, false],
      ['2026-07-18', -1000, false, true],
    ]);
    expect(end?.purchases[1]?.purpose).toContain('HAENDLER 10');
    expect(august?.card?.boundaries.find((b) => b.side === 'start')).toMatchObject({ neighborTransferId: july?.id, counterDeviation: true });
  });
});

describe('Wirkung', () => {
  beforeEach(importAll);

  it('zählt Umbuchungen nicht als unkategorisierte Einnahme oder Ausgabe', () => {
    const real = db
      .prepare('SELECT count(*) AS n FROM transactions WHERE category_id IS NULL AND transfer_id IS NULL')
      .get() as { n: number };
    const summary = uncategorizedSummary(db);
    expect(summary.count).toBe(real.n);
    // Zuflüsse: Gehalt + Erikas Rückzahlung + Sparzinsen – keine Umbuchungen.
    expect(summary.inflowCents).toBe(285000 + 5000 + 42);
    expect(listTransactions(db, { uncategorized: true }).total).toBe(real.n);
  });

  it('kennzeichnet Umbuchungen in der Liste und rechnet sie aus den Summen heraus', () => {
    const page = listTransactions(db, { accountId: giro });
    const dauerauftrag = page.items.find((t) => t.amountCents === -123456);
    expect(dauerauftrag).toMatchObject({ transferKind: 'pair', transferStatus: 'suggested', transferSource: 'auto', transferAccountName: 'Ausgaben' });
    expect(page.outflowCents).toBe(-95000 - 5000);
    expect(page.transferOutflowCents).toBe(-123456 - 10000 - 2500 - 10235);
    expect(listTransactions(db, { accountId: giro, transfers: 'only' }).total).toBe(4);
    expect(listTransactions(db, { accountId: giro, transfers: 'exclude' }).total).toBe(3);
  });
});

describe('Von Hand', () => {
  beforeEach(importAll);

  it('markiert mit Gegenkonto als Paar und findet die Gegenbuchung', () => {
    const toErika = tx(giro, -5000);
    const transfer = markTransfer(db, toErika, { accountId: ausgaben });
    expect(transfer).toMatchObject({ kind: 'pair', origin: 'manual', status: 'confirmed', fromAccountName: 'Giro', toAccountName: 'Ausgaben' });
    expect(transfer.transactions.map((t) => t.id)).toContain(tx(ausgaben, 5000));
  });

  it('markiert ohne Gegenkonto als einseitige Umbuchung', () => {
    const miete = tx(giro, -95000);
    expect(markTransfer(db, miete, { accountId: null })).toMatchObject({ kind: 'one_sided', fromAccountId: giro, toAccountId: null });
  });

  it('„keine Umbuchung“ gibt die Gegenbuchung frei; die Erkennung lässt die Buchung danach in Ruhe', () => {
    const debit = tx(giro, -123456);
    const credit = tx(ausgaben, 123456);
    unmarkTransfer(db, debit);
    expect(transferOf(debit)).toBeUndefined();
    const rows = db.prepare('SELECT id, transfer_id, transfer_source FROM transactions WHERE id IN (?, ?)').all(debit, credit);
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: debit, transfer_id: null, transfer_source: 'manual' },
        { id: credit, transfer_id: null, transfer_source: null },
      ]),
    );

    detectTransfers(db);
    expect(transferOf(debit)).toBeUndefined();
    // Die freie Gegenbuchung bleibt ohne Partner eine normale Buchung (kein Hinweis im Text).
    expect(transferOf(credit)).toBeUndefined();

    // „Automatik zulassen“: wieder erkannt.
    resetTransfer(db, debit);
    expect(transferOf(debit)).toMatchObject({ kind: 'pair', origin: 'auto' });
  });

  it('bestätigt und hebt eine Fehlerkennung auf, ohne dass sie wiederkommt', () => {
    const t = transferOf(tx(giro, -2500)) as Transfer;
    expect(confirmTransfer(db, t.id).status).toBe('confirmed');

    expect(dissolveTransfer(db, t.id)).toEqual({ released: 1 });
    detectTransfers(db);
    expect(transferOf(tx(giro, -2500))).toBeUndefined();
    expect(uncategorizedSummary(db).outflowCents).toBeLessThanOrEqual(-2500);
  });

  it('legt bei einer Kreditkarte als Gegenkonto eine Kartenabrechnung an', () => {
    const settlement = transferOf(tx(giro, -10235)) as Transfer;
    dissolveTransfer(db, settlement.id);
    const marked = markTransfer(db, tx(giro, -10235), { accountId: visa });
    expect(marked).toMatchObject({
      kind: 'card_settlement',
      origin: 'manual',
      toAccountName: 'Visa',
      periodStart: '2026-09-10',
      periodEnd: '2026-09-28',
      card: { differenceCents: 0 },
    });
  });
});

describe('Sammelbestätigung', () => {
  it('bestätigt nur vorgeschlagene Paare, deren Gegen-IBAN das andere eigene Konto ist', () => {
    importAll();
    // Dauerauftrag (IBAN Ausgabenkonto) und Sparrate September (IBAN Sparkonto).
    expect(countOwnIbanPairs(db)).toEqual({ count: 2 });
    // Ohne Gegen-IBAN: kein Kandidat für die Sammelbestätigung.
    const sparrate = transferOf(tx(giro, -10000, '2026-09-11')) as Transfer;
    db.prepare('UPDATE transactions SET counterparty_iban = NULL WHERE transfer_id = ?').run(sparrate.id);
    expect(countOwnIbanPairs(db)).toEqual({ count: 1 });

    expect(confirmOwnIbanPairs(db)).toEqual({ confirmed: 1 });
    expect(transferOf(tx(giro, -123456))?.status).toBe('confirmed');
    expect(transferOf(tx(spar, 10000, '2026-09-11'))?.status).toBe('suggested');
    // Einseitige und Kartenabrechnungen bleiben vorgeschlagen.
    expect(transferOf(tx(spar, 10000, '2026-08-11'))?.status).toBe('suggested');
    expect(countOwnIbanPairs(db)).toEqual({ count: 0 });
  });
});

describe('Rückgängig', () => {
  it('löst Paare auf und erkennt die übrige Seite neu', () => {
    importAll();
    const batch = (db.prepare('SELECT id FROM import_batches WHERE account_id = ?').get(ausgaben) as { id: number }).id;
    undoImport(db, batch);
    // Gegen-IBAN gehört weiter zum angelegten Ausgabenkonto → einseitig.
    expect(transferOf(tx(giro, -123456))).toMatchObject({ kind: 'one_sided', toAccountName: 'Ausgaben', origin: 'auto' });
    expect(db.prepare('SELECT count(*) AS n FROM transfers t WHERE NOT EXISTS (SELECT 1 FROM transactions x WHERE x.transfer_id = t.id)').get()).toEqual({ n: 0 });

    run(ausgaben, 'umbuchungen/comdirect.csv');
    expect(transferOf(tx(giro, -123456))).toMatchObject({ kind: 'pair' });
  });
});
