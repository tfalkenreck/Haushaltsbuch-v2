import type { Db } from '../db/connection.js';
import { AppError } from '../lib/errors.js';
import {
  compilePattern,
  foldText,
  patternProblem,
  PATTERN_TYPES,
  RULE_FIELDS,
  suggestSearchText,
  type Matcher,
  type PatternType,
  type RuleField,
} from '../lib/patterns.js';
import { nowIso } from '../lib/time.js';
import { assertAssignableCategory, getCategory } from './categories.js';

/**
 * Automatische Kategorisierung (CLAUDE.md § 9). Regeln setzen nur
 * Kategorien von Buchungen, die noch keine haben und nie von Hand
 * angefasst wurden (`category_source IS NULL`). Handarbeit wird nie
 * überschrieben.
 */

export interface Rule {
  id: number;
  field: RuleField;
  patternType: PatternType;
  pattern: string;
  categoryId: number;
  categoryPath: string;
  categoryActive: boolean;
  /** Höher gewinnt. */
  priority: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  /** Buchungen, auf die das Muster aktuell passt. */
  matchCount: number;
  /** Buchungen, deren Kategorie diese Regel gesetzt hat. */
  assignedCount: number;
}

export interface RuleInput {
  field: string;
  patternType: string;
  pattern: string;
  categoryId: number;
  priority?: number;
  active?: boolean;
}

export type RulePatch = Partial<RuleInput>;

/** Was eine Regel prüft – Gegenpartei und Verwendungszweck einer Buchung. */
export interface MatchTarget {
  counterparty: string;
  purpose: string;
}

/** Regel in der Form, die die Auswertung braucht. */
export interface EngineRule {
  id: number;
  field: RuleField;
  pattern: string;
  categoryId: number;
  priority: number;
  matches: Matcher;
}

interface RuleRow {
  id: number;
  field: RuleField;
  pattern_type: PatternType;
  pattern: string;
  category_id: number;
  priority: number;
  active: number;
  created_at: string;
  updated_at: string;
}

/**
 * Reihenfolge der Auswertung: höhere Priorität zuerst; bei Gleichstand
 * gewinnt das längere (spezifischere) Muster, dann die ältere Regel.
 */
export function rankRules<T extends { id: number; priority: number; pattern: string }>(rules: T[]): T[] {
  return [...rules].sort(
    (a, b) => b.priority - a.priority || foldText(b.pattern).length - foldText(a.pattern).length || a.id - b.id,
  );
}

export function ruleMatches(rule: Pick<EngineRule, 'field' | 'matches'>, target: MatchTarget): boolean {
  return rule.matches(rule.field === 'counterparty' ? target.counterparty : target.purpose);
}

/** Erste passende Regel einer bereits sortierten Liste. */
export function pickRule<T extends Pick<EngineRule, 'field' | 'matches'>>(ranked: T[], target: MatchTarget): T | null {
  return ranked.find((rule) => ruleMatches(rule, target)) ?? null;
}

function toEngineRule(row: RuleRow): EngineRule {
  return {
    id: row.id,
    field: row.field,
    pattern: row.pattern,
    categoryId: row.category_id,
    priority: row.priority,
    matches: compilePattern(row.pattern_type, row.pattern),
  };
}

/** Aktive Regeln mit aktiver Zielkategorie, in Auswertungsreihenfolge. */
export function loadEngineRules(db: Db): EngineRule[] {
  const rows = db
    .prepare(
      `SELECT r.* FROM rules r JOIN categories c ON c.id = r.category_id
        WHERE r.active = 1 AND c.active = 1`,
    )
    .all() as RuleRow[];
  return rankRules(rows.map(toEngineRule));
}

export interface ApplyScope {
  /** Nur Buchungen dieses Importvorgangs. */
  importBatchId?: number;
  /** Nur Buchungen, bei denen diese Regel gewinnt. */
  ruleId?: number;
  /** Nur diese Buchung. */
  transactionId?: number;
}

/**
 * Wendet die Regeln auf unkategorisierte Buchungen an, die nie von Hand
 * angefasst wurden. Liefert die Zahl neu kategorisierter Buchungen.
 */
