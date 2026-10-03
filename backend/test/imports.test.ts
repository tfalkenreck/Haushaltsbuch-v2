import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/connection.js';
import { createAccount, getAccount } from '../src/services/accounts.js';
import { getCoverage, mergePeriods } from '../src/services/coverage.js';
import { importFile, importHash, importHashes, listImportBatches, undoImport } from '../src/services/imports.js';
import { listTransactions, recomputeCounterpartyNormalized } from '../src/services/transactions.js';
import { createTestDb } from './helpers/db.js';
import { fixture, IBAN } from './helpers/fixtures.js';

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

function account(bankAdapter: string, iban: string | null, role = 'einnahmen', name = 'Konto'): number {
  return createAccount(db, { name, role, bankAdapter, iban }).id;
}

function run(accountId: number, path: string, extra: { periodStart?: string; periodEnd?: string } = {}) {
  return importFile(db, { accountId, fileName: path.split('/').pop() ?? path, bytes: fixture(path), ...extra });
}

function count(accountId: number): number {
  return (db.prepare('SELECT count(*) AS n FROM transactions WHERE account_id = ?').get(accountId) as { n: number }).n;
}

describe('importHash', () => {
  it('unterscheidet identische Zeilen über die laufende Nummer', () => {
    expect(importHash(1, '2026-09-15', -320, 'X', 0)).not.toBe(importHash(1, '2026-09-15', -320, 'X', 1));
  });

  it('hängt vom Konto ab', () => {
    expect(importHash(1, '2026-09-15', -320, 'X', 0)).not.toBe(importHash(2, '2026-09-15', -320, 'X', 0));
  });

  it('zählt nur identische Zeilen hoch', () => {
    const base = { line: 1, bankBookingDate: '2026-09-15', valueDate: null, currency: 'EUR', counterparty: '', counterpartyIban: null, bookingText: '',
      creditorId: null, mandateReference: null, balanceAfterCents: null, bankReference: null, accountIban: null };
    const hashes = importHashes(1, [
      { ...base, bookingDate: '2026-09-15', amountCents: -320, purpose: 'X' },
      { ...base, bookingDate: '2026-09-15', amountCents: -100, purpose: 'Y' },
      { ...base, bookingDate: '2026-09-15', amountCents: -320, purpose: 'X' },
    ]);
    expect(hashes).toEqual([
      importHash(1, '2026-09-15', -320, 'X', 0),
      importHash(1, '2026-09-15', -100, 'Y', 0),
      importHash(1, '2026-09-15', -320, 'X', 1),
    ]);
  });
});

