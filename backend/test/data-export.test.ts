import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/connection.js';
import { createAccount } from '../src/services/accounts.js';
import { getAttention } from '../src/services/attention.js';
import { setManualBalance } from '../src/services/balances.js';
import { exportData, exportStatus, importData, type DataExport } from '../src/services/data-export.js';
import { importFile } from '../src/services/imports.js';
import { createRecurringItem } from '../src/services/recurring.js';
import { createRule } from '../src/services/rules.js';
import { createSavingsGoal } from '../src/services/savings-goals.js';
import { listTransactions, setTransactionCategory } from '../src/services/transactions.js';
import { listTransfers } from '../src/services/transfers.js';
import { createTestDb } from './helpers/db.js';
import { IBAN } from './helpers/fixtures.js';
import { volksbankCsv } from './helpers/volksbank-csv.js';

/*
 * Ein kleiner, aber vollständiger Bestand: zwei Konten mit Importen und
 * erkannter Umbuchung, Regel, Kategorie von Hand, Fixkosten, Sparziel,
 * Kontostand von Hand.
 */
let db: Db;
const category = (name: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number }).id;

function fill(target: Db): void {
  const giro = createAccount(target, { name: 'Giro', role: 'einnahmen', bankAdapter: 'volksbank-owl', iban: IBAN.volksbankGiro }).id;
  const spar = createAccount(target, { name: 'Spar', role: 'sparen', bankAdapter: 'volksbank-owl', iban: IBAN.volksbankSpar }).id;
  const lebensmittel = (target.prepare("SELECT id FROM categories WHERE name = 'Lebensmittel'").get() as { id: number }).id;
  createRule(target, { field: 'counterparty', patternType: 'contains', pattern: 'REWE', categoryId: lebensmittel, priority: 1 });
  importFile(target, {
    accountId: giro,
    fileName: 'giro.csv',
    bytes: volksbankCsv(
      IBAN.volksbankGiro,
      [
        { date: '2026-09-01', amountCents: 350000, counterparty: 'Arbeitgeber GmbH', purpose: 'Lohn – September' },
        { date: '2026-09-02', amountCents: -4567, counterparty: 'REWE Markt', bookingText: 'Kartenzahlung', purpose: 'REWE „SAGT DANKE“ – 50 %' },
        { date: '2026-09-05', amountCents: -1299, counterparty: 'Netflix', purpose: 'Abo', creditorId: 'DE11ZZZ00000000001', mandateReference: 'N-1' },
        { date: '2026-09-15', amountCents: -20000, counterparty: 'Ich', counterpartyIban: IBAN.volksbankSpar, purpose: 'Sparen' },
      ],
      100000,
    ),
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
  });
  importFile(target, {
    accountId: spar,
    fileName: 'spar.csv',
    bytes: volksbankCsv(IBAN.volksbankSpar, [{ date: '2026-09-15', amountCents: 20000, counterparty: 'Ich', counterpartyIban: IBAN.volksbankGiro, purpose: 'Sparen' }]),
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
  });
  const netflix = listTransactions(target, { q: 'Netflix' }).items[0]!;
  setTransactionCategory(target, netflix.id, (target.prepare("SELECT id FROM categories WHERE name = 'Abos & Mitgliedschaften'").get() as { id: number }).id);
  createRecurringItem(target, { kind: 'subscription', accountId: giro, counterparty: 'Netflix', amount: '12,99', interval: 'monthly', nextDueDate: '2026-10-05' });
  createSavingsGoal(target, { name: 'Urlaub', amount: '1.500', targetDate: '2027-06-30' });
  setManualBalance(target, giro, { date: '2026-09-30', amount: '4.231,34' });
}

beforeEach(() => {
  db = createTestDb();
  fill(db);
});

/** Wie in einer Datei: einmal durch JSON. */
const roundTrip = (data: DataExport): unknown => JSON.parse(JSON.stringify(data));

