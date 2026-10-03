import type { Db } from '../db/connection.js';
import { isValidIsoDate } from '../lib/date.js';
import { AppError } from '../lib/errors.js';
import { parseGermanAmount } from '../lib/money.js';
import { normalizeCounterparty } from '../lib/normalize.js';
import {
  containsWords,
  contractKey,
  effectiveCounterparty,
  providerKey,
  providerOf,
  recurringLabel,
  type RecurringKeyInput,
} from '../lib/recurring-key.js';
import { nowIso } from '../lib/time.js';
import { assertAssignableCategory } from './categories.js';
import { coveredPeriods, mergePeriods, type Period } from './coverage.js';
import { monthlyEquivalent, type Interval } from './recurring-debits.js';
import { checkItem, distanceToSchedule, type ItemCheck, type NoticeUnit } from './recurring-check.js';
import { detectRecurring, type DetectDebit, type DetectedSeries } from './recurring-detection.js';

/**
 * Fixkosten und Abos (CLAUDE.md § 14). Hauptweg ist das Anlegen von Hand;
 * die automatische Erkennung liefert nur Vorschläge.
 *
 * Welche Buchungen zu einem Posten gehören, wird bei jeder Anzeige aus den
 * Merkmalen des Postens berechnet (Erkennungsschlüssel, Gläubiger-ID plus
 * Mandatsreferenz, Gegenpartei) – gespeichert wird nur, was ein Mensch
 * entschieden hat: von Hand zugeordnet (`recurring_source = 'manual'`) oder
 * bewusst „nicht wiederkehrend“. Umbuchungen gehören nie dazu.
 *
 * Vorschläge werden ebenfalls bei jeder Anzeige neu erkannt; gespeichert
 * wird ein Vorschlag erst, wenn er übernommen (`confirmed`) oder verworfen
 * (`dismissed`) wird. So bleiben nach einem Rückgängig keine veralteten
 * Vorschläge stehen.
 */

export type RecurringKind = 'fixed_cost' | 'subscription';

export interface RecurringItem {
  id: number;
  name: string;
  kind: RecurringKind;
  accountId: number | null;
  accountName: string | null;
  counterparty: string;
  /** Soll-Betrag der Abbuchung, positiv. */
  amountCents: number;
  interval: Interval;
  monthlyCents: number;
  nextDueDate: string | null;
  contractEndDate: string | null;
  noticePeriodValue: number | null;
  noticePeriodUnit: NoticeUnit | null;
  categoryId: number | null;
  categoryPath: string | null;
  creditorId: string | null;
  mandateReference: string | null;
  origin: 'manual' | 'auto';
  isSuspected: boolean;
  active: boolean;
  notes: string | null;
  detectionKey: string | null;
  bookingCount: number;
  check: ItemCheck;
  /** Andere laufende Posten oder Vorschläge beim selben Anbieter mit ähnlichem Betrag (doppeltes Abo?). */
  duplicates: string[];
}

export interface RecurringSuggestion extends DetectedSeries {
  accountName: string;
  categoryPath: string | null;
  duplicates: string[];
}

export interface DismissedSuggestion {
  id: number;
  name: string;
  amountCents: number;
  interval: Interval;
  detectionKey: string;
}

export interface RecurringOverview {
  items: RecurringItem[];
  /** Laufende Vorschläge zuerst, beendete danach. */
  suggestions: RecurringSuggestion[];
  dismissed: DismissedSuggestion[];
  totals: { count: number; monthlyCents: number; fixedCostMonthlyCents: number; subscriptionMonthlyCents: number };
}

interface ItemRow {
  id: number;
  name: string;
  kind: RecurringKind;
  account_id: number | null;
  account_name: string | null;
  counterparty: string;
  counterparty_normalized: string;
  amount_cents: number;
  interval: Interval;
  next_due_date: string | null;
  contract_end_date: string | null;
  notice_period_value: number | null;
  notice_period_unit: NoticeUnit | null;
  category_id: number | null;
  category_path: string | null;
  creditor_id: string | null;
  mandate_reference: string | null;
  origin: 'manual' | 'auto';
  status: 'suggested' | 'confirmed' | 'dismissed';
  is_suspected: number;
  active: number;
  notes: string | null;
  detection_key: string | null;
}