describe('Import Volksbank', () => {
  it('importiert alle Buchungen mit Normalisierung und Zusatzfeldern', () => {
    const id = account('volksbank-owl', IBAN.volksbankGiro);
    const result = run(id, 'volksbank-owl/giro.csv');

    expect(result).toMatchObject({ imported: 10, duplicates: 0, otherAccount: 0, periodStart: '2026-09-01', periodEnd: '2026-10-02' });
    expect(result.batchId).not.toBeNull();

    const row = db
      .prepare("SELECT * FROM transactions WHERE counterparty = 'Stadtwerke Musterstadt GmbH'")
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      counterparty_normalized: 'stadtwerke musterstadt',
      counterparty_iban: 'DE76123456780000000006',
      creditor_id: 'DE00ZZZ00000000003',
      mandate_reference: 'MANDAT-0815',
      booking_text: 'Basislastschrift',
      purpose: 'Abschlag Strom; Vertrag 4711 09/2026',
      amount_cents: -8500,
      import_batch_id: result.batchId,
    });
    expect(typeof row['balance_after_cents']).toBe('number');
  });

  it('behält zwei echte gleiche Zahlungen als zwei Buchungen', () => {
    const id = account('volksbank-owl', IBAN.volksbankGiro);
    run(id, 'volksbank-owl/giro.csv');
    const n = db.prepare("SELECT count(*) AS n FROM transactions WHERE counterparty = 'Bäckerei Müller'").get();
    expect(n).toEqual({ n: 2 });
  });

  it('erzeugt beim erneuten Import derselben Datei keine Duplikate und keinen leeren Importvorgang', () => {
    const id = account('volksbank-owl', IBAN.volksbankGiro);
    run(id, 'volksbank-owl/giro.csv');
    const again = run(id, 'volksbank-owl/giro.csv');

    expect(again).toMatchObject({ batchId: null, imported: 0, duplicates: 10 });
    expect(again.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/bereits am .* importiert/),
        expect.stringMatching(/überschneidet sich/),
        'Alle Buchungen der Datei sind bereits vorhanden – es wurde nichts importiert.',
      ]),
    );
    expect(count(id)).toBe(10);
    expect(listImportBatches(db, id)).toHaveLength(1);
  });

  it('überspringt bei überlappenden Dateien nur die Duplikate und warnt', () => {
    const id = account('volksbank-owl', IBAN.volksbankGiro);
    run(id, 'volksbank-owl/giro.csv');
    const second = run(id, 'volksbank-owl/giro-oktober.csv');

    expect(second).toMatchObject({ imported: 1, duplicates: 2 });
    expect(second.warnings.some((w) => w.includes('überschneidet sich') && w.includes('02.10.2026'))).toBe(true);
    expect(count(id)).toBe(11);
  });

  it('übernimmt den Saldo der jüngsten Zeile als Kontostand', () => {
    const id = account('volksbank-owl', IBAN.volksbankGiro);
    run(id, 'volksbank-owl/giro.csv');
    run(id, 'volksbank-owl/giro-oktober.csv');
    const a = getAccount(db, id);
    const sum = (db.prepare('SELECT sum(amount_cents) AS s FROM transactions').get() as { s: number }).s;
    expect(a).toMatchObject({
      balanceCents: 100000 + sum,
      balanceDate: '2026-10-05',
      coverageStart: '2026-09-01',
      coverageEnd: '2026-10-05',
      transactionCount: 11,
    });
  });

  it('meldet eine Saldo-Lücke als Warnung', () => {
    const id = account('volksbank-owl', IBAN.volksbankGiro);
    const result = run(id, 'volksbank-owl/giro-saldo-luecke.csv');
    expect(result.warnings.some((w) => w.startsWith('Saldo passt nicht'))).toBe(true);
  });

  it('bucht Kartenumsätze mit ihrem eigenen Datum', () => {
    const id = account('volksbank-owl', IBAN.volksbankVisa, 'kreditkarte');
    run(id, 'volksbank-owl/visa.csv');
    const row = db.prepare('SELECT booking_date, value_date, counterparty, counterparty_normalized FROM transactions WHERE amount_cents = -1525').get();
    expect(row).toEqual({
      booking_date: '2026-09-30',
      value_date: '2026-10-01',
      counterparty: 'PAYPAL *STREAMINGDIENST',
      counterparty_normalized: 'paypal streamingdienst',
    });
    expect(getAccount(db, id).balanceCents).toBe(-13735);
  });
});

