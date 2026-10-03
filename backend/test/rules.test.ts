import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/connection.js';
import { compilePattern } from '../src/lib/patterns.js';
import { createAccount } from '../src/services/accounts.js';
import { listCategories } from '../src/services/categories.js';
import { importFile } from '../src/services/imports.js';
import {
  applyRules,
  createRule,
  deleteRule,
  listRules,
  pickRule,
  previewPattern,
  previewReassign,
  rankRules,
  reassignCandidates,
  reassignToRule,
  suggestRule,
  updateRule,
} from '../src/services/rules.js';
import {
  getTransaction,
  listTransactions,
  resetTransactionCategory,
  setTransactionCategory,
  uncategorizedSummary,
} from '../src/services/transactions.js';
import { createTestDb } from './helpers/db.js';
import { fixture, IBAN } from './helpers/fixtures.js';

let db: Db;
let giro: number;

beforeEach(() => {
  db = createTestDb();
  giro = createAccount(db, { name: 'Giro', role: 'einnahmen', bankAdapter: 'volksbank-owl', iban: IBAN.volksbankGiro }).id;
});

function category(name: string): number {
  const found = listCategories(db).find((c) => c.name === name);
  if (!found) throw new Error(`Kategorie ${name} fehlt`);
  return found.id;
}

function importGiro() {
  return importFile(db, { accountId: giro, fileName: 'giro.csv', bytes: fixture('volksbank-owl/giro.csv') });
}

function txId(counterparty: string): number {
  const row = db.prepare('SELECT id FROM transactions WHERE counterparty = ? ORDER BY id LIMIT 1').get(counterparty) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`Buchung ${counterparty} fehlt`);
  return row.id;
}

function categoryOf(counterparty: string) {
  return db
    .prepare('SELECT category_id AS categoryId, category_source AS source, category_rule_id AS ruleId FROM transactions WHERE id = ?')
    .get(txId(counterparty)) as { categoryId: number | null; source: string | null; ruleId: number | null };
}

describe('Regel-Reihenfolge', () => {
  const rule = (id: number, priority: number, pattern: string) => ({
    id,
    priority,
    pattern,
    field: 'counterparty' as const,
    categoryId: id,
    matches: compilePattern('contains', pattern),
  });

  it('höhere Priorität gewinnt, dann das längere Muster, dann die ältere Regel', () => {
    const ranked = rankRules([rule(1, 0, 'rewe'), rule(2, 5, 're'), rule(3, 0, 'rewe markt'), rule(4, 0, 'rewe')]);
    expect(ranked.map((r) => r.id)).toEqual([2, 3, 1, 4]);
  });

  it('wählt die erste passende Regel', () => {
    const ranked = rankRules([rule(1, 0, 'rewe'), rule(2, 1, 'aldi')]);
    expect(pickRule(ranked, { counterparty: 'REWE Markt', purpose: '' })?.id).toBe(1);
    expect(pickRule(ranked, { counterparty: 'Lidl', purpose: '' })).toBeNull();
  });
});

describe('Regeln beim Import', () => {
  it('kategorisieren neue Buchungen automatisch und merken sich die Regel', () => {
    const rule = createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'stadtwerke', categoryId: category('Wohnen & Nebenkosten') });
    const result = importGiro();
    expect(result.categorized).toBe(1);
    expect(categoryOf('Stadtwerke Musterstadt GmbH')).toEqual({ categoryId: category('Wohnen & Nebenkosten'), source: 'rule', ruleId: rule.id });
  });

  it('prüfen auch den Verwendungszweck und Platzhalter-Ausdrücke', () => {
    createRule(db, { field: 'purpose', patternType: 'wildcard', pattern: 'Miete *', categoryId: category('Wohnen & Nebenkosten') });
    createRule(db, { field: 'purpose', patternType: 'wildcard', pattern: 'Gehalt*', categoryId: category('Einkommen') });
    expect(importGiro().categorized).toBe(2);
    expect(categoryOf('Vermieter Beispiel').categoryId).toBe(category('Wohnen & Nebenkosten'));
    expect(categoryOf('Muster Arbeitgeber GmbH').categoryId).toBe(category('Einkommen'));
  });

  it('ignorieren inaktive Regeln und Regeln mit deaktivierter Kategorie', () => {
    createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'stadtwerke', categoryId: category('Wohnen & Nebenkosten'), active: false });
    const gesundheit = category('Gesundheit');
    createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'bäckerei', categoryId: gesundheit });
    db.prepare('UPDATE categories SET active = 0 WHERE id = ?').run(gesundheit);
    expect(importGiro().categorized).toBe(0);
  });
});