export function applyRules(db: Db, scope: ApplyScope = {}): number {
  const rules = loadEngineRules(db);
  if (rules.length === 0) return 0;

  const where = ['category_id IS NULL', 'category_source IS NULL'];
  const params: number[] = [];
  if (scope.importBatchId !== undefined) {
    where.push('import_batch_id = ?');
    params.push(scope.importBatchId);
  }
  if (scope.transactionId !== undefined) {
    where.push('id = ?');
    params.push(scope.transactionId);
  }
  const candidates = db
    .prepare(`SELECT id, counterparty, purpose FROM transactions WHERE ${where.join(' AND ')}`)
    .all(...params) as ({ id: number } & MatchTarget)[];

  const update = db.prepare(
    `UPDATE transactions SET category_id = ?, category_source = 'rule', category_rule_id = ?
      WHERE id = ? AND category_id IS NULL AND category_source IS NULL`,
  );
  return db.transaction(() => {
    let changed = 0;
    for (const t of candidates) {
      const winner = pickRule(rules, t);
      if (!winner || (scope.ruleId !== undefined && winner.id !== scope.ruleId)) continue;
      changed += update.run(winner.categoryId, winner.id, t.id).changes;
    }
    return changed;
  })();
}

// ---------------------------------------------------------------------------
// Verwaltung
// ---------------------------------------------------------------------------

function validateField(field: string): RuleField {
  if (!(RULE_FIELDS as readonly string[]).includes(field)) {
    throw new AppError(`Unbekanntes Feld „${field}“. Erlaubt: ${RULE_FIELDS.join(', ')}.`);
  }
  return field as RuleField;
}

function validatePatternType(type: string): PatternType {
  if (!(PATTERN_TYPES as readonly string[]).includes(type)) {
    throw new AppError(`Unbekannter Mustertyp „${type}“. Erlaubt: ${PATTERN_TYPES.join(', ')}.`);
  }
  return type as PatternType;
}

function validatePattern(type: PatternType, pattern: string): string {
  const problem = patternProblem(type, pattern);
  if (problem) throw new AppError(problem);
  return pattern.trim().replace(/\s+/g, ' ');
}

function validatePriority(priority: number | undefined, fallback: number): number {
  const value = priority ?? fallback;
  if (!Number.isInteger(value) || value < -1000 || value > 1_000_000) {
    throw new AppError('Die Priorität muss eine ganze Zahl zwischen −1000 und 1.000.000 sein.');
  }
  return value;
}

function allTargets(db: Db): ({ id: number; category_id: number | null; category_source: string | null } & MatchTarget)[] {
  return db.prepare('SELECT id, counterparty, purpose, category_id, category_source FROM transactions').all() as ({
    id: number;
    category_id: number | null;
    category_source: string | null;
  } & MatchTarget)[];
}

export function listRules(db: Db): Rule[] {
  const rows = db.prepare('SELECT * FROM rules').all() as RuleRow[];
  const assigned = new Map(
    (
      db
        .prepare('SELECT category_rule_id AS id, count(*) AS n FROM transactions WHERE category_rule_id IS NOT NULL GROUP BY category_rule_id')
        .all() as { id: number; n: number }[]
    ).map((r) => [r.id, r.n]),
  );
  const targets = allTargets(db);
  const categories = new Map<number, { path: string; active: boolean }>();
  const category = (id: number) => {
    let c = categories.get(id);
    if (!c) {
      const full = getCategory(db, id);
      c = { path: full.path, active: full.active };
      categories.set(id, c);
    }
    return c;
  };

  return rankRules(rows).map((row) => {
    const rule = toEngineRule(row);
    const c = category(row.category_id);
    return {
      id: row.id,
      field: row.field,
      patternType: row.pattern_type,
      pattern: row.pattern,
      categoryId: row.category_id,
      categoryPath: c.path,
      categoryActive: c.active,
      priority: row.priority,
      active: row.active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      matchCount: targets.filter((t) => ruleMatches(rule, t)).length,
      assignedCount: assigned.get(row.id) ?? 0,
    };
  });
}