describe('Kartenumsätze: Kaufdatum und Buchungstag der Bank', () => {
  it('prüft den Exportzeitraum gegen den Buchungstag, nicht gegen das Kaufdatum', () => {
    const id = account('volksbank-owl', IBAN.volksbankVisa, 'kreditkarte');
    // Kauf vom 29.12.2026, gebucht am 02.01.2027 – Export ab 01.01.2027.
    const result = run(id, 'volksbank-owl/visa-jahreswechsel.csv', { periodStart: '2027-01-01', periodEnd: '2027-01-31' });
    expect(result).toMatchObject({ imported: 2, periodStart: '2027-01-01', periodEnd: '2027-01-31' });

    const row = db.prepare('SELECT booking_date, bank_booking_date FROM transactions WHERE amount_cents = -5000').get();
    expect(row).toEqual({ booking_date: '2026-12-29', bank_booking_date: '2027-01-02' });
  });

  it('weist den Zeitraum weiterhin zurück, wenn ein Buchungstag außerhalb liegt', () => {
    const id = account('volksbank-owl', IBAN.volksbankVisa, 'kreditkarte');
    expect(() => run(id, 'volksbank-owl/visa-jahreswechsel.csv', { periodStart: '2027-01-03' })).toThrow(
      /beginnt nach der ersten Buchung der Datei \(Buchungstag 02\.01\.2027\)/,
    );
  });

  it('leitet den Zeitraum ohne Angabe aus den Buchungstagen ab', () => {
    const id = account('volksbank-owl', IBAN.volksbankVisa, 'kreditkarte');
    const result = run(id, 'volksbank-owl/visa-jahreswechsel.csv');
    expect(result).toMatchObject({ periodStart: '2027-01-02', periodEnd: '2027-01-15' });
  });

  it('zeigt in der Abdeckung keinen Monat, der nie exportiert wurde', () => {
    const id = account('volksbank-owl', IBAN.volksbankVisa, 'kreditkarte');
    run(id, 'volksbank-owl/visa-jahreswechsel.csv', { periodStart: '2027-01-01', periodEnd: '2027-01-31' });
    const coverage = getCoverage(db, id, '2027-01-31');
    expect(coverage.months).toEqual([{ month: '2027-01', status: 'complete', transactionCount: 2 }]);
  });

  it('wertet weiter nach Kaufdatum aus', () => {
    const id = account('volksbank-owl', IBAN.volksbankVisa, 'kreditkarte');
    run(id, 'volksbank-owl/visa-jahreswechsel.csv');
    const december = listTransactions(db, { from: '2026-12-01', to: '2026-12-31' });
    expect(december.items.map((t) => t.amountCents)).toEqual([-5000]);
    expect(december.items[0]?.bookingDate).toBe('2026-12-29');
  });

  it('übernimmt bei Girobuchungen den Buchungstag unverändert', () => {
    const id = account('volksbank-owl', IBAN.volksbankGiro);
    run(id, 'volksbank-owl/giro.csv');
    const differing = db.prepare('SELECT count(*) AS n FROM transactions WHERE bank_booking_date IS NOT booking_date').get();
    expect(differing).toEqual({ n: 0 });
  });

  it('markiert Importe ohne Buchungstag der Bank (Altbestand) zum Neuimport', () => {
    const id = account('volksbank-owl', IBAN.volksbankVisa, 'kreditkarte');
    const giro = account('volksbank-owl', IBAN.volksbankGiro, 'einnahmen', 'Giro');
    run(id, 'volksbank-owl/visa.csv');
    run(giro, 'volksbank-owl/giro.csv');
    expect(listImportBatches(db, id)[0]?.needsReimport).toBe(false);

    db.prepare("UPDATE transactions SET bank_booking_date = NULL WHERE purpose LIKE '%Umsatz vom%'").run();
    expect(listImportBatches(db, id)[0]?.needsReimport).toBe(true);
    expect(getAccount(db, id).needsReimport).toBe(true);
    expect(listImportBatches(db, giro)[0]?.needsReimport).toBe(false);
    expect(getAccount(db, giro).needsReimport).toBe(false);

    // Rückgängig und neu importieren behebt es.
    undoImport(db, listImportBatches(db, id)[0]?.id as number);
    run(id, 'volksbank-owl/visa.csv');
    expect(getAccount(db, id).needsReimport).toBe(false);
  });
});