interface DebitRow {
  id: number;
  account_id: number;
  account_role: string;
  booking_date: string;
  amount_cents: number;
  counterparty: string;
  counterparty_normalized: string;
  purpose: string;
  booking_text: string;
  creditor_id: string | null;
  mandate_reference: string | null;
  category_id: number | null;
  recurring_item_id: number | null;
  recurring_source: 'manual' | null;
}

interface Debit {
  row: DebitRow;
  keys: { contract: string; provider: string; counterparty: string };
}

const CATEGORY_PATH = `CASE WHEN p.id IS NULL THEN c.name ELSE p.name || ' › ' || c.name END`;

function loadItems(db: Db): ItemRow[] {
  return db
    .prepare(
      `SELECT r.*, a.name AS account_name, ${CATEGORY_PATH} AS category_path
         FROM recurring_items r
         LEFT JOIN accounts a ON a.id = r.account_id
         LEFT JOIN categories c ON c.id = r.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
        ORDER BY r.active DESC, r.name COLLATE NOCASE, r.id`,
    )
    .all() as ItemRow[];
}

/** Alle Abbuchungen ohne Umbuchungen – Umbuchungen sind nie Fixkosten oder Abo. */
function loadDebits(db: Db): Debit[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.account_id, a.role AS account_role, t.booking_date, t.amount_cents, t.counterparty,
              t.counterparty_normalized, t.purpose, t.booking_text, t.creditor_id, t.mandate_reference, t.category_id,
              t.recurring_item_id, t.recurring_source
         FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.amount_cents < 0 AND t.transfer_id IS NULL
        ORDER BY t.booking_date, t.id`,
    )
    .all() as DebitRow[];
  return rows.map((row) => {
    const input = keyInput(row);
    return { row, keys: { contract: contractKey(input), provider: providerKey(input), counterparty: effectiveCounterparty(input) } };
  });
}

const keyInput = (r: DebitRow): RecurringKeyInput => ({
  counterparty: r.counterparty,
  counterpartyNormalized: r.counterparty_normalized,
  purpose: r.purpose,
  creditorId: r.creditor_id,
  mandateReference: r.mandate_reference,
});

/** Letzter importierter Tag und abgedeckte Zeiträume je Konto. */
function loadCoverage(db: Db): Map<number, { end: string | null; periods: Period[] }> {
  const result = new Map<number, { end: string | null; periods: Period[] }>();
  const lastBooking = new Map(
    (db.prepare('SELECT account_id, max(booking_date) AS d FROM transactions GROUP BY account_id').all() as { account_id: number; d: string }[]).map(
      (r) => [r.account_id, r.d],
    ),
  );
  for (const { id } of db.prepare('SELECT id FROM accounts').all() as { id: number }[]) {
    const periods = coveredPeriods(db, id);
    const ends = [periods[periods.length - 1]?.end, lastBooking.get(id)].filter((d): d is string => d !== undefined);
    result.set(id, { end: ends.sort().pop() ?? null, periods });
  }
  return result;
}

/** Erkennungsschlüssel ohne Zusätze (doppeltes Abo `@d…`, zweiter Durchgang `|p`). */
const baseDetectionKey = (key: string) => key.replace(/@d\d+$/, '').replace(/\|p$/, '');

/** Betrag passt grob (Hälfte bis Doppeltes) – nötig, wo nur die Gegenpartei verbindet. */
const amountFits = (soll: number, ist: number) => ist * 2 >= soll && ist <= soll * 2;

/**
 * Wie gut passt eine Buchung zu einem Posten? Kleiner = besser, `null` = gar
 * nicht. Reihenfolge: Erkennungsschlüssel des Vertrags, Gläubiger-ID mit
 * Mandatsreferenz, Erkennungsschlüssel des Anbieters, Gläubiger-ID allein,
 * Gegenpartei (ganze Wörter) mit grob passendem Betrag.
 */
function matchRank(item: ItemRow, d: Debit): number | null {
  if (item.account_id !== null && item.account_id !== d.row.account_id) return null;
  const amount = -d.row.amount_cents;
  const soll = -item.amount_cents;
  if (item.detection_key) {
    const base = baseDetectionKey(item.detection_key);
    if (base === d.keys.contract && (!base.startsWith('cp:') || amountFits(soll, amount))) return 1;
  }
  if (item.creditor_id && d.row.creditor_id && item.creditor_id.toUpperCase() === d.row.creditor_id.toUpperCase()) {
    if (item.mandate_reference) {
      if (item.mandate_reference === d.row.mandate_reference) return 2;
    } else if (!item.detection_key) {
      return 4;
    }
  }
  if (item.detection_key) {
    const provider = providerOf(item.detection_key);
    if (provider === d.keys.provider && (!provider.startsWith('cp:') || amountFits(soll, amount))) return 3;
  }
  if (item.counterparty_normalized && containsWords(d.keys.counterparty, item.counterparty_normalized) && amountFits(soll, amount)) {
    return 5;
  }
  return null;
}

/**
 * Ordnet Buchungen den übernommenen Posten zu: von Hand zugeordnete fest,
 * sonst der am besten passende Posten (Rang, dann Nähe zum Termin, dann
 * Betrag). Buchungen, die bewusst „nicht wiederkehrend“ sind, nie.
 */
function assign(items: ItemRow[], debits: Debit[]): Map<number, Debit[]> {
  const byItem = new Map<number, Debit[]>(items.map((i) => [i.id, []]));
  const confirmed = items.filter((i) => i.status === 'confirmed');
  for (const d of debits) {
    if (d.row.recurring_source === 'manual') {
      if (d.row.recurring_item_id !== null) byItem.get(d.row.recurring_item_id)?.push(d);
      continue;
    }
    let best: { item: ItemRow; score: [number, number, number] } | null = null;
    for (const item of confirmed) {
      const rank = matchRank(item, d);
      if (rank === null) continue;
      const anchor = item.next_due_date;
      const score: [number, number, number] = [
        rank,
        anchor ? distanceToSchedule(anchor, item.interval, d.row.booking_date) : 0,
        Math.abs(item.amount_cents - d.row.amount_cents),
      ];
      const better =
        !best ||
        score[0] < best.score[0] ||
        (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])));
      if (better) best = { item, score };
    }
    if (best) byItem.get(best.item.id)?.push(d);
  }
  return byItem;
}

/** Zuordnung Buchung → Posten (für die Buchungsliste). */
export interface RecurringAssignment {
  itemId: number;
  itemName: string;
  source: 'manual' | 'auto';
}

export function recurringAssignments(db: Db): Map<number, RecurringAssignment> {
  const items = loadItems(db);
  const names = new Map(items.map((i) => [i.id, i.name]));
  const result = new Map<number, RecurringAssignment>();
  for (const [itemId, debits] of assign(items, loadDebits(db))) {
    for (const d of debits) {
      result.set(d.row.id, { itemId, itemName: names.get(itemId) ?? '', source: d.row.recurring_source === 'manual' ? 'manual' : 'auto' });
    }
  }
  return result;
}

/** Doppelte Abos: gleicher Anbieter, gleiches Intervall, Betrag höchstens 25 % auseinander. */
function similar(a: { provider: string; interval: Interval; amount: number }, b: { provider: string; interval: Interval; amount: number }): boolean {
  if (a.provider !== b.provider || a.interval !== b.interval) return false;
  const [lo, hi] = a.amount < b.amount ? [a.amount, b.amount] : [b.amount, a.amount];
  return hi * 100 <= lo * 125;
}

function itemProvider(item: ItemRow): string {
  if (item.detection_key) return providerOf(item.detection_key);
  if (item.creditor_id) return `cid:${item.creditor_id.toUpperCase()}`;
  return `cp:${item.counterparty_normalized}`;
}

export function listRecurring(db: Db, today: string): RecurringOverview {
  const rows = loadItems(db);
  const debits = loadDebits(db);
  const coverage = loadCoverage(db);
  const accountNames = new Map((db.prepare('SELECT id, name FROM accounts').all() as { id: number; name: string }[]).map((a) => [a.id, a.name]));
  const categoryPaths = new Map(
    (
      db
        .prepare(`SELECT c.id, ${CATEGORY_PATH} AS path FROM categories c LEFT JOIN categories p ON p.id = c.parent_id`)
        .all() as { id: number; path: string }[]
    ).map((c) => [c.id, c.path]),
  );

  const assigned = assign(rows, debits);
  const allPeriods = mergePeriods([...coverage.values()].flatMap((c) => c.periods));
  const allEnd = [...coverage.values()].map((c) => c.end).filter((d): d is string => d !== null).sort().pop() ?? null;

  const items: RecurringItem[] = rows
    .filter((r) => r.status === 'confirmed')
    .map((r) => {
      const own = assigned.get(r.id) ?? [];
      const cov = r.account_id === null ? { end: allEnd, periods: allPeriods } : (coverage.get(r.account_id) ?? { end: null, periods: [] });
      const check = checkItem(
        {
          amountCents: -r.amount_cents,
          interval: r.interval,
          nextDueDate: r.next_due_date,
          contractEndDate: r.contract_end_date,
          noticePeriodValue: r.notice_period_value,
          noticePeriodUnit: r.notice_period_unit,
          active: r.active === 1,
        },
        own.map((d) => ({ transactionId: d.row.id, date: d.row.booking_date, amountCents: -d.row.amount_cents })),
        { dataEnd: cov.end, covered: cov.periods, today },
      );
      return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        accountId: r.account_id,
        accountName: r.account_name,
        counterparty: r.counterparty,
        amountCents: -r.amount_cents,
        interval: r.interval,
        monthlyCents: monthlyEquivalent(-r.amount_cents, r.interval),
        nextDueDate: r.next_due_date,
        contractEndDate: r.contract_end_date,
        noticePeriodValue: r.notice_period_value,
        noticePeriodUnit: r.notice_period_unit,
        categoryId: r.category_id,
        categoryPath: r.category_path,
        creditorId: r.creditor_id,
        mandateReference: r.mandate_reference,
        origin: r.origin,
        isSuspected: r.is_suspected === 1,
        active: r.active === 1,
        notes: r.notes,
        detectionKey: r.detection_key,
        bookingCount: own.length,
        check,
        duplicates: [],
      };
    });

  // Vorschläge: nur aus Buchungen, die noch keinem Posten gehören und nicht
  // von Hand als „nicht wiederkehrend“ markiert sind.
  const taken = new Set([...assigned.values()].flatMap((list) => list.map((d) => d.row.id)));
  const free = debits.filter((d) => !taken.has(d.row.id) && d.row.recurring_source !== 'manual');
  const known = new Set(rows.map((r) => r.detection_key).filter((k): k is string => k !== null));
  const dataEnd = new Map([...coverage.entries()].filter(([, c]) => c.end !== null).map(([id, c]) => [id, c.end as string]));
  const detected = detectRecurring(
    free.map(
      (d): DetectDebit => ({
        transactionId: d.row.id,
        accountId: d.row.account_id,
        date: d.row.booking_date,
        amountCents: d.row.amount_cents,
        contractKey: d.keys.contract,
        providerKey: d.keys.provider,
        label: recurringLabel(keyInput(d.row)),
        text: `${d.row.booking_text} ${d.row.purpose}`,
        viaCardOrIntermediary: d.row.account_role === 'kreditkarte' || d.keys.counterparty.startsWith('paypal '),
        categoryId: d.row.category_id,
      }),
    ),
    dataEnd,
  );
  const suggestions: RecurringSuggestion[] = detected
    .filter((s) => !known.has(s.key))
    .map((s) => ({
      ...s,
      accountName: accountNames.get(s.accountId) ?? '',
      categoryPath: s.categoryId === null ? null : (categoryPaths.get(s.categoryId) ?? null),
      duplicates: [],
    }));

  // Doppelte Abos unter laufenden Posten und Vorschlägen.
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const running = [
    ...items
      .filter((i) => i.active && i.check.status !== 'ended')
      .map((i) => ({ name: i.name, provider: itemProvider(rowById.get(i.id) as ItemRow), interval: i.interval, amount: i.amountCents, target: i.duplicates })),
    ...suggestions
      .filter((s) => !s.ended)
      .map((s) => ({ name: s.label, provider: s.providerKey, interval: s.interval, amount: s.lastAmountCents, target: s.duplicates })),
  ];
  for (const a of running) {
    for (const b of running) if (a !== b && similar(a, b)) a.target.push(b.name);
  }

  const counted = items.filter((i) => i.active);
  const sum = (list: RecurringItem[]) => list.reduce((s, i) => s + i.monthlyCents, 0);
  return {
    items,
    suggestions,
    dismissed: rows
      .filter((r) => r.status === 'dismissed' && r.detection_key !== null)
      .map((r) => ({ id: r.id, name: r.name, amountCents: -r.amount_cents, interval: r.interval, detectionKey: r.detection_key as string })),
    totals: {
      count: counted.length,
      monthlyCents: sum(counted),
      fixedCostMonthlyCents: sum(counted.filter((i) => i.kind === 'fixed_cost')),
      subscriptionMonthlyCents: sum(counted.filter((i) => i.kind === 'subscription')),
    },
  };
}

// ---------------------------------------------------------------------------
// Anlegen, ändern, löschen
// ---------------------------------------------------------------------------

export interface RecurringItemInput {
  name?: string | undefined;
  kind: RecurringKind;
  accountId: number | null;
  counterparty: string;
  /** Deutscher Betrag der Abbuchung, z. B. „9,99“ (ohne Vorzeichen). */
  amount: string;
  interval: Interval;
  nextDueDate: string;
  contractEndDate?: string | null | undefined;
  noticePeriodValue?: number | null | undefined;
  noticePeriodUnit?: NoticeUnit | null | undefined;
  categoryId?: number | null | undefined;
  creditorId?: string | null | undefined;
  mandateReference?: string | null | undefined;
  active?: boolean | undefined;
  notes?: string | null | undefined;
}

interface Validated {
  name: string;
  kind: RecurringKind;
  accountId: number | null;
  counterparty: string;
  amountCents: number;
  interval: Interval;
  nextDueDate: string;
  contractEndDate: string | null;
  noticePeriodValue: number | null;
  noticePeriodUnit: NoticeUnit | null;
  categoryId: number | null;
  creditorId: string | null;
  mandateReference: string | null;
  active: boolean;
  notes: string | null;
}

function validate(db: Db, input: RecurringItemInput): Validated {
  const counterparty = input.counterparty.trim();
  const name = input.name?.trim() || counterparty;
  if (!name) throw new AppError('Name oder Gegenpartei angeben.');
  const parsed = parseGermanAmount(input.amount);
  if (parsed === null || parsed === 0) throw new AppError(`„${input.amount}“ ist kein Betrag (Beispiel: 9,99).`);
  if (!isValidIsoDate(input.nextDueDate)) throw new AppError(`„${input.nextDueDate}“ ist kein gültiger nächster Termin.`);
  const contractEndDate = input.contractEndDate || null;
  if (contractEndDate !== null && !isValidIsoDate(contractEndDate)) throw new AppError(`„${contractEndDate}“ ist kein gültiges Vertragsende.`);
  const noticePeriodValue = input.noticePeriodValue ?? null;
  const noticePeriodUnit = noticePeriodValue === null ? null : (input.noticePeriodUnit ?? 'months');
  if (noticePeriodValue !== null && (!Number.isInteger(noticePeriodValue) || noticePeriodValue < 1)) {
    throw new AppError('Die Kündigungsfrist muss eine ganze Zahl ab 1 sein.');
  }
  if (noticePeriodValue !== null && contractEndDate === null) throw new AppError('Eine Kündigungsfrist braucht ein Vertragsende.');
  if (input.accountId !== null && !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(input.accountId)) {
    throw new AppError(`Konto ${input.accountId} existiert nicht.`, 404);
  }
  const categoryId = input.categoryId ?? null;
  if (categoryId !== null) assertAssignableCategory(db, categoryId);
  return {
    name,
    kind: input.kind,
    accountId: input.accountId,
    counterparty,
    amountCents: -Math.abs(parsed),
    interval: input.interval,
    nextDueDate: input.nextDueDate,
    contractEndDate,
    noticePeriodValue,
    noticePeriodUnit,
    categoryId,
    creditorId: input.creditorId?.trim() || null,
    mandateReference: input.mandateReference?.trim() || null,
    active: input.active ?? true,
    notes: input.notes?.trim() || null,
  };
}

function getRow(db: Db, id: number): ItemRow {
  const row = db.prepare('SELECT * FROM recurring_items WHERE id = ?').get(id) as ItemRow | undefined;
  if (!row) throw new AppError(`Fixkosten/Abo ${id} existiert nicht.`, 404);
  return row;
}

/** Legt eine Fixkostenposition bzw. ein Abo von Hand an. */
export function createRecurringItem(db: Db, input: RecurringItemInput): { id: number } {
  const v = validate(db, input);
  const now = nowIso();
  const result = db
    .prepare(
      `INSERT INTO recurring_items
         (name, kind, account_id, counterparty, counterparty_normalized, amount_cents, interval, next_due_date,
          contract_end_date, notice_period_value, notice_period_unit, category_id, creditor_id, mandate_reference,
          origin, status, is_suspected, active, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'confirmed', 0, ?, ?, ?, ?)`,
    )
    .run(
      v.name,
      v.kind,
      v.accountId,
      v.counterparty,
      normalizeCounterparty(v.counterparty),
      v.amountCents,
      v.interval,
      v.nextDueDate,
      v.contractEndDate,
      v.noticePeriodValue,
      v.noticePeriodUnit,
      v.categoryId,
      v.creditorId,
      v.mandateReference,
      v.active ? 1 : 0,
      v.notes,
      now,
      now,
    );
  return { id: Number(result.lastInsertRowid) };
}

/** Ändert einen übernommenen Posten. Der Erkennungsschlüssel bleibt – er verbindet den Posten mit seinen Buchungen. */
export function updateRecurringItem(db: Db, id: number, input: RecurringItemInput): void {
  const row = getRow(db, id);
  if (row.status !== 'confirmed') throw new AppError('Verworfene Vorschläge lassen sich nicht bearbeiten.');
  const v = validate(db, input);
  // Bei übernommenen Vorschlägen ist die gespeicherte Gegenpartei die erkannte
  // (z. B. „paypal audible“); nur eine geänderte Gegenpartei wird neu normalisiert.
  const normalized = v.counterparty === row.counterparty ? row.counterparty_normalized : normalizeCounterparty(v.counterparty);
  db.prepare(
    `UPDATE recurring_items
        SET name = ?, kind = ?, account_id = ?, counterparty = ?, counterparty_normalized = ?, amount_cents = ?,
            interval = ?, next_due_date = ?, contract_end_date = ?, notice_period_value = ?, notice_period_unit = ?,
            category_id = ?, creditor_id = ?, mandate_reference = ?, is_suspected = 0, active = ?, notes = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    v.name,
    v.kind,
    v.accountId,
    v.counterparty,
    normalized,
    v.amountCents,
    v.interval,
    v.nextDueDate,
    v.contractEndDate,
    v.noticePeriodValue,
    v.noticePeriodUnit,
    v.categoryId,
    v.creditorId,
    v.mandateReference,
    v.active ? 1 : 0,
    v.notes,
    nowIso(),
    id,
  );
}

