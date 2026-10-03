import type { Db } from '../db/connection.js';
import { AppError } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';

export const BUCKETS = ['need', 'want', 'save'] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface Category {
  id: number;
  name: string;
  parentId: number | null;
  /** „Eltern › Kind“ bzw. nur der Name bei Wurzelkategorien. */
  path: string;
  /** Eigener Bucket (bei inheritBucket ohne Bedeutung). */
  bucket: Bucket | null;
  /** Nur Unterkategorien: Bucket der Elternkategorie übernehmen. */
  inheritBucket: boolean;
  /** Bucket, der für 50/30/20 tatsächlich gilt. */
  effectiveBucket: Bucket | null;
  active: boolean;
  transactionCount: number;
  ruleCount: number;
  childCount: number;
}

export interface CategoryInput {
  name: string;
  parentId?: number | null;
  bucket?: Bucket | null;
  inheritBucket?: boolean;
}

export interface CategoryPatch {
  name?: string;
  parentId?: number | null;
  bucket?: Bucket | null;
  inheritBucket?: boolean;
  active?: boolean;
}

interface Row {
  id: number;
  name: string;
  parent_id: number | null;
  parent_name: string | null;
  bucket: Bucket | null;
  parent_bucket: Bucket | null;
  inherit_bucket: number;
  active: number;
  transaction_count: number;
  rule_count: number;
  child_count: number;
}

const SELECT = `
  SELECT c.id, c.name, c.parent_id, p.name AS parent_name, c.bucket, p.bucket AS parent_bucket,
         c.inherit_bucket, c.active,
         (SELECT count(*) FROM transactions t WHERE t.category_id = c.id) AS transaction_count,
         (SELECT count(*) FROM rules r WHERE r.category_id = c.id) AS rule_count,
         (SELECT count(*) FROM categories k WHERE k.parent_id = c.id) AS child_count
    FROM categories c
    LEFT JOIN categories p ON p.id = c.parent_id`;

function toCategory(row: Row): Category {
  const inherit = row.parent_id !== null && row.inherit_bucket === 1;
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    path: row.parent_name === null ? row.name : `${row.parent_name} › ${row.name}`,
    bucket: row.bucket,
    inheritBucket: inherit,
    effectiveBucket: inherit ? row.parent_bucket : row.bucket,
    active: row.active === 1,
    transactionCount: row.transaction_count,
    ruleCount: row.rule_count,
    childCount: row.child_count,
  };
}

/** Alle Kategorien, Wurzeln alphabetisch, jeweils gefolgt von ihren Unterkategorien. */
export function listCategories(db: Db): Category[] {
  const rows = db
    .prepare(`${SELECT} ORDER BY coalesce(p.name, c.name) COLLATE NOCASE, coalesce(c.parent_id, c.id), c.parent_id IS NOT NULL, c.name COLLATE NOCASE`)
    .all() as Row[];
  return rows.map(toCategory);
}

export function getCategory(db: Db, id: number): Category {
  const row = db.prepare(`${SELECT} WHERE c.id = ?`).get(id) as Row | undefined;
  if (!row) throw new AppError(`Kategorie ${id} existiert nicht.`, 404);
  return toCategory(row);
}

function validateName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) throw new AppError('Der Kategoriename darf nicht leer sein.');
  if (trimmed.length > 100) throw new AppError('Der Kategoriename darf höchstens 100 Zeichen lang sein.');
  return trimmed;
}

function validateBucket(bucket: string | null | undefined): Bucket | null {
  if (bucket === null || bucket === undefined) return null;
  if (!(BUCKETS as readonly string[]).includes(bucket)) {
    throw new AppError(`Unbekannter Bucket „${bucket}“. Erlaubt: ${BUCKETS.join(', ')} oder keiner.`);
  }
  return bucket as Bucket;
}

/** Elternkategorie muss existieren und selbst eine Wurzel sein (zwei Ebenen). */
function validateParent(db: Db, parentId: number | null, ownId?: number): Category | null {
  if (parentId === null) return null;
  if (parentId === ownId) throw new AppError('Eine Kategorie kann nicht ihre eigene Unterkategorie sein.');
  const parent = getCategory(db, parentId);
  if (parent.parentId !== null) {
    throw new AppError(`„${parent.path}“ ist selbst eine Unterkategorie; es gibt nur zwei Ebenen.`);
  }
  return parent;
}

function assertNameFree(db: Db, name: string, parentId: number | null, ownId?: number): void {
  const other = db
    .prepare('SELECT id FROM categories WHERE coalesce(parent_id, 0) = ? AND name = ? COLLATE NOCASE AND id IS NOT ?')
    .get(parentId ?? 0, name, ownId ?? null);
  if (other) {
    throw new AppError(
      parentId === null
        ? `Eine Kategorie „${name}“ gibt es bereits.`
        : `Diese Elternkategorie hat bereits eine Unterkategorie „${name}“.`,
      409,
    );
  }
}

