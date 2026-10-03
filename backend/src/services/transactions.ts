import type { Db } from '../db/connection.js';
import { AppError } from '../lib/errors.js';
import { normalizeCounterparty } from '../lib/normalize.js';
import { assertAssignableCategory } from './categories.js';
import { applyRules, suggestRule, type RuleSuggestion } from './rules.js';

export interface TransactionFilter {
  accountId?: number | undefined;
  importBatchId?: number | undefined;
  /** YYYY-MM-DD, inklusive */
  from?: string | undefined;
  /** YYYY-MM-DD, inklusive */
  to?: string | undefined;
  /** Suchtext in Gegenpartei, Verwendungszweck und Vorgangsart. */
  q?: string | undefined;
  /** Kategorie inklusive ihrer Unterkategorien. */
  categoryId?: number | undefined;
  /** Nur Buchungen ohne Kategorie. */
  uncategorized?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface TransactionItem {
  id: number;
  accountId: number;
  accountName: string;
  bookingDate: string;
  valueDate: string | null;
  amountCents: number;
  currency: string;
  counterparty: string;
  counterpartyIban: string | null;
  purpose: string;
  bookingText: string;
  creditorId: string | null;
  mandateReference: string | null;
  balanceAfterCents: number | null;
  importBatchId: number | null;
  categoryId: number | null;
  /** „Eltern › Kind“. */
  categoryPath: string | null;
  /** manual = von Hand (auch „bewusst keine“), rule = durch Regel, null = unberührt. */
  categorySource: 'manual' | 'rule' | 'auto' | null;
  categoryRuleId: number | null;
}

export interface TransactionPage {
  items: TransactionItem[];
  total: number;
  /** Summen über alle Treffer des Filters (nicht nur die Seite). */
  inflowCents: number;
  outflowCents: number;
  limit: number;
  offset: number;
}

interface Row {
  id: number;
  account_id: number;
  account_name: string;
  booking_date: string;
  value_date: string | null;
  amount_cents: number;
  currency: string;
  counterparty: string;
  counterparty_iban: string | null;
  purpose: string;
  booking_text: string;
  creditor_id: string | null;
  mandate_reference: string | null;
  balance_after_cents: number | null;
  import_batch_id: number | null;
  category_id: number | null;
  category_path: string | null;
  category_source: 'manual' | 'rule' | 'auto' | null;
  category_rule_id: number | null;
}

const ITEM_SELECT = `
  SELECT t.*, a.name AS account_name,
         CASE WHEN p.id IS NULL THEN c.name ELSE p.name || ' › ' || c.name END AS category_path
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories p ON p.id = c.parent_id`;

function toItem(r: Row): TransactionItem {
  return {
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    bookingDate: r.booking_date,
    valueDate: r.value_date,
    amountCents: r.amount_cents,
    currency: r.currency,
    counterparty: r.counterparty,
    counterpartyIban: r.counterparty_iban,
    purpose: r.purpose,
    bookingText: r.booking_text,
    creditorId: r.creditor_id,
    mandateReference: r.mandate_reference,
    balanceAfterCents: r.balance_after_cents,
    importBatchId: r.import_batch_id,
    categoryId: r.category_id,
    categoryPath: r.category_path,
    categorySource: r.category_source,
    categoryRuleId: r.category_rule_id,
  };
}

export function getTransaction(db: Db, id: number): TransactionItem {
  const row = db.prepare(`${ITEM_SELECT} WHERE t.id = ?`).get(id) as Row | undefined;
  if (!row) throw new AppError(`Buchung ${id} existiert nicht.`, 404);
  return toItem(row);
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function listTransactions(db: Db, filter: TransactionFilter): TransactionPage {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.accountId !== undefined) {
    where.push('t.account_id = ?');
    params.push(filter.accountId);
  }
  if (filter.importBatchId !== undefined) {
    where.push('t.import_batch_id = ?');
    params.push(filter.importBatchId);
  }
  if (filter.from) {
    where.push('t.booking_date >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('t.booking_date <= ?');
    params.push(filter.to);
  }
  const q = filter.q?.trim();
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push(
      "(t.counterparty LIKE ? ESCAPE '\\' OR t.purpose LIKE ? ESCAPE '\\' OR t.booking_text LIKE ? ESCAPE '\\')",
    );
    params.push(like, like, like);
  }
  if (filter.categoryId !== undefined) {
    where.push('t.category_id IN (SELECT id FROM categories WHERE id = ? OR parent_id = ?)');
    params.push(filter.categoryId, filter.categoryId);
  }
  if (filter.uncategorized) where.push('t.category_id IS NULL');
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);