/**
 * Löscht einen Posten (Fehlerkennung oder nicht mehr gewünscht) bzw. holt
 * einen verworfenen Vorschlag zurück. Von Hand zugeordnete Buchungen werden
 * wieder frei.
 */
export function deleteRecurringItem(db: Db, id: number): void {
  getRow(db, id);
  db.transaction(() => {
    db.prepare('UPDATE transactions SET recurring_item_id = NULL, recurring_source = NULL WHERE recurring_item_id = ?').run(id);
    db.prepare('DELETE FROM recurring_items WHERE id = ?').run(id);
  })();
}

// ---------------------------------------------------------------------------
// Vorschläge übernehmen oder verwerfen
// ---------------------------------------------------------------------------

function findSuggestion(db: Db, key: string, today: string): RecurringSuggestion {
  const suggestion = listRecurring(db, today).suggestions.find((s) => s.key === key);
  if (!suggestion) throw new AppError('Diesen Vorschlag gibt es nicht (mehr) – die Liste neu laden.', 404);
  return suggestion;
}

/** Bestandteile eines Vorschlags für einen neuen Posten. */
function suggestionFields(db: Db, s: RecurringSuggestion) {
  const last = db
    .prepare('SELECT counterparty, counterparty_normalized, purpose, creditor_id, mandate_reference FROM transactions WHERE id = ?')
    .get(s.transactionIds[s.transactionIds.length - 1]) as {
    counterparty: string;
    counterparty_normalized: string;
    purpose: string;
    creditor_id: string | null;
    mandate_reference: string | null;
  };
  const input: RecurringKeyInput = {
    counterparty: last.counterparty,
    counterpartyNormalized: last.counterparty_normalized,
    purpose: last.purpose,
    creditorId: last.creditor_id,
    mandateReference: last.mandate_reference,
  };
  const viaIntermediary = effectiveCounterparty(input).startsWith('paypal ');
  return {
    counterparty: s.label,
    counterpartyNormalized: effectiveCounterparty(input),
    creditorId: viaIntermediary ? null : last.creditor_id,
    mandateReference: viaIntermediary ? null : last.mandate_reference,
  };
}