describe('Regeln nachträglich anwenden', () => {
  beforeEach(() => {
    importGiro();
  });

  it('kategorisiert nur unkategorisierte Buchungen und überschreibt nie Handarbeit', () => {
    const manual = txId('Bäckerei Müller');
    setTransactionCategory(db, manual, category('Restaurants & Cafés'));
    const noneId = txId('Vermieter Beispiel');
    setTransactionCategory(db, noneId, null); // bewusst keine Kategorie

    createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'bäckerei', categoryId: category('Lebensmittel') });
    createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'vermieter', categoryId: category('Wohnen & Nebenkosten') });
    // Zweite Bäckerei-Buchung (echte Doppelzahlung) + nichts anderes
    expect(applyRules(db)).toBe(1);

    expect(getTransaction(db, manual)).toMatchObject({ categoryPath: 'Restaurants & Cafés', categorySource: 'manual' });
    expect(getTransaction(db, noneId)).toMatchObject({ categoryId: null, categorySource: 'manual' });
  });

  it('überschreibt auch keine bereits per Regel gesetzte Kategorie', () => {
    createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'stadtwerke', categoryId: category('Wohnen & Nebenkosten') });
    applyRules(db);
    createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'stadtwerke musterstadt', categoryId: category('Sonstiges'), priority: 10 });
    expect(applyRules(db)).toBe(0);
    expect(categoryOf('Stadtwerke Musterstadt GmbH').categoryId).toBe(category('Wohnen & Nebenkosten'));
  });

  it('wendet auf Wunsch nur eine Regel an – dort, wo sie gewinnt', () => {
    const a = createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'bäckerei', categoryId: category('Lebensmittel') });
    createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'stadtwerke', categoryId: category('Wohnen & Nebenkosten') });
    expect(applyRules(db, { ruleId: a.id })).toBe(2);
    expect(categoryOf('Stadtwerke Musterstadt GmbH').categoryId).toBeNull();
  });
});