  const totals = db
    .prepare(
      `SELECT count(*) AS total,
              coalesce(sum(CASE WHEN amount_cents > 0 THEN amount_cents END), 0) AS inflow,
              coalesce(sum(CASE WHEN amount_cents < 0 THEN amount_cents END), 0) AS outflow
         FROM transactions t ${whereSql}`,
    )
    .get(...params) as { total: number; inflow: number; outflow: number };

  const rows = db
    .prepare(
      `${ITEM_SELECT}
         ${whereSql}
        ORDER BY t.booking_date DESC, t.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Row[];

  return {
    items: rows.map(toItem),
    total: totals.total,
    inflowCents: totals.inflow,
    outflowCents: totals.outflow,
    limit,
    offset,
  };
}

/**
 * Berechnet counterparty_normalized für alle Buchungen neu, z. B. nach
 * einer Änderung der Normalisierung. Liefert die Zahl geänderter Zeilen.
 */
export function recomputeCounterpartyNormalized(db: Db): number {
  const rows = db.prepare('SELECT id, counterparty, counterparty_normalized FROM transactions').all() as {
    id: number;
    counterparty: string;
    counterparty_normalized: string;
  }[];
  const update = db.prepare('UPDATE transactions SET counterparty_normalized = ? WHERE id = ?');
  return db.transaction(() => {
    let changed = 0;
    for (const row of rows) {
      const normalized = normalizeCounterparty(row.counterparty);
      if (normalized !== row.counterparty_normalized) {
        update.run(normalized, row.id);
        changed += 1;
      }
    }
    return changed;
  })();
}

export interface CategoryChange {
  transaction: TransactionItem;
  /** Angebot, aus der Korrektur eine Regel zu machen – nie automatisch angelegt. */
  suggestion: RuleSuggestion | null;
}

/**
 * Setzt die Kategorie von Hand (CLAUDE.md § 9). `null` = bewusst keine
 * Kategorie. In beiden Fällen lässt die Automatik die Buchung danach in
 * Ruhe. Bei einer Kategorie wird ein Regelvorschlag mitgeliefert.
 */
export function setTransactionCategory(db: Db, id: number, categoryId: number | null): CategoryChange {
  getTransaction(db, id);
  if (categoryId !== null) assertAssignableCategory(db, categoryId);
  db.prepare(
    "UPDATE transactions SET category_id = ?, category_source = 'manual', category_rule_id = NULL WHERE id = ?",
  ).run(categoryId, id);
  return {
    transaction: getTransaction(db, id),
    suggestion: categoryId === null ? null : suggestRule(db, id, categoryId),
  };
}

/**
 * Hebt die Handarbeit auf: die Buchung gilt wieder als unberührt, und die
 * Regeln dürfen sie einordnen (sofort angewendet).
 */
export function resetTransactionCategory(db: Db, id: number): TransactionItem {
  getTransaction(db, id);
  db.transaction(() => {
    db.prepare(
      'UPDATE transactions SET category_id = NULL, category_source = NULL, category_rule_id = NULL WHERE id = ?',
    ).run(id);
    applyRules(db, { transactionId: id });
  })();
  return getTransaction(db, id);
}

export interface UncategorizedSummary {
  count: number;
  inflowCents: number;
  outflowCents: number;
}

/** Anzahl und Summen aller Buchungen ohne Kategorie (CLAUDE.md § 2.5, § 15). */
export function uncategorizedSummary(db: Db): UncategorizedSummary {
  const row = db
    .prepare(
      `SELECT count(*) AS count,
              coalesce(sum(CASE WHEN amount_cents > 0 THEN amount_cents END), 0) AS inflow,
              coalesce(sum(CASE WHEN amount_cents < 0 THEN amount_cents END), 0) AS outflow
         FROM transactions WHERE category_id IS NULL`,
    )
    .get() as { count: number; inflow: number; outflow: number };
  return { count: row.count, inflowCents: row.inflow, outflowCents: row.outflow };
}
