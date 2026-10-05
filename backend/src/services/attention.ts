import type { Db } from '../db/connection.js';
import { daysBetween } from '../lib/date.js';
import { getCoverage, pastGaps, type Period } from './coverage.js';
import { lastExportAt } from './data-export.js';
import type { TrendStatus } from './funding-analysis.js';
import { getFunding } from './funding.js';
import type { Interval } from './recurring-debits.js';
import { listRecurring } from './recurring.js';
import { uncategorizedSummary } from './transactions.js';
import { listTransfers } from './transfers.js';

/**
 * Offene Punkte der Startseite (CLAUDE.md § 15): alles, was eine Handlung
 * erfordert. Wird bei jeder Anzeige neu berechnet – nichts davon wird
 * gespeichert. Geliefert werden nur Daten; Text, Beträge und der Sprung
 * zur passenden Seite entstehen in der Oberfläche.
 */

/** Ein Konto gilt als länger nicht importiert, wenn sein letzter importierter Tag so viele Tage zurückliegt. */
export const STALE_IMPORT_DAYS = 35;

/** Hinweis auf einen Export, wenn der letzte so viele Tage zurückliegt (CLAUDE.md § 16). */
export const EXPORT_REMINDER_DAYS = 30;

export type AttentionSeverity = 'bad' | 'warn' | 'info';

interface Base {
  severity: AttentionSeverity;
}

export interface FundingDeficitItem extends Base {
  kind: 'funding_deficit';
  accountId: number;
  accountName: string;
  /** single = 1–2 Monate Unterdeckung in Folge, trend = ab 3; null = keine Unterdeckung (nur Empfehlung/Minus). */
  trendStatus: TrendStatus | null;
  deficitSince: string | null;
  deficitStreak: number;
  direction: 'growing' | 'shrinking' | 'steady' | null;
  /** Empfohlener Gesamtbetrag der Daueraufträge, wenn eine Erhöhung nötig ist. */
  recommendedCents: number | null;
  changeCents: number | null;
  /** Konto im Minus. */
  negativeBalance: { balanceCents: number; date: string } | null;
}

export interface RecurringSuggestionsItem extends Base {
  kind: 'recurring_suggestions';
  entries: { key: string; name: string; amountCents: number; interval: Interval; duplicate: boolean }[];
}

export interface RecurringPriceItem extends Base {
  kind: 'recurring_price';
  /**
   * Die abweichende Buchung (jüngste einem Termin zugeordnete), nicht
   * unbedingt die letzte. actualCents > sollCents = teurer geworden.
   */
  entries: { itemId: number; name: string; sollCents: number; date: string | null; actualCents: number | null }[];
}

export interface RecurringMergedItem extends Base {
  kind: 'recurring_merged';
  /** Posten mit Buchungen mehrerer Verträge – Aufteilen anbieten. */
  entries: { itemId: number; name: string; contracts: number }[];
}

export interface RecurringMissingItem extends Base {
  kind: 'recurring_missing';
  /** ended = mindestens zwei erwartete Abbuchungen in Folge fehlen. */
  entries: { itemId: number; name: string; dueDate: string | null; ended: boolean }[];
}

export interface RecurringCancelItem extends Base {
  kind: 'recurring_cancel';
  entries: { itemId: number; name: string; cancelBy: string; contractEndDate: string }[];
}

export interface UncategorizedItem extends Base {
  kind: 'uncategorized';
  count: number;
  /** Positiv. */
  outflowCents: number;
  inflowCents: number;
}

export interface TransfersSuggestedItem extends Base {
  kind: 'transfers_suggested';
  count: number;
}

export interface CardMismatchItem extends Base {
  kind: 'card_mismatch';
  entries: {
    transferId: number;
    cardAccountId: number;
    cardAccountName: string | null;
    periodStart: string;
    periodEnd: string;
    /** Abbuchung minus Summe der Kartenumsätze. */
    differenceCents: number;
  }[];
}

export interface ImportGapItem extends Base {
  kind: 'import_gap';
  accountId: number;
  accountName: string;
  gaps: Period[];
}

export interface ImportStaleItem extends Base {
  kind: 'import_stale';
  accountId: number;
  accountName: string;
  /** Letzter importierter Tag. */
  lastDate: string;
  days: number;
}

export interface ExportDueItem extends Base {
  kind: 'export_due';
  /** Letzter Export; null = noch nie exportiert. */
  lastExportAt: string | null;
  /** Tage seit dem letzten Export; null = noch nie. */
  days: number | null;
}

export interface AccountOnlyItem extends Base {
  kind: 'never_imported' | 'needs_reimport';
  accountId: number;
  accountName: string;
}