describe('Regelverwaltung', () => {
  beforeEach(() => {
    importGiro();
  });

  it('zeigt Treffer und zugeordnete Buchungen je Regel, nach Priorität sortiert', () => {
    const low = createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'bäckerei', categoryId: category('Lebensmittel') });
    const high = createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'gmbh', categoryId: category('Sonstiges'), priority: 3 });
    applyRules(db, { ruleId: low.id });

    const rules = listRules(db);
    expect(rules.map((r) => r.id)).toEqual([high.id, low.id]);
    expect(rules[0]).toMatchObject({ matchCount: 2, assignedCount: 0, categoryPath: 'Sonstiges' });
    expect(rules[1]).toMatchObject({ matchCount: 2, assignedCount: 2, categoryPath: 'Lebensmittel' });
  });

  it('prüft Mustertyp, Muster und Kategorie', () => {
    const base = { field: 'counterparty', patternType: 'contains', pattern: 'x', categoryId: category('Lebensmittel') };
    expect(() => createRule(db, { ...base, patternType: 'regex' })).toThrow(/Unbekannter Mustertyp/);
    expect(() => createRule(db, { ...base, field: 'iban' })).toThrow(/Unbekanntes Feld/);
    expect(() => createRule(db, { ...base, pattern: '  ' })).toThrow(/leer/);
    expect(() => createRule(db, { ...base, patternType: 'wildcard', pattern: '**' })).toThrow(/festes Zeichen/);
    expect(() => createRule(db, { ...base, categoryId: 999 })).toThrow(/existiert nicht/);
  });

  it('ändert Regeln, ohne bestehende Zuordnungen umzuwerfen', () => {
    const rule = createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'stadtwerke', categoryId: category('Wohnen & Nebenkosten') });
    applyRules(db);
    const updated = updateRule(db, rule.id, { categoryId: category('Sonstiges'), priority: 7 });
    expect(updated).toMatchObject({ categoryPath: 'Sonstiges', priority: 7, assignedCount: 1 });
    expect(categoryOf('Stadtwerke Musterstadt GmbH').categoryId).toBe(category('Wohnen & Nebenkosten'));
  });

  it('löscht Regeln wahlweise samt ihrer Zuordnungen, Handarbeit bleibt', () => {
    const rule = createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'bäckerei', categoryId: category('Lebensmittel') });
    applyRules(db);
    const [first] = db.prepare("SELECT id FROM transactions WHERE counterparty = 'Bäckerei Müller' ORDER BY id").all() as { id: number }[];
    setTransactionCategory(db, first?.id as number, category('Lebensmittel'));

    expect(deleteRule(db, rule.id, { unassign: true })).toEqual({ unassigned: 1 });
    expect(getTransaction(db, first?.id as number)).toMatchObject({ categorySource: 'manual', categoryPath: 'Lebensmittel' });
    expect(listRules(db)).toEqual([]);
  });

  it('behält beim Löschen ohne unassign die Kategorie', () => {
    const rule = createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'stadtwerke', categoryId: category('Wohnen & Nebenkosten') });
    applyRules(db);
    expect(deleteRule(db, rule.id)).toEqual({ unassigned: 0 });
    expect(categoryOf('Stadtwerke Musterstadt GmbH')).toEqual({ categoryId: category('Wohnen & Nebenkosten'), source: 'rule', ruleId: null });
  });

  it('zeigt vor dem Speichern, was ein Muster träfe', () => {
    setTransactionCategory(db, txId('Bäckerei Müller'), category('Lebensmittel'));
    const preview = previewPattern(db, { field: 'counterparty', patternType: 'contains', pattern: 'bäckerei' });
    expect(preview).toMatchObject({ matchCount: 2, uncategorizedCount: 1 });
    expect(preview.samples).toHaveLength(2);
  });
});

