import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/connection.js';
import {
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  updateCategory,
} from '../src/services/categories.js';
import { createTestDb } from './helpers/db.js';

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

function byName(name: string) {
  const found = listCategories(db).find((c) => c.name === name);
  if (!found) throw new Error(`Kategorie ${name} fehlt`);
  return found;
}

function insertTransaction(categoryId: number | null): void {
  const now = '2026-10-03T12:00:00.000Z';
  const accountId = db
    .prepare(`INSERT INTO accounts (name, role, bank_adapter, created_at, updated_at) VALUES ('K', 'ausgaben', 'comdirect', ?, ?)`)
    .run(now, now).lastInsertRowid;
  db.prepare(
    `INSERT INTO transactions (account_id, booking_date, amount_cents, import_hash, imported_at, category_id, category_source)
     VALUES (?, '2026-09-01', -100, ?, ?, ?, 'manual')`,
  ).run(accountId, `h${Math.random()}`, now, categoryId);
}

describe('Kategorien', () => {
  it('liefert die Startkategorien mit Bucket, Unterkategorien direkt nach der Wurzel', () => {
    const lebensmittel = byName('Lebensmittel');
    createCategory(db, { name: 'Supermarkt', parentId: lebensmittel.id });
    const list = listCategories(db);
    expect(list).toHaveLength(20);
    const index = list.findIndex((c) => c.name === 'Lebensmittel');
    expect(list[index + 1]).toMatchObject({ name: 'Supermarkt', path: 'Lebensmittel › Supermarkt' });
    expect(byName('Einkommen').effectiveBucket).toBeNull();
    expect(byName('Sparen').effectiveBucket).toBe('save');
  });

  it('lässt Unterkategorien standardmäßig den Bucket erben', () => {
    const parent = byName('Mobilität');
    const sub = createCategory(db, { name: 'Arbeitsweg', parentId: parent.id });
    expect(sub).toMatchObject({ inheritBucket: true, bucket: null, effectiveBucket: 'need' });

    updateCategory(db, parent.id, { bucket: 'want' });
    expect(getCategory(db, sub.id).effectiveBucket).toBe('want');
  });

  it('erlaubt einen abweichenden Bucket, auch „keinen“', () => {
    const parent = byName('Bildung & Weiterbildung');
    const sub = createCategory(db, { name: 'Beruflich', parentId: parent.id, inheritBucket: false, bucket: 'need' });
    expect(sub).toMatchObject({ inheritBucket: false, effectiveBucket: 'need' });

    const none = updateCategory(db, sub.id, { bucket: null });
    expect(none).toMatchObject({ inheritBucket: false, bucket: null, effectiveBucket: null });

    const back = updateCategory(db, sub.id, { inheritBucket: true });
    expect(back).toMatchObject({ inheritBucket: true, effectiveBucket: 'want' });
  });

  it('ignoriert bei Wurzelkategorien das Erben', () => {
    const root = createCategory(db, { name: 'Haustier', bucket: 'need', inheritBucket: true });
    expect(root).toMatchObject({ inheritBucket: false, effectiveBucket: 'need' });
  });

  it('erlaubt nur zwei Ebenen', () => {
    const sub = createCategory(db, { name: 'Supermarkt', parentId: byName('Lebensmittel').id });
    expect(() => createCategory(db, { name: 'Bio', parentId: sub.id })).toThrow(/nur zwei Ebenen/);
    expect(() => updateCategory(db, byName('Lebensmittel').id, { parentId: byName('Wohnen & Nebenkosten').id })).toThrow(
      /hat Unterkategorien/,
    );
  });

  it('verhindert doppelte Namen je Ebene, unabhängig von Groß-/Kleinschreibung', () => {
    expect(() => createCategory(db, { name: 'lebensmittel' })).toThrow(/gibt es bereits/);
    const a = createCategory(db, { name: 'Sonstiges', parentId: byName('Lebensmittel').id });
    expect(a.path).toBe('Lebensmittel › Sonstiges');
    expect(() => createCategory(db, { name: 'SONSTIGES', parentId: byName('Lebensmittel').id })).toThrow(/bereits eine Unterkategorie/);
  });

  it('behält Zuordnungen beim Umbenennen und beim Teilen in Unterkategorien', () => {
    const shopping = byName('Shopping & Kleidung');
    insertTransaction(shopping.id);
    const renamed = updateCategory(db, shopping.id, { name: 'Shopping' });
    expect(renamed.transactionCount).toBe(1);

    createCategory(db, { name: 'Kleidung', parentId: shopping.id });
    expect(getCategory(db, shopping.id)).toMatchObject({ transactionCount: 1, childCount: 1 });
  });

  it('hängt eine Wurzel unter eine andere und behält ihren Bucket', () => {
    const moved = updateCategory(db, byName('Investieren').id, { parentId: byName('Sparen').id });
    expect(moved).toMatchObject({ path: 'Sparen › Investieren', inheritBucket: false, effectiveBucket: 'save' });
    const root = updateCategory(db, moved.id, { parentId: null });
    expect(root).toMatchObject({ parentId: null, bucket: 'save' });
  });

  it('löscht nur unbenutzte Kategorien, sonst Deaktivieren', () => {
    const fresh = createCategory(db, { name: 'Testkategorie' });
    deleteCategory(db, fresh.id);
    expect(listCategories(db).some((c) => c.id === fresh.id)).toBe(false);

    const used = byName('Gesundheit');
    insertTransaction(used.id);
    expect(() => deleteCategory(db, used.id)).toThrow(/wird noch verwendet \(1 Buchung\(en\)\).*deaktivieren/);
    expect(updateCategory(db, used.id, { active: false }).active).toBe(false);
  });

  it('deaktiviert keine Elternkategorie mit aktiven Unterkategorien', () => {
    const parent = byName('Lebensmittel');
    createCategory(db, { name: 'Supermarkt', parentId: parent.id });
    expect(() => updateCategory(db, parent.id, { active: false })).toThrow(/aktive Unterkategorien/);
  });

  it('lehnt unbekannte Buckets ab', () => {
    expect(() => createCategory(db, { name: 'X', bucket: 'luxus' as never })).toThrow(/Unbekannter Bucket/);
  });
});