describe('Erneuter Import trägt fehlende Angaben nach', () => {
  /** Zustand vor Migration 004: Kartenumsätze ohne Buchungstag, Zeitraum aus dem Kaufdatum. */
  function legacyVisa(): { id: number; batchId: number } {
    const id = account('volksbank-owl', IBAN.volksbankVisa, 'kreditkarte');
    const batchId = run(id, 'volksbank-owl/visa.csv').batchId as number;
    db.prepare("UPDATE transactions SET bank_booking_date = NULL, balance_after_cents = NULL WHERE purpose LIKE '%Umsatz vom%'").run();
    db.prepare("UPDATE import_batches SET period_start = '2026-09-28' WHERE id = ?").run(batchId);
    return { id, batchId };
  }

  it('ergänzt den Buchungstag der Bank statt nur zu überspringen, und der Neuimport-Hinweis verschwindet', () => {
    const { id, batchId } = legacyVisa();
    expect(getAccount(db, id).needsReimport).toBe(true);

    const result = run(id, 'volksbank-owl/visa.csv');
    expect(result).toMatchObject({ batchId: null, imported: 0, duplicates: 4, backfilled: 2 });
    expect(result.warnings).toContain('Alle Buchungen der Datei sind bereits vorhanden – es wurde nichts neu importiert.');

    const rewe = db.prepare('SELECT booking_date, bank_booking_date, balance_after_cents FROM transactions WHERE amount_cents = -4210').get();
    expect(rewe).toEqual({ booking_date: '2026-09-28', bank_booking_date: '2026-09-29', balance_after_cents: -34210 });
    expect(getAccount(db, id).needsReimport).toBe(false);
    expect(listImportBatches(db, id)).toEqual([expect.objectContaining({ id: batchId, needsReimport: false, periodStart: '2026-09-29' })]);
    expect(listTransactions(db, { accountId: id }).total).toBe(4);
  });

  it('lässt Kategorien, Umbuchungen, Notizen und vorhandene Werte unangetastet', () => {
    const { id } = legacyVisa();
    const rewe = (db.prepare('SELECT id FROM transactions WHERE amount_cents = -4210').get() as { id: number }).id;
    const lebensmittel = (db.prepare("SELECT id FROM categories WHERE name = 'Lebensmittel'").get() as { id: number }).id;
    db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual', notes = 'Wocheneinkauf', transfer_source = 'manual', value_date = '2026-09-27' WHERE id = ?").run(
      lebensmittel,
      rewe,
    );
    const before = db.prepare('SELECT category_id, category_source, category_rule_id, transfer_id, transfer_source, notes, value_date FROM transactions ORDER BY id').all();

    expect(run(id, 'volksbank-owl/visa.csv').backfilled).toBe(2);

    const after = db.prepare('SELECT category_id, category_source, category_rule_id, transfer_id, transfer_source, notes, value_date FROM transactions ORDER BY id').all();
    expect(after).toEqual(before);
  });

  it('meldet keine Nachträge, wenn nichts fehlt', () => {
    const id = account('volksbank-owl', IBAN.volksbankGiro);
    run(id, 'volksbank-owl/giro.csv');
    const again = run(id, 'volksbank-owl/giro.csv');
    expect(again).toMatchObject({ imported: 0, backfilled: 0 });
    expect(again.warnings).toContain('Alle Buchungen der Datei sind bereits vorhanden – es wurde nichts importiert.');
  });

  it('ergänzt auch, wenn die Datei zusätzlich neue Buchungen enthält', () => {
    const id = account('volksbank-owl', IBAN.volksbankGiro);
    run(id, 'volksbank-owl/giro-oktober.csv');
    db.prepare('UPDATE transactions SET creditor_id = NULL, mandate_reference = NULL').run();
    const result = run(id, 'volksbank-owl/giro.csv');
    expect(result).toMatchObject({ imported: 8, duplicates: 2, backfilled: 2 });
    expect(db.prepare("SELECT creditor_id FROM transactions WHERE counterparty = 'BAECKEREI MUSTERMANN'").get()).toEqual({
      creditor_id: 'DE00ZZZ00000000001',
    });
  });
});