export interface ConfirmInput {
  key: string;
  name?: string | undefined;
  kind?: RecurringKind | undefined;
}

/** Übernimmt einen Vorschlag als Fixkostenposition bzw. Abo. */
export function confirmSuggestion(db: Db, input: ConfirmInput, today: string): { id: number } {
  const s = findSuggestion(db, input.key, today);
  const f = suggestionFields(db, s);
  const now = nowIso();
  const result = db
    .prepare(
      `INSERT INTO recurring_items
         (name, kind, account_id, counterparty, counterparty_normalized, amount_cents, interval, next_due_date,
          category_id, creditor_id, mandate_reference, detection_key, origin, status, is_suspected, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', 'confirmed', ?, ?, ?, ?)`,
    )
    .run(
      input.name?.trim() || s.label,
      input.kind ?? s.kind,
      s.accountId,
      f.counterparty,
      f.counterpartyNormalized,
      -s.lastAmountCents,
      s.interval,
      s.nextDueDate,
      s.categoryId,
      f.creditorId,
      f.mandateReference,
      s.key,
      s.suspected ? 1 : 0,
      s.ended ? 0 : 1,
      now,
      now,
    );
  return { id: Number(result.lastInsertRowid) };
}

/** Verwirft einen Vorschlag; er wird nicht erneut vorgeschlagen (zurückholen = löschen). */
export function dismissSuggestion(db: Db, key: string, today: string): { id: number } {
  const s = findSuggestion(db, key, today);
  const f = suggestionFields(db, s);
  const now = nowIso();
  const result = db
    .prepare(
      `INSERT INTO recurring_items
         (name, kind, account_id, counterparty, counterparty_normalized, amount_cents, interval, next_due_date,
          detection_key, origin, status, is_suspected, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', 'dismissed', ?, 0, ?, ?)`,
    )
    .run(s.label, s.kind, s.accountId, f.counterparty, f.counterpartyNormalized, -s.lastAmountCents, s.interval, s.nextDueDate, s.key, s.suspected ? 1 : 0, now, now);
  return { id: Number(result.lastInsertRowid) };
}