describe('Manuell kategorisieren und Lernen aus Korrekturen', () => {
  beforeEach(() => {
    importGiro();
  });

  it('setzt die Kategorie von Hand und bietet eine Regel an, ohne sie anzulegen', () => {
    const id = txId('Telefon Beispiel AG');
    const change = setTransactionCategory(db, id, category('Abos & Mitgliedschaften'));
    expect(change.transaction).toMatchObject({ categorySource: 'manual', categoryPath: 'Abos & Mitgliedschaften' });
    expect(change.suggestion).toMatchObject({
      field: 'counterparty',
      patternType: 'contains',
      pattern: 'Telefon Beispiel AG',
      priority: 0,
      existingRuleId: null,
      outranks: [],
      uncategorizedMatches: 0,
    });
    expect(listRules(db)).toEqual([]);
  });

  it('gibt der gelernten Regel eine höhere Priorität als allgemeinere Regeln', () => {
    const general = createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'gmbh', categoryId: category('Sonstiges'), priority: 4 });
    applyRules(db);
    expect(categoryOf('Stadtwerke Musterstadt GmbH').ruleId).toBe(general.id);

    const change = setTransactionCategory(db, txId('Stadtwerke Musterstadt GmbH'), category('Wohnen & Nebenkosten'));
    const suggestion = change.suggestion;
    expect(suggestion).toMatchObject({ pattern: 'Stadtwerke Musterstadt GmbH', priority: 5 });
    expect(suggestion?.outranks).toEqual([{ id: general.id, pattern: 'gmbh', categoryPath: 'Sonstiges', priority: 4 }]);

    // Angenommen: die Regel greift künftig vor der allgemeinen.
    const learned = createRule(db, { ...(suggestion as NonNullable<typeof suggestion>), categoryId: category('Wohnen & Nebenkosten') });
    resetTransactionCategory(db, txId('Stadtwerke Musterstadt GmbH'));
    expect(categoryOf('Stadtwerke Musterstadt GmbH')).toMatchObject({ ruleId: learned.id, categoryId: category('Wohnen & Nebenkosten') });
  });

  it('zählt, was die gelernte Regel sonst noch träfe', () => {
    createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'b', categoryId: category('Sonstiges'), active: true });
    applyRules(db); // Bäckerei ×2, Vermieter Beispiel, Telefon Beispiel AG …
    const [first] = db.prepare("SELECT id FROM transactions WHERE counterparty = 'Bäckerei Müller' ORDER BY id").all() as { id: number }[];
    db.prepare("UPDATE transactions SET category_id = NULL, category_source = NULL, category_rule_id = NULL WHERE counterparty = 'Bäckerei Müller'").run();

    const change = setTransactionCategory(db, first?.id as number, category('Lebensmittel'));
    expect(change.suggestion).toMatchObject({ pattern: 'Bäckerei Müller', priority: 1, uncategorizedMatches: 1, otherRuleMatches: 0 });
  });

  it('schlägt keine Regel vor, wenn die bestehenden Regeln schon so entscheiden', () => {
    createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'stadtwerke', categoryId: category('Wohnen & Nebenkosten') });
    const change = setTransactionCategory(db, txId('Stadtwerke Musterstadt GmbH'), category('Wohnen & Nebenkosten'));
    expect(change.suggestion).toBeNull();
  });

  it('ändert eine bestehende Regel mit gleichem Muster statt eine zweite anzulegen', () => {
    const existing = createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'telefon beispiel ag', categoryId: category('Sonstiges') });
    const change = setTransactionCategory(db, txId('Telefon Beispiel AG'), category('Abos & Mitgliedschaften'));
    expect(change.suggestion).toMatchObject({ existingRuleId: existing.id, outranks: [] });
  });

  it('leitet bei leerer Gegenpartei das Muster aus dem Verwendungszweck ab', () => {
    const id = txId('Vermieter Beispiel');
    db.prepare("UPDATE transactions SET counterparty = '' WHERE id = ?").run(id);
    const suggestion = suggestRule(db, id, category('Wohnen & Nebenkosten'));
    expect(suggestion).toMatchObject({ field: 'purpose', pattern: 'Miete Musterstr.' });
  });

  it('setzt „bewusst keine Kategorie“ ohne Vorschlag und lässt die Automatik zurück', () => {
    createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'vermieter', categoryId: category('Wohnen & Nebenkosten') });
    const id = txId('Vermieter Beispiel');
    expect(setTransactionCategory(db, id, null)).toMatchObject({ suggestion: null, transaction: { categoryId: null, categorySource: 'manual' } });
    expect(applyRules(db)).toBe(0);

    expect(resetTransactionCategory(db, id)).toMatchObject({ categorySource: 'rule', categoryPath: 'Wohnen & Nebenkosten' });
  });

  it('lehnt deaktivierte Kategorien ab', () => {
    const gesundheit = category('Gesundheit');
    db.prepare('UPDATE categories SET active = 0 WHERE id = ?').run(gesundheit);
    expect(() => setTransactionCategory(db, txId('Telefon Beispiel AG'), gesundheit)).toThrow(/deaktiviert/);
  });
});

