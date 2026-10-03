import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/connection.js';
import { createTestDb } from './helpers/db.js';

const NOW = '2026-10-03T12:00:00.000Z';

let db: Db;
let accountId: number;

beforeEach(() => {
  db = createTestDb();
  accountId = Number(
    db
      .prepare(
        `INSERT INTO accounts (name, role, bank_adapter, created_at, updated_at)
         VALUES ('Testkonto', 'ausgaben', 'comdirect', ?, ?)`,
      )
      .run(NOW, NOW).lastInsertRowid,
  );
});

function insertTransaction(values: Record<string, unknown>): void {
  const row = {
    account_id: accountId,
    booking_date: '2026-09-11',
    amount_cents: -1234,
    import_hash: 'hash-1',
    imported_at: NOW,
    ...values,
  };
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO transactions (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`,
  ).run(row);
}

describe('Datenmodell', () => {
  it('legt alle Tabellen aus § 7 an', () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]).map((t) => t.name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'accounts',
        'import_batches',
        'transactions',
        'categories',
        'rules',
        'recurring_items',
        'savings_goals',
        'transfers',
      ]),
    );
  });

  it('hat in transactions alle Spalten aus § 7 plus Herkunftsangaben', () => {
    const columns = (db.prepare('PRAGMA table_info(transactions)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'account_id',
        'booking_date',
        'value_date',
        'amount_cents',
        'currency',
        'counterparty',
        'counterparty_normalized',
        'purpose',
        'category_id',
        'recurring_item_id',
        'transfer_id',
        'import_batch_id',
        'import_hash',
        'imported_at',
        'notes',
        'category_source',
        'transfer_source',
      ]),
    );
  });

  it('nimmt Beträge als Cent-Integer an', () => {
    insertTransaction({ amount_cents: -123456 });
    expect(db.prepare('SELECT amount_cents FROM transactions').get()).toEqual({ amount_cents: -123456 });
  });

  it('lehnt Beträge mit Nachkommastellen ab (STRICT)', () => {
    expect(() => insertTransaction({ amount_cents: -12.34 })).toThrow(/cannot store REAL value in INTEGER column/);
  });

  it('lehnt Datumsangaben außerhalb von ISO-8601 ab', () => {
    expect(() => insertTransaction({ booking_date: '11.09.2026' })).toThrow(/CHECK constraint failed/);
  });

  it('verhindert doppelte import_hash', () => {
    insertTransaction({ import_hash: 'gleich' });
    expect(() => insertTransaction({ import_hash: 'gleich' })).toThrow(/UNIQUE constraint failed: transactions.import_hash/);
  });

  it('erzwingt Fremdschlüssel', () => {
    expect(() => insertTransaction({ account_id: 999 })).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('verhindert das Löschen eines Kontos mit Buchungen', () => {
    insertTransaction({});
    expect(() => db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId)).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('verlangt eine Herkunft, sobald eine Kategorie gesetzt ist', () => {
    const categoryId = (db.prepare("SELECT id FROM categories WHERE name = 'Lebensmittel'").get() as { id: number }).id;
    expect(() => insertTransaction({ category_id: categoryId })).toThrow(/CHECK constraint failed/);
    insertTransaction({ category_id: categoryId, category_source: 'manual' });
  });

  it('lässt nur die vier Kontorollen zu', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO accounts (name, role, bank_adapter, created_at, updated_at)
           VALUES ('Depot', 'depot', 'comdirect', ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow(/CHECK constraint failed/);
  });

  it('verlangt für Kartenabrechnungen einen Abrechnungszeitraum', () => {
    const insert = db.prepare(
      `INSERT INTO transfers (kind, origin, status, amount_cents, period_start, period_end, created_at, updated_at)
       VALUES ('card_settlement', 'auto', 'suggested', 50000, ?, ?, ?, ?)`,
    );
    expect(() => insert.run(null, null, NOW, NOW)).toThrow(/CHECK constraint failed/);
    insert.run('2026-08-16', '2026-09-15', NOW, NOW);
  });
});

describe('Kategorien-Seed', () => {
  it('legt die Kategorien aus § 8 mit ihrem Bucket an', () => {
    const rows = db
      .prepare('SELECT name, bucket FROM categories WHERE parent_id IS NULL ORDER BY id')
      .all() as { name: string; bucket: string | null }[];
    const byBucket = (bucket: string | null) => rows.filter((r) => r.bucket === bucket).map((r) => r.name);

    expect(byBucket('need')).toEqual([
      'Wohnen & Nebenkosten',
      'Lebensmittel',
      'Mobilität',
      'Versicherungen',
      'Gesundheit',
    ]);
    expect(byBucket('want')).toEqual([
      'Freizeit & Unterhaltung',
      'Shopping & Kleidung',
      'Restaurants & Cafés',
      'Abos & Mitgliedschaften',
      'Urlaub & Reisen',
      'Bildung & Weiterbildung',
      'Geschenke & Spenden',
    ]);
    expect(byBucket('save')).toEqual(['Sparen', 'Investieren', 'Altersvorsorge']);
    expect(byBucket(null)).toEqual(['Einkommen', 'Bargeldabhebungen', 'Sonstiges', 'Umbuchung']);
  });

  it('verhindert doppelte Namen auf derselben Ebene', () => {
    expect(() =>
      db.prepare("INSERT INTO categories (name, created_at) VALUES ('lebensmittel', ?)").run(NOW),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('lässt Unterkategorien den Bucket erben, aber nicht Wurzeln', () => {
    const parentId = (db.prepare("SELECT id FROM categories WHERE name = 'Mobilität'").get() as { id: number }).id;
    db.prepare(
      "INSERT INTO categories (name, parent_id, inherit_bucket, created_at) VALUES ('Arbeitsweg', ?, 1, ?)",
    ).run(parentId, NOW);

    expect(() =>
      db.prepare("INSERT INTO categories (name, inherit_bucket, created_at) VALUES ('Wurzel', 1, ?)").run(NOW),
    ).toThrow(/CHECK constraint failed/);
  });
});