describe('Prüfung des Auftragskontos', () => {
  it('importiert aus einer Datei mit mehreren Konten nur die passenden Zeilen', () => {
    const giro = account('volksbank-owl', IBAN.volksbankGiro, 'einnahmen', 'Giro');
    account('volksbank-owl', IBAN.volksbankSpar, 'sparen', 'Sparkonto');
    const result = run(giro, 'volksbank-owl/mehrere-konten.csv');

    expect(result).toMatchObject({ imported: 3, otherAccount: 3 });
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/3 Zeile\(n\) gehören zu einem anderen Konto .*Konto „Sparkonto“/)]),
    );
    expect(listImportBatches(db, giro)[0]?.rowsSkipped).toBe(3);
  });

  it('bricht ab, wenn die Datei zu einem anderen Konto gehört', () => {
    const giro = account('volksbank-owl', IBAN.volksbankGiro, 'einnahmen', 'Giro');
    expect(() => run(giro, 'volksbank-owl/visa.csv')).toThrow(/gehört nicht zum Konto „Giro“.*Falsche Datei/);
    expect(count(giro)).toBe(0);
  });

  it('erkennt die Datei eines anderen angelegten Kontos auch ohne eigene IBAN', () => {
    const ohne = account('volksbank-owl', null, 'einnahmen', 'Ohne IBAN');
    account('volksbank-owl', IBAN.volksbankVisa, 'kreditkarte', 'Visa');
    expect(() => run(ohne, 'volksbank-owl/visa.csv')).toThrow(/gehört zum Konto „Visa“/);
  });

  it('importiert ohne hinterlegte IBAN, weist aber darauf hin', () => {
    const id = account('volksbank-owl', null);
    const result = run(id, 'volksbank-owl/sparkonto.csv');
    expect(result.imported).toBe(3);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/keine IBAN hinterlegt/)]));
  });

  it('verlangt bei mehreren Auftragskonten eine IBAN am Konto', () => {
    const id = account('volksbank-owl', null);
    expect(() => run(id, 'volksbank-owl/mehrere-konten.csv')).toThrow(/mehrerer Konten.*IBAN hinterlegen/);
  });
});

describe('Import Comdirect', () => {
  it('importiert, meldet vorgemerkte Umsätze und übernimmt den Kontostand', () => {
    const id = account('comdirect', IBAN.comdirectGiro, 'ausgaben');
    const result = run(id, 'comdirect/mit-metadaten.csv');

    expect(result).toMatchObject({ imported: 3, duplicates: 0 });
    expect(result.pending).toHaveLength(1);
    expect(result.ignored).toHaveLength(1);
    expect(getAccount(db, id)).toMatchObject({ balanceCents: 123456, balanceDate: '2026-10-02' });

    const ref = db.prepare('SELECT bank_reference, purpose FROM transactions WHERE amount_cents = -10000').get();
    expect(ref).toEqual({
      bank_reference: '2A2B2C2D2E2F2G2H/44444',
      purpose: '0000000 Tarif Plus lfd. Btr OP00000000 01.10.2026 - 01. 11.2026',
    });
  });

  it('führt Schreibweisen derselben Gegenpartei zusammen', () => {
    const id = account('comdirect', IBAN.comdirectGiro, 'ausgaben');
    run(id, 'comdirect/girokonto.csv');
    const rows = db
      .prepare("SELECT DISTINCT counterparty_normalized AS n FROM transactions WHERE counterparty LIKE 'B%Lebensversicherung%'")
      .all();
    expect(rows).toEqual([{ n: 'b v lebensversicherung' }]);
  });
});

describe('Fehlermeldungen bei falschem Adapter', () => {
  it('nennen den Adapter, die Alternativen und den passenden Adapter', () => {
    const id = account('comdirect', null, 'ausgaben');
    expect(() => run(id, 'volksbank-owl/giro.csv')).toThrow(
      'Comdirect-Adapter erkennt keine Kopfzeile. Verfügbar: volksbank-owl. Die Datei passt zum Adapter volksbank-owl – ist beim Konto der richtige Adapter gewählt?',
    );
  });

  it('melden bei falschem Encoding den Volksbank-Adapter', () => {
    const id = account('volksbank-owl', null);
    expect(() => run(id, 'comdirect/girokonto.csv')).toThrow(/^Volksbank-Adapter: .*UTF-8.* Verfügbar: comdirect\. Die Datei passt zum Adapter comdirect/);
  });

  it('lehnen deaktivierte Konten ab', () => {
    const id = account('volksbank-owl', IBAN.volksbankGiro);
    db.prepare('UPDATE accounts SET active = 0 WHERE id = ?').run(id);
    expect(() => run(id, 'volksbank-owl/giro.csv')).toThrow(/deaktiviert/);
  });
});