describe('„Auch diese umstellen“', () => {
  beforeEach(() => {
    importGiro();
  });

  /** Allgemeine Regel sortiert falsch ein: Bäckerei ×2, Vermieter, Telefon … → Sonstiges. */
  function wrongRule() {
    const general = createRule(db, { field: 'counterparty', patternType: 'contains', pattern: 'b', categoryId: category('Sonstiges') });
    applyRules(db);
    return general;
  }

  function bakeryIds(): number[] {
    return (db.prepare("SELECT id FROM transactions WHERE counterparty = 'Bäckerei Müller' ORDER BY id").all() as { id: number }[]).map((r) => r.id);
  }

  it('zählt im Vorschlag nur per Regel einsortierte Buchungen, bei denen die neue Regel gewinnt', () => {
    wrongRule();
    const [first, second] = bakeryIds();
    const change = setTransactionCategory(db, first as number, category('Lebensmittel'));
    expect(change.suggestion).toMatchObject({ pattern: 'Bäckerei Müller', priority: 1, otherRuleMatches: 1, uncategorizedMatches: 0 });

    const preview = previewReassign(db, { ...(change.suggestion as NonNullable<typeof change.suggestion>) });
    expect(preview).toEqual([
      expect.objectContaining({ id: second, counterparty: 'Bäckerei Müller', categoryPath: 'Sonstiges', rulePattern: 'b', amountCents: -320 }),
    ]);
  });

  it('zeigt von Hand gesetzte Kategorien nie an und stellt sie nie um', () => {
    wrongRule();
    const [first, second] = bakeryIds();
    setTransactionCategory(db, second as number, category('Restaurants & Cafés')); // Handarbeit
    const change = setTransactionCategory(db, first as number, category('Lebensmittel'));
    expect(change.suggestion?.otherRuleMatches).toBe(0);

    const learned = createRule(db, { ...(change.suggestion as NonNullable<typeof change.suggestion>) });
    expect(reassignCandidates(db, learned.id)).toEqual([]);
    expect(reassignToRule(db, learned.id, [first as number, second as number])).toBe(0);
    expect(categoryOf('Bäckerei Müller').categoryId).toBe(category('Lebensmittel'));
    const secondRow = db.prepare('SELECT category_id, category_source FROM transactions WHERE id = ?').get(second) as Record<string, unknown>;
    expect(secondRow).toEqual({ category_id: category('Restaurants & Cafés'), category_source: 'manual' });
  });

  it('stellt nur die ausdrücklich gewählten, weiterhin passenden Buchungen um', () => {
    const general = wrongRule();
    const [first, second] = bakeryIds();
    const change = setTransactionCategory(db, first as number, category('Lebensmittel'));
    const learned = createRule(db, { ...(change.suggestion as NonNullable<typeof change.suggestion>) });
    const vermieter = txId('Vermieter Beispiel'); // per Regel „b“, passt aber nicht auf die neue Regel

    expect(reassignCandidates(db, learned.id).map((c) => c.id)).toEqual([second]);
    expect(reassignToRule(db, learned.id, [second as number, vermieter])).toBe(1);

    const row = db.prepare('SELECT category_id, category_source, category_rule_id FROM transactions WHERE id = ?').get(second) as Record<string, unknown>;
    expect(row).toEqual({ category_id: category('Lebensmittel'), category_source: 'rule', category_rule_id: learned.id });
    expect(categoryOf('Vermieter Beispiel')).toMatchObject({ ruleId: general.id, categoryId: category('Sonstiges') });
    // Erneut: nichts mehr umzustellen.
    expect(reassignCandidates(db, learned.id)).toEqual([]);
  });
});

describe('Unkategorisierte Buchungen', () => {
  beforeEach(() => {
    importGiro();
  });

  it('liefert Anzahl und Summen und lässt sich filtern', () => {
    // 10 Buchungen, davon eine Umbuchung („Umbuchung Ausgabenkonto“) – sie zählt nicht.
    const before = uncategorizedSummary(db);
    expect(before).toMatchObject({ count: 9, inflowCents: 285000 });

    setTransactionCategory(db, txId('Muster Arbeitgeber GmbH'), category('Einkommen'));
    const after = uncategorizedSummary(db);
    expect(after).toEqual({ count: 8, inflowCents: 0, outflowCents: before.outflowCents });
    expect(listTransactions(db, { uncategorized: true }).total).toBe(8);
  });

  it('filtert nach Kategorie inklusive Unterkategorien', () => {
    const lebensmittel = category('Lebensmittel');
    const sub = Number(
      db.prepare("INSERT INTO categories (name, parent_id, inherit_bucket, created_at) VALUES ('Bäcker', ?, 1, 'x')").run(lebensmittel).lastInsertRowid,
    );
    setTransactionCategory(db, txId('Bäckerei Müller'), sub);
    setTransactionCategory(db, txId('SUPERMARKT BEISPIEL, MUSTERSTADT'), lebensmittel);
    expect(listTransactions(db, { categoryId: lebensmittel }).total).toBe(2);
    expect(listTransactions(db, { categoryId: sub }).items.map((t) => t.categoryPath)).toEqual(['Lebensmittel › Bäcker']);
  });
});