describe('Export und Re-Import', () => {
  it('ergibt nach Export → Import identische Daten', () => {
    const exported = exportData(db, '2026-10-05T10:00:00.000Z');
    expect(exported).toMatchObject({ format: 'haushaltsbuch-export', version: 1, schemaVersion: 9 });
    expect(exported.tables['transactions']).toHaveLength(5);
    expect(listTransfers(db)).toHaveLength(1);

    const fresh = createTestDb();
    const result = importData(fresh, roundTrip(exported));
    expect(result.rows).toMatchObject({ accounts: 2, transactions: 5, transfers: 1, rules: 1, recurring_items: 1, savings_goals: 1, balance_anchors: 1 });

    const again = exportData(fresh, '2026-10-06T10:00:00.000Z');
    expect(again.tables).toEqual(exported.tables);
    // Geld bleibt exakt in Cent, Sonderzeichen im Verwendungszweck unverändert.
    expect(listTransactions(fresh, { q: 'REWE' }).items[0]).toMatchObject({ amountCents: -4567, purpose: 'REWE „SAGT DANKE“ – 50 %', categorySource: 'rule' });
    expect(listTransfers(fresh)).toEqual(listTransfers(db));
    // Die Kategorien aus der Datei ersetzen die einer frischen Datenbank.
    expect(fresh.prepare('SELECT count(*) AS n FROM categories').get()).toEqual(db.prepare('SELECT count(*) AS n FROM categories').get());
    // Der importierte Stand gilt als gesichert – so alt wie die Datei.
    expect(exportStatus(fresh)).toEqual({ lastExportAt: '2026-10-06T10:00:00.000Z', empty: false });
  });

  it('übernimmt umbenannte und eigene Kategorien samt Zuordnung', () => {
    db.prepare("UPDATE categories SET name = 'Essen' WHERE name = 'Lebensmittel'").run();
    const exported = roundTrip(exportData(db));
    const fresh = createTestDb();
    importData(fresh, exported);
    expect(listTransactions(fresh, { q: 'REWE' }).items[0]?.categoryId).toBe(category('Essen'));
  });

  it('importiert nur in eine leere Datenbank mit demselben Stand', () => {
    const exported = exportData(db) as unknown as Record<string, unknown>;
    expect(() => importData(db, exported)).toThrow(/nur in eine leere Datenbank/);
    const fresh = createTestDb();
    expect(() => importData(fresh, { ...exported, schemaVersion: 7 })).toThrow(/anderen Programmstand/);
    expect(() => importData(fresh, { format: 'etwas anderes' })).toThrow(/keine Exportdatei/);
    const tables = exported['tables'] as Record<string, Record<string, unknown>[]>;
    expect(() => importData(fresh, { ...exported, tables: { ...tables, fremd: [] } })).toThrow(/Unbekannte Tabelle/);
    const { accounts: _accounts, ...withoutAccounts } = tables;
    expect(() => importData(fresh, { ...exported, tables: withoutAccounts })).toThrow(/„accounts“ fehlt/);
    // Kommabetrag in einer Cent-Spalte: die STRICT-Tabelle lehnt ab, nichts wird übernommen.
    const broken = structuredClone(tables);
    (broken['transactions']![0] as Record<string, unknown>)['amount_cents'] = 12.5;
    expect(() => importData(fresh, { ...exported, tables: broken })).toThrow(/Ungültige Zeile in Tabelle „transactions“/);
    expect(exportStatus(fresh)).toEqual({ lastExportAt: null, empty: true });
    // Verweis ins Leere.
    const dangling = structuredClone(tables);
    dangling['import_batches'] = [];
    expect(() => importData(fresh, { ...exported, tables: dangling })).toThrow(/nicht stimmig/);
    expect(exportStatus(fresh).empty).toBe(true);
  });

  it('erinnert auf der Übersicht, wenn länger als 30 Tage nicht exportiert wurde', () => {
    const exportDue = (today: string) => getAttention(db, today).find((i) => i.kind === 'export_due');
    expect(exportDue('2026-10-05')).toEqual({ kind: 'export_due', severity: 'info', lastExportAt: null, days: null });
    exportData(db, '2026-10-05T10:00:00.000Z');
    expect(exportDue('2026-11-04')).toBeUndefined();
    expect(exportDue('2026-11-05')).toMatchObject({ lastExportAt: '2026-10-05T10:00:00.000Z', days: 31 });
    // Ohne Buchungen gibt es nichts zu sichern.
    expect(getAttention(createTestDb(), '2026-10-05').some((i) => i.kind === 'export_due')).toBe(false);
  });
});

describe('Export-API', () => {
  let app: FastifyInstance;
  let fresh: Db;
  beforeEach(() => {
    fresh = createTestDb();
    app = buildApp({ db });
  });
  afterEach(async () => {
    await app.close();
  });

  it('liefert die Datei zum Herunterladen und nimmt sie auf einem neuen Rechner wieder an', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/export/status' })).json()).toEqual({ lastExportAt: null, empty: false });
    const res = await app.inject({ method: 'POST', url: '/api/export' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="haushaltsbuch-\d{4}-\d{2}-\d{2}-export\.json"/);
    expect((await app.inject({ method: 'GET', url: '/api/export/status' })).json().lastExportAt).not.toBeNull();

    const other = buildApp({ db: fresh });
    const imported = await other.inject({ method: 'POST', url: '/api/export/import', payload: res.body, headers: { 'content-type': 'application/json' } });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().rows.transactions).toBe(5);
    const again = await other.inject({ method: 'POST', url: '/api/export/import', payload: res.body, headers: { 'content-type': 'application/json' } });
    expect(again.statusCode).toBe(409);
    await other.close();
  });
});