// ---------------------------------------------------------------------------
// Buchungen von Hand zuordnen
// ---------------------------------------------------------------------------

function assertDebit(db: Db, txId: number): void {
  const tx = db.prepare('SELECT amount_cents, transfer_id FROM transactions WHERE id = ?').get(txId) as
    | { amount_cents: number; transfer_id: number | null }
    | undefined;
  if (!tx) throw new AppError(`Buchung ${txId} existiert nicht.`, 404);
  if (tx.transfer_id !== null) throw new AppError('Umbuchungen zwischen eigenen Konten sind weder Fixkosten noch Abo.');
  if (tx.amount_cents >= 0) throw new AppError('Nur Abbuchungen lassen sich als Fixkosten oder Abo markieren.');
}

/**
 * Markiert eine Buchung von Hand als zu einem Posten gehörig (`itemId`)
 * oder als „nicht wiederkehrend“ (`null`, entfernt eine Fehlerkennung).
 */
export function setTransactionRecurring(db: Db, txId: number, itemId: number | null): void {
  assertDebit(db, txId);
  if (itemId !== null && getRow(db, itemId).status !== 'confirmed') throw new AppError('Nur übernommene Posten lassen sich zuordnen.');
  db.prepare("UPDATE transactions SET recurring_item_id = ?, recurring_source = 'manual' WHERE id = ?").run(itemId, txId);
}

/** Hebt eine Zuordnung von Hand auf – die Buchung wird wieder automatisch zugeordnet. */
export function resetTransactionRecurring(db: Db, txId: number): void {
  if (!db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(txId)) throw new AppError(`Buchung ${txId} existiert nicht.`, 404);
  db.prepare('UPDATE transactions SET recurring_item_id = NULL, recurring_source = NULL WHERE id = ?').run(txId);
}