export type AttentionItem =
  | FundingDeficitItem
  | RecurringSuggestionsItem
  | RecurringPriceItem
  | RecurringMergedItem
  | RecurringMissingItem
  | RecurringCancelItem
  | UncategorizedItem
  | TransfersSuggestedItem
  | CardMismatchItem
  | ImportGapItem
  | ImportStaleItem
  | ExportDueItem
  | AccountOnlyItem;

const SEVERITY_ORDER: Record<AttentionSeverity, number> = { bad: 0, warn: 1, info: 2 };

/** Unterdeckung laut Deckungsprüfung (§ 12) für jedes aktive Konto mit Rolle `ausgaben`. */
function fundingItems(db: Db, today: string): AttentionItem[] {
  const items: AttentionItem[] = [];
  const accounts = db.prepare("SELECT id FROM accounts WHERE role = 'ausgaben' AND active = 1 ORDER BY id").all() as { id: number }[];
  for (const { id } of accounts) {
    const f = getFunding(db, id, today);
    const t = f.trend;
    const r = f.recommendation;
    // Wie auf der Seite Deckung: Ein einzelner schlechter Monat zählt nicht, wenn der Dauerauftrag laut Empfehlung passt.
    const deficit = t.status === 'trend' || (t.status === 'single' && r?.verdict !== 'fits');
    const increase = r?.verdict === 'increase';
    const negative = f.balance.status === 'negative' && f.balance.current !== null;
    if (!deficit && !increase && !negative) continue;
    items.push({
      kind: 'funding_deficit',
      severity: t.status === 'trend' || negative ? 'bad' : 'warn',
      accountId: id,
      accountName: f.accountName,
      trendStatus: deficit ? t.status : null,
      deficitSince: deficit ? t.deficitSince : null,
      deficitStreak: deficit ? t.deficitStreak : 0,
      direction: deficit ? t.direction : null,
      recommendedCents: increase ? (r?.recommendedCents ?? null) : null,
      changeCents: increase ? (r?.changeCents ?? null) : null,
      negativeBalance:
        negative && f.balance.current ? { balanceCents: f.balance.current.balanceCents, date: f.balance.current.date } : null,
    });
  }
  return items;
}

/** Fixkosten und Abos (§ 14): neue Vorschläge, teurer gewordene, fehlende Abbuchungen, Kündigungsfristen. */
function recurringItems(db: Db, today: string): AttentionItem[] {
  const overview = listRecurring(db, today);
  const items: AttentionItem[] = [];

  const fresh = overview.suggestions.filter((s) => !s.ended);
  if (fresh.length > 0) {
    items.push({
      kind: 'recurring_suggestions',
      severity: 'info',
      entries: fresh.map((s) => ({
        key: s.key,
        name: s.label,
        amountCents: s.lastAmountCents,
        interval: s.interval,
        duplicate: s.duplicates.length > 0,
      })),
    });
  }

  const running = overview.items.filter((i) => i.active);
  const differs = running.filter((i) => i.check.status === 'differs');
  if (differs.length > 0) {
    items.push({
      kind: 'recurring_price',
      severity: 'warn',
      entries: differs.map((i) => ({
        itemId: i.id,
        name: i.name,
        sollCents: i.amountCents,
        date: i.check.differing?.date ?? null,
        actualCents: i.check.differing?.amountCents ?? null,
      })),
    });
  }

  const merged = overview.items.filter((i) => i.contracts !== null);
  if (merged.length > 0) {
    items.push({
      kind: 'recurring_merged',
      severity: 'warn',
      entries: merged.map((i) => ({ itemId: i.id, name: i.name, contracts: i.contracts?.length ?? 0 })),
    });
  }

  const missing = running.filter((i) => i.check.status === 'missing' || i.check.status === 'ended');
  if (missing.length > 0) {
    items.push({
      kind: 'recurring_missing',
      severity: 'warn',
      entries: missing.map((i) => ({
        itemId: i.id,
        name: i.name,
        dueDate: i.check.occurrences.find((o) => o.state === 'missing')?.dueDate ?? null,
        ended: i.check.status === 'ended',
      })),
    });
  }

  const cancel = running.filter((i) => i.check.cancel?.state === 'soon');
  if (cancel.length > 0) {
    items.push({
      kind: 'recurring_cancel',
      severity: 'warn',
      entries: cancel.map((i) => ({
        itemId: i.id,
        name: i.name,
        cancelBy: i.check.cancel?.cancelBy as string,
        contractEndDate: i.check.cancel?.contractEndDate as string,
      })),
    });
  }
  return items;
}

