import type { Db } from '../db/connection.js';
import { AppError } from '../lib/errors.js';
import { normalizeCounterparty } from '../lib/normalize.js';
import { assertAssignableCategory } from './categories.js';
import { applyRules, suggestRule, type RuleSuggestion } from './rules.js';
import type { TransferKind, TransferStatus } from './transfers.js';

export interface TransactionFilter {
  accountId?: number | undefined;
  importBatchId?: number | undefined;
  /** YYYY-MM-DD, inklusive */
  from?: string | undefined;
  /** YYYY-MM-DD, inklusive */
  to?: string | undefined;
  /**
   * Worauf sich `from`/`to` beziehen: Buchungsdatum (Standard, bei
   * Kartenumsätzen das Kaufdatum) oder Buchungstag der Bank (Zeitraum
   * einer Kartenabrechnung mit Abrechnungsdatum).
   */
  dateBasis?: 'booking' | 'bank' | undefined;
  /** Suchtext in Gegenpartei, Verwendungszweck und Vorgangsart. */
  q?: string | undefined;
  /** Kategorie inklusive ihrer Unterkategorien. */
  categoryId?: number | undefined;
  /** Nur Buchungen ohne Kategorie (Umbuchungen ausgenommen – sie brauchen keine). */
  uncategorized?: boolean | undefined;
  /** only = nur Umbuchungen, exclude = ohne Umbuchungen. */
  transfers?: 'only' | 'exclude' | undefined;
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
  /** Umbuchung zwischen eigenen Konten – zählt weder als Einnahme noch als Ausgabe. */
  transferId: number | null;
  transferKind: TransferKind | null;
  transferStatus: TransferStatus | null;
  /** manual = von Hand (auch „bewusst keine Umbuchung“), auto = erkannt, null = unberührt. */
  transferSource: 'manual' | 'auto' | null;
  /** Das andere beteiligte Konto, falls bekannt. */
  transferAccountName: string | null;
}

export interface TransactionPage {
  items: TransactionItem[];
  total: number;
  /** Summen über alle Treffer des Filters (nicht nur die Seite), ohne Umbuchungen. */
  inflowCents: number;
  outflowCents: number;
  /** Umbuchungen unter den Treffern – zählen nicht als Einnahme oder Ausgabe. */
  transferCount: number;
  transferInflowCents: number;
  transferOutflowCents: number;
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
  transfer_id: number | null;
  transfer_kind: TransferKind | null;
  transfer_status: TransferStatus | null;
  transfer_source: 'manual' | 'auto' | null;
  transfer_account_name: string | null;
}

const ITEM_SELECT = `
  SELECT t.*, a.name AS account_name,
         CASE WHEN p.id IS NULL THEN c.name ELSE p.name || ' › ' || c.name END AS category_path,
         tr.kind AS transfer_kind, tr.status AS transfer_status, oa.name AS transfer_account_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories p ON p.id = c.parent_id
    LEFT JOIN transfers tr ON tr.id = t.transfer_id
    LEFT JOIN accounts oa ON oa.id = CASE WHEN tr.from_account_id = t.account_id THEN tr.to_account_id ELSE tr.from_account_id END`;

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
    transferId: r.transfer_id,
    transferKind: r.transfer_kind,
    transferStatus: r.transfer_status,
    transferSource: r.transfer_source,
    transferAccountName: r.transfer_account_name,
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
  const dateColumn = filter.dateBasis === 'bank' ? 'coalesce(t.bank_booking_date, t.booking_date)' : 't.booking_date';
  if (filter.from) {
    where.push(`${dateColumn} >= ?`);
    params.push(filter.from);
  }
  if (filter.to) {
    where.push(`${dateColumn} <= ?`);
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
  if (filter.uncategorized) where.push('t.category_id IS NULL AND t.transfer_id IS NULL');
  if (filter.transfers === 'only') where.push('t.transfer_id IS NOT NULL');
  if (filter.transfers === 'exclude') where.push('t.transfer_id IS NULL');
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);

  const totals = db
    .prepare(
      `SELECT count(*) AS total,
              coalesce(sum(CASE WHEN transfer_id IS NULL AND amount_cents > 0 THEN amount_cents END), 0) AS inflow,
              coalesce(sum(CASE WHEN transfer_id IS NULL AND amount_cents < 0 THEN amount_cents END), 0) AS outflow,
              count(transfer_id) AS transfers,
              coalesce(sum(CASE WHEN transfer_id IS NOT NULL AND amount_cents > 0 THEN amount_cents END), 0) AS transfer_in,
              coalesce(sum(CASE WHEN transfer_id IS NOT NULL AND amount_cents < 0 THEN amount_cents END), 0) AS transfer_out
         FROM transactions t ${whereSql}`,
    )
    .get(...params) as { total: number; inflow: number; outflow: number; transfers: number; transfer_in: number; transfer_out: number };

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
    transferCount: totals.transfers,
    transferInflowCents: totals.transfer_in,
    transferOutflowCents: totals.transfer_out,
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

/**
 * Anzahl und Summen aller Buchungen ohne Kategorie (CLAUDE.md § 2.5, § 15).
 * Umbuchungen zählen nicht mit – sie sind weder Einnahme noch Ausgabe (§ 10).
 */
export function uncategorizedSummary(db: Db): UncategorizedSummary {
  const row = db
    .prepare(
      `SELECT count(*) AS count,
              coalesce(sum(CASE WHEN amount_cents > 0 THEN amount_cents END), 0) AS inflow,
              coalesce(sum(CASE WHEN amount_cents < 0 THEN amount_cents END), 0) AS outflow
         FROM transactions WHERE category_id IS NULL AND transfer_id IS NULL`,
    )
    .get() as { count: number; inflow: number; outflow: number };
  return { count: row.count, inflowCents: row.inflow, outflowCents: row.outflow };
}