/**
 * Legt eine Kategorie an. Unterkategorien erben standardmäßig den Bucket
 * der Elternkategorie (CLAUDE.md § 8).
 */
export function createCategory(db: Db, input: CategoryInput): Category {
  const name = validateName(input.name);
  const parent = validateParent(db, input.parentId ?? null);
  const inherit = parent !== null && (input.inheritBucket ?? true);
  const bucket = inherit ? null : validateBucket(input.bucket);
  assertNameFree(db, name, parent?.id ?? null);

  const result = db
    .prepare(
      `INSERT INTO categories (name, parent_id, bucket, inherit_bucket, active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .run(name, parent?.id ?? null, bucket, inherit ? 1 : 0, nowIso());
  return getCategory(db, Number(result.lastInsertRowid));
}

/**
 * Ändert Name, Elternkategorie, Bucket oder Aktiv-Status. Buchungen und
 * Regeln behalten ihre Zuordnung – auch beim Umbenennen oder wenn eine
 * Kategorie unter eine andere gehängt wird.
 */
export function updateCategory(db: Db, id: number, patch: CategoryPatch): Category {
  const current = getCategory(db, id);

  const parentId = patch.parentId !== undefined ? patch.parentId : current.parentId;
  const parent = validateParent(db, parentId, id);
  if (parent !== null && current.childCount > 0) {
    throw new AppError(`„${current.name}“ hat Unterkategorien und kann deshalb nicht selbst Unterkategorie werden.`);
  }

  const name = patch.name !== undefined ? validateName(patch.name) : current.name;
  assertNameFree(db, name, parentId, id);

  let inherit: boolean;
  let bucket: Bucket | null;
  if (parent === null) {
    // Wurzel: immer eigener Bucket. Wird eine Unterkategorie zur Wurzel,
    // behält sie den bisher gültigen Bucket.
    inherit = false;
    bucket = patch.bucket !== undefined ? validateBucket(patch.bucket) : current.effectiveBucket;
  } else {
    if (patch.inheritBucket !== undefined) inherit = patch.inheritBucket;
    else if (patch.bucket !== undefined) inherit = false;
    // Eine Wurzel, die Unterkategorie wird, behält ihren Bucket.
    else inherit = current.parentId === null ? false : current.inheritBucket;
    bucket = inherit ? null : patch.bucket !== undefined ? validateBucket(patch.bucket) : current.effectiveBucket;
  }

  const active = patch.active ?? current.active;
  if (!active && current.active) {
    const activeChildren = db.prepare('SELECT count(*) AS n FROM categories WHERE parent_id = ? AND active = 1').get(id) as {
      n: number;
    };
    if (activeChildren.n > 0) {
      throw new AppError(`„${current.name}“ hat noch aktive Unterkategorien – diese zuerst deaktivieren.`);
    }
  }
  if (active && !current.active && parent !== null && !parent.active) {
    throw new AppError(`Die Elternkategorie „${parent.name}“ ist deaktiviert.`);
  }

  db.prepare('UPDATE categories SET name = ?, parent_id = ?, bucket = ?, inherit_bucket = ?, active = ? WHERE id = ?').run(
    name,
    parentId,
    bucket,
    inherit ? 1 : 0,
    active ? 1 : 0,
    id,
  );
  return getCategory(db, id);
}

/**
 * Löscht eine unbenutzte Kategorie. Benutzte Kategorien (Buchungen,
 * Regeln, Unterkategorien, Fixkosten) werden deaktiviert, nicht gelöscht.
 */
export function deleteCategory(db: Db, id: number): void {
  const category = getCategory(db, id);
  const recurring = db.prepare('SELECT count(*) AS n FROM recurring_items WHERE category_id = ?').get(id) as { n: number };
  const uses = [
    category.transactionCount > 0 ? `${category.transactionCount} Buchung(en)` : null,
    category.ruleCount > 0 ? `${category.ruleCount} Regel(n)` : null,
    category.childCount > 0 ? `${category.childCount} Unterkategorie(n)` : null,
    recurring.n > 0 ? `${recurring.n} Fixkosten/Abo(s)` : null,
  ].filter((u): u is string => u !== null);
  if (uses.length > 0) {
    throw new AppError(
      `„${category.path}“ wird noch verwendet (${uses.join(', ')}) und kann nicht gelöscht werden. ` +
        'Stattdessen deaktivieren – bestehende Zuordnungen bleiben dann erhalten.',
      409,
    );
  }
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
}

/** Wirft, wenn die Kategorie fehlt oder deaktiviert ist (für neue Zuordnungen). */
export function assertAssignableCategory(db: Db, id: number): Category {
  const category = getCategory(db, id);
  if (!category.active) throw new AppError(`Die Kategorie „${category.path}“ ist deaktiviert.`);
  return category;
}