export function getRule(db: Db, id: number): Rule {
  const rule = listRules(db).find((r) => r.id === id);
  if (!rule) throw new AppError(`Regel ${id} existiert nicht.`, 404);
  return rule;
}

export function createRule(db: Db, input: RuleInput): Rule {
  const field = validateField(input.field);
  const patternType = validatePatternType(input.patternType);
  const pattern = validatePattern(patternType, input.pattern);
  assertAssignableCategory(db, input.categoryId);
  const priority = validatePriority(input.priority, 0);
  const now = nowIso();
  const result = db
    .prepare(
      `INSERT INTO rules (field, pattern_type, pattern, category_id, priority, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(field, patternType, pattern, input.categoryId, priority, input.active === false ? 0 : 1, now, now);
  return getRule(db, Number(result.lastInsertRowid));
}

/**
 * Ändert eine Regel. Bereits gesetzte Kategorien bleiben, wie sie sind;
 * „Regeln anwenden“ füllt nur unkategorisierte Buchungen.
 */
export function updateRule(db: Db, id: number, patch: RulePatch): Rule {
  const row = db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as RuleRow | undefined;
  if (!row) throw new AppError(`Regel ${id} existiert nicht.`, 404);

  const field = patch.field !== undefined ? validateField(patch.field) : row.field;
  const patternType = patch.patternType !== undefined ? validatePatternType(patch.patternType) : row.pattern_type;
  const pattern = validatePattern(patternType, patch.pattern ?? row.pattern);
  if (patch.categoryId !== undefined && patch.categoryId !== row.category_id) assertAssignableCategory(db, patch.categoryId);
  const categoryId = patch.categoryId ?? row.category_id;
  const priority = validatePriority(patch.priority, row.priority);
  const active = patch.active ?? row.active === 1;

  db.prepare(
    `UPDATE rules SET field = ?, pattern_type = ?, pattern = ?, category_id = ?, priority = ?, active = ?, updated_at = ?
      WHERE id = ?`,
  ).run(field, patternType, pattern, categoryId, priority, active ? 1 : 0, nowIso(), id);
  return getRule(db, id);
}

export interface DeleteRuleResult {
  /** Buchungen, deren Kategorie mit entfernt wurde. */
  unassigned: number;
}

/**
 * Löscht eine Regel. Mit `unassign` verlieren die Buchungen, deren
 * Kategorie diese Regel gesetzt hat, ihre Kategorie wieder (sonst bleibt
 * sie stehen). Von Hand gesetzte Kategorien sind nie betroffen.
 */
export function deleteRule(db: Db, id: number, options: { unassign?: boolean } = {}): DeleteRuleResult {
  const exists = db.prepare('SELECT 1 FROM rules WHERE id = ?').get(id);
  if (!exists) throw new AppError(`Regel ${id} existiert nicht.`, 404);
  return db.transaction(() => {
    const unassigned = options.unassign
      ? db
          .prepare(
            `UPDATE transactions SET category_id = NULL, category_source = NULL, category_rule_id = NULL
              WHERE category_rule_id = ? AND category_source = 'rule'`,
          )
          .run(id).changes
      : 0;
    db.prepare('DELETE FROM rules WHERE id = ?').run(id);
    return { unassigned };
  })();
}

// ---------------------------------------------------------------------------
// Vorschau und Lernen aus Korrekturen
// ---------------------------------------------------------------------------

export interface PatternPreview {
  matchCount: number;
  /** Davon ohne Kategorie und nie von Hand angefasst. */
  uncategorizedCount: number;
  samples: { id: number; counterparty: string; purpose: string }[];
}

/** Welche Buchungen ein Muster träfe – bevor die Regel gespeichert wird. */
export function previewPattern(db: Db, input: { field: string; patternType: string; pattern: string }): PatternPreview {
  const field = validateField(input.field);
  const patternType = validatePatternType(input.patternType);
  const pattern = validatePattern(patternType, input.pattern);
  const rule = { field, matches: compilePattern(patternType, pattern) };
  const hits = allTargets(db).filter((t) => ruleMatches(rule, t));
  return {
    matchCount: hits.length,
    uncategorizedCount: hits.filter((t) => t.category_id === null && t.category_source === null).length,
    samples: hits.slice(0, 10).map(({ id, counterparty, purpose }) => ({ id, counterparty, purpose })),
  };
}

export interface RuleSuggestion {
  field: RuleField;
  patternType: PatternType;
  pattern: string;
  categoryId: number;
  categoryPath: string;
  /** Höher als jede andere Regel, die auf die Buchung passt. */
  priority: number;
  /** Gleiches Muster gibt es schon – dann wird diese Regel geändert statt eine neue angelegt. */
  existingRuleId: number | null;
  /** Regeln, die auf die Buchung passen und gegen die die neue Regel gewinnt. */
  outranks: { id: number; pattern: string; categoryPath: string; priority: number }[];
  /** Weitere unkategorisierte Buchungen, die die Regel beim Anwenden bekäme. */
  uncategorizedMatches: number;
  /** Buchungen, die eine andere Regel anders kategorisiert hat – sie bleiben unverändert. */
  otherRuleMatches: number;
}

/**
 * Nach einer manuellen Kategorisierung: Vorschlag für eine Regel, die
 * künftig dasselbe tut (CLAUDE.md § 9). Wird nur angeboten, nie angelegt.
 * Die Priorität liegt über jeder anderen passenden Regel, damit die
 * Korrektur gegen allgemeinere Regeln gewinnt. `null`, wenn die
 * bestehenden Regeln die Buchung schon so einordnen oder sich kein
 * Muster ableiten lässt.
 */
export function suggestRule(db: Db, transactionId: number, categoryId: number): RuleSuggestion | null {
  const tx = db.prepare('SELECT id, counterparty, purpose FROM transactions WHERE id = ?').get(transactionId) as
    | ({ id: number } & MatchTarget)
    | undefined;
  if (!tx) throw new AppError(`Buchung ${transactionId} existiert nicht.`, 404);

  const rules = loadEngineRules(db);
  if (pickRule(rules, tx)?.categoryId === categoryId) return null;

  const field: RuleField = tx.counterparty.trim() !== '' ? 'counterparty' : 'purpose';
  const pattern = suggestSearchText(field === 'counterparty' ? tx.counterparty : tx.purpose, field === 'counterparty' ? 6 : 3);
  if (pattern === null) return null;
  const patternType: PatternType = 'contains';

  const existing = (db.prepare("SELECT * FROM rules WHERE field = ? AND pattern_type = 'contains'").all(field) as RuleRow[]).find(
    (r) => foldText(r.pattern) === foldText(pattern),
  );
  const others = rules.filter((r) => r.id !== existing?.id);
  const competing = others.filter((r) => ruleMatches(r, tx));
  const priority = competing.length > 0 ? Math.max(...competing.map((r) => r.priority)) + 1 : Math.max(existing?.priority ?? 0, 0);

  const candidate: EngineRule = {
    id: existing?.id ?? Number.MAX_SAFE_INTEGER,
    field,
    pattern,
    categoryId,
    priority,
    matches: compilePattern(patternType, pattern),
  };
  const ranked = rankRules([...others, candidate]);
  let uncategorizedMatches = 0;
  let otherRuleMatches = 0;
  for (const t of allTargets(db)) {
    if (t.id === tx.id || !ruleMatches(candidate, t)) continue;
    if (t.category_id === null && t.category_source === null) {
      if (pickRule(ranked, t) === candidate) uncategorizedMatches += 1;
    } else if (t.category_source === 'rule' && t.category_id !== categoryId) {
      otherRuleMatches += 1;
    }
  }

  return {
    field,
    patternType,
    pattern,
    categoryId,
    categoryPath: getCategory(db, categoryId).path,
    priority,
    existingRuleId: existing?.id ?? null,
    outranks: competing
      .filter((r) => r.categoryId !== categoryId)
      .map((r) => ({ id: r.id, pattern: r.pattern, categoryPath: getCategory(db, r.categoryId).path, priority: r.priority })),
    uncategorizedMatches,
    otherRuleMatches,
  };
}