describe('Rückgängig', () => {
  it('entfernt einen Importvorgang samt Buchungen als Einheit', () => {
    const id = account('volksbank-owl', IBAN.volksbankGiro);
    const first = run(id, 'volksbank-owl/giro.csv');
    const second = run(id, 'volksbank-owl/giro-oktober.csv');

    const undo = undoImport(db, second.batchId as number);
    expect(undo).toMatchObject({ deletedTransactions: 1, warnings: [] });
    expect(count(id)).toBe(10);
    expect(listImportBatches(db, id).map((b) => b.id)).toEqual([first.batchId]);

    // danach lässt sich die Datei erneut importieren
    expect(run(id, 'volksbank-owl/giro-oktober.csv')).toMatchObject({ imported: 1, duplicates: 2 });
  });

  it('warnt, wenn überschneidende Importe Duplikate übersprungen haben', () => {
    const id = account('volksbank-owl', IBAN.volksbankGiro);
    const first = run(id, 'volksbank-owl/giro.csv');
    run(id, 'volksbank-owl/giro-oktober.csv');

    const undo = undoImport(db, first.batchId as number);
    expect(undo.deletedTransactions).toBe(10);
    expect(undo.warnings[0]).toMatch(/giro-oktober\.csv.*erneut importieren/);
  });

  it('meldet unbekannte Importvorgänge', () => {
    expect(() => undoImport(db, 999)).toThrow(/existiert nicht/);
  });
});

describe('Abdeckung', () => {
  it('fasst angrenzende Zeiträume zusammen', () => {
    expect(
      mergePeriods([
        { start: '2026-09-01', end: '2026-09-30' },
        { start: '2026-08-01', end: '2026-08-31' },
        { start: '2026-11-01', end: '2026-11-30' },
      ]),
    ).toEqual([
      { start: '2026-08-01', end: '2026-09-30' },
      { start: '2026-11-01', end: '2026-11-30' },
    ]);
  });

  it('nutzt den Exportzeitraum und zeigt den offenen Zeitraum bis heute', () => {
    const id = account('volksbank-owl', IBAN.volksbankSpar, 'sparen');
    run(id, 'volksbank-owl/sparkonto.csv', { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
    const coverage = getCoverage(db, id, '2026-10-03');

    expect(coverage.periods).toEqual([{ start: '2026-07-01', end: '2026-09-30' }]);
    expect(coverage.gaps).toEqual([{ start: '2026-10-01', end: '2026-10-03' }]);
    expect(coverage.months).toEqual([
      { month: '2026-07', status: 'complete', transactionCount: 0 },
      { month: '2026-08', status: 'complete', transactionCount: 1 },
      { month: '2026-09', status: 'complete', transactionCount: 2 },
      { month: '2026-10', status: 'missing', transactionCount: 0 },
    ]);
  });

  it('unterscheidet vollständige, teilweise und fehlende Monate', () => {
    const id = account('volksbank-owl', IBAN.volksbankGiro);
    db.prepare(
      `INSERT INTO import_batches (account_id, bank_adapter, file_name, file_sha256, imported_at, period_start, period_end)
       VALUES (?, 'volksbank-owl', 'a.csv', 'x', '2026-10-03T00:00:00Z', '2026-06-01', '2026-07-31'),
              (?, 'volksbank-owl', 'b.csv', 'y', '2026-10-03T00:00:00Z', '2026-09-01', '2026-09-20')`,
    ).run(id, id);

    const coverage = getCoverage(db, id, '2026-10-03');
    expect(coverage.months.map((m) => [m.month, m.status])).toEqual([
      ['2026-06', 'complete'],
      ['2026-07', 'complete'],
      ['2026-08', 'missing'],
      ['2026-09', 'partial'],
      ['2026-10', 'missing'],
    ]);
    expect(coverage.gaps).toEqual([
      { start: '2026-08-01', end: '2026-08-31' },
      { start: '2026-09-21', end: '2026-10-03' },
    ]);
  });

  it('warnt beim Import, wenn eine Lücke offen bleibt', () => {
    const id = account('volksbank-owl', IBAN.volksbankGiro);
    run(id, 'volksbank-owl/giro-saldo-luecke.csv'); // 01.09.–11.09.
    const result = run(id, 'volksbank-owl/giro-oktober.csv'); // 02.10.–05.10.
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/Zwischen 12\.09\.2026 und 01\.10\.2026 fehlen Kontoauszüge/)]),
    );
  });

  it('nutzt einen angegebenen Exportzeitraum und prüft ihn gegen die Buchungen', () => {
    const id = account('volksbank-owl', IBAN.volksbankGiro);
    expect(() => run(id, 'volksbank-owl/giro.csv', { periodStart: '2026-09-05' })).toThrow(/beginnt nach der ersten Buchung/);
    expect(() => run(id, 'volksbank-owl/giro.csv', { periodEnd: '2026-09-30' })).toThrow(/endet vor der letzten Buchung/);
    const result = run(id, 'volksbank-owl/giro.csv', { periodStart: '2026-09-01', periodEnd: '2026-10-03' });
    expect(result).toMatchObject({ periodStart: '2026-09-01', periodEnd: '2026-10-03' });
  });
});