/** Umbuchungen (§ 10, § 11): unbestätigte und Kartenabrechnungen, deren Summe nicht passt. */
function transferItems(db: Db, coverage: Map<number, Period[]>): AttentionItem[] {
  const items: AttentionItem[] = [];
  const transfers = listTransfers(db);
  const suggested = transfers.filter((t) => t.status === 'suggested').length;
  if (suggested > 0) items.push({ kind: 'transfers_suggested', severity: 'info', count: suggested });

  // Nur Abrechnungen, deren Zeitraum der Kartenimport (wenigstens teilweise)
  // abdeckt – ältere Abrechnungen vor dem ersten Kartenimport lassen sich
  // nicht prüfen und stehen weiter auf der Seite Umbuchungen.
  const entries: CardMismatchItem['entries'] = [];
  for (const t of transfers) {
    if (!t.card || t.card.differenceCents === 0 || t.toAccountId === null || !t.periodStart || !t.periodEnd) continue;
    const { periodStart, periodEnd } = t;
    const periods = coverage.get(t.toAccountId) ?? [];
    if (!periods.some((p) => p.start <= periodEnd && periodStart <= p.end)) continue;
    entries.push({
      transferId: t.id,
      cardAccountId: t.toAccountId,
      cardAccountName: t.toAccountName,
      periodStart,
      periodEnd,
      differenceCents: t.card.differenceCents,
    });
  }
  if (entries.length > 0) items.push({ kind: 'card_mismatch', severity: 'warn', entries });
  return items;
}

/** Import (§ 6): Lücken zwischen Importen, lange nicht importierte und nie importierte Konten. */
function importItems(db: Db, today: string, coverage: Map<number, Period[]>): AttentionItem[] {
  const items: AttentionItem[] = [];
  const accounts = db
    .prepare(
      `SELECT a.id, a.name,
              EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = a.id AND t.bank_booking_date IS NULL) AS needs_reimport,
              (SELECT max(booking_date) FROM transactions t WHERE t.account_id = a.id) AS last_booking
         FROM accounts a WHERE a.active = 1 ORDER BY a.id`,
    )
    .all() as { id: number; name: string; needs_reimport: number; last_booking: string | null }[];
  for (const a of accounts) {
    const base = { accountId: a.id, accountName: a.name };
    const periods = coverage.get(a.id) ?? [];
    if (periods.length === 0) {
      items.push({ kind: 'never_imported', severity: 'warn', ...base });
      continue;
    }
    // Lücken zwischen Importen; der Abstand seit dem letzten Import bis heute ist der Punkt „länger nicht importiert“.
    const gaps = pastGaps(periods, today);
    if (gaps.length > 0) items.push({ kind: 'import_gap', severity: 'warn', ...base, gaps });
    const lastPeriod = (periods[periods.length - 1] as Period).end;
    const lastDate = a.last_booking !== null && a.last_booking > lastPeriod ? a.last_booking : lastPeriod;
    const days = daysBetween(lastDate, today);
    if (days > STALE_IMPORT_DAYS) items.push({ kind: 'import_stale', severity: 'warn', ...base, lastDate, days });
    if (a.needs_reimport === 1) items.push({ kind: 'needs_reimport', severity: 'info', ...base });
  }
  return items;
}

/** Betrieb (§ 16): länger als 30 Tage (oder nie) exportiert – sobald es Buchungen gibt, die verloren gehen könnten. */
function exportItems(db: Db, today: string): AttentionItem[] {
  if (!db.prepare('SELECT 1 FROM transactions LIMIT 1').get()) return [];
  const last = lastExportAt(db);
  const days = last === null ? null : daysBetween(last.slice(0, 10), today);
  if (days !== null && days <= EXPORT_REMINDER_DAYS) return [];
  return [{ kind: 'export_due', severity: 'info', lastExportAt: last, days }];
}

export function getAttention(db: Db, today: string): AttentionItem[] {
  const coverage = new Map(
    (db.prepare('SELECT id FROM accounts').all() as { id: number }[]).map(({ id }) => [id, getCoverage(db, id, today).periods]),
  );
  const items: AttentionItem[] = [...fundingItems(db, today), ...recurringItems(db, today)];

  const uncategorized = uncategorizedSummary(db);
  if (uncategorized.count > 0) {
    items.push({
      kind: 'uncategorized',
      severity: 'warn',
      count: uncategorized.count,
      // uncategorizedSummary liefert Abflüsse mit Vorzeichen; hier wie überall in Phase 7 positiv.
      outflowCents: -uncategorized.outflowCents,
      inflowCents: uncategorized.inflowCents,
    });
  }

  items.push(...transferItems(db, coverage), ...importItems(db, today, coverage), ...exportItems(db, today));
  // Stabil sortiert: schwerwiegend zuerst, sonst in der Reihenfolge oben.
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => SEVERITY_ORDER[a.item.severity] - SEVERITY_ORDER[b.item.severity] || a.i - b.i)
    .map((x) => x.item);
}