describe('Transaktionsliste', () => {
  beforeEach(() => {
    const giro = account('volksbank-owl', IBAN.volksbankGiro, 'einnahmen', 'Giro');
    const cd = account('comdirect', IBAN.comdirectGiro, 'ausgaben', 'Comdirect');
    run(giro, 'volksbank-owl/giro.csv');
    run(cd, 'comdirect/girokonto.csv');
  });

  it('listet neueste zuerst und summiert Zu- und Abflüsse im Backend – ohne Umbuchungen', () => {
    const page = listTransactions(db, {});
    expect(page.total).toBe(16);
    expect(page.items[0]?.bookingDate).toBe('2026-10-02');
    const rows = db.prepare('SELECT amount_cents AS a, transfer_id AS tr FROM transactions').all() as { a: number; tr: number | null }[];
    const real = rows.filter((r) => r.tr === null);
    expect(page.inflowCents).toBe(real.filter((r) => r.a > 0).reduce((s, r) => s + r.a, 0));
    expect(page.outflowCents).toBe(real.filter((r) => r.a < 0).reduce((s, r) => s + r.a, 0));
    // Dauerauftrag ans Ausgabenkonto: Gegen-IBAN ist das Comdirect-Konto.
    expect(page.transferCount).toBe(1);
    expect(page.transferOutflowCents).toBe(-123456);
  });

  it('filtert nach Konto, Zeitraum und Suchtext', () => {
    const cd = listTransactions(db, { accountId: getAccountId('Comdirect') });
    expect(cd.total).toBe(6);
    expect(listTransactions(db, { from: '2026-09-01', to: '2026-09-30' }).total).toBe(9);
    expect(listTransactions(db, { q: 'lebensversicherung' }).total).toBe(2);
    // Sonderzeichen im Suchtext werden wörtlich genommen
    expect(listTransactions(db, { q: '%' }).total).toBe(0);
    expect(listTransactions(db, { q: 'B + V' }).total).toBe(1);
  });

  it('blättert seitenweise', () => {
    const page = listTransactions(db, { limit: 5, offset: 15 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(16);
  });

  it('berechnet die normalisierte Gegenpartei neu', () => {
    db.prepare("UPDATE transactions SET counterparty_normalized = 'alt'").run();
    expect(recomputeCounterpartyNormalized(db)).toBe(16);
    expect(recomputeCounterpartyNormalized(db)).toBe(0);
  });
});

function getAccountId(name: string): number {
  return (db.prepare('SELECT id FROM accounts WHERE name = ?').get(name) as { id: number }).id;
}
