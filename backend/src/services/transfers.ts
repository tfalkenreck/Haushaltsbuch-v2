import type { Db } from '../db/connection.js';
import { addDays } from '../lib/date.js';
import { AppError } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';
import {
  cardDebitHint,
  daysApart,
  findCardPeriod,
  looksLikeCardCredit,
  matchPairs,
  oneSidedEvidence,
  ownAccountNamedBy,
  TRANSFER_WINDOW_DAYS,
  type CardPurchase,
  type OwnAccount,
  type TransferCandidate,
} from './transfer-detection.js';

/**
 * Umbuchungen zwischen eigenen Konten (CLAUDE.md § 10) und
 * Kartenabrechnungen (§ 11).
 *
 * - Eine Buchung mit `transfer_id` ist weder Einnahme noch Ausgabe.
 * - Die Erkennung fasst nur Buchungen an, die nie von Hand eingeordnet
 *   wurden (`transfer_id IS NULL AND transfer_source IS NULL`). Was sie
 *   findet, ist „vorgeschlagen“ – sichtbar, bestätigbar, aufhebbar.
 * - Kategorien werden nie verändert.
 * - Kartenabrechnung 1:n: nur Sammelabbuchung und Gutschrift auf dem
 *   Kartenkonto tragen `transfer_id`; die Kartenumsätze bleiben Ausgaben
 *   und gehören über `to_account_id` + Zeitraum (Kaufdatum) dazu.
 */

export type TransferKind = 'pair' | 'one_sided' | 'card_settlement';
export type TransferOrigin = 'auto' | 'manual';
export type TransferStatus = 'suggested' | 'confirmed';

interface TransferRow {
  id: number;
  kind: TransferKind;
  origin: TransferOrigin;
  status: TransferStatus;
  from_account_id: number | null;
  to_account_id: number | null;
  amount_cents: number;
  period_start: string | null;
  period_end: string | null;
  detection_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface LinkedTx {
  id: number;
  account_id: number;
  account_name: string;
  booking_date: string;
  amount_cents: number;
  counterparty: string;
  purpose: string;
  transfer_source: TransferOrigin | null;
}

export interface TransferTransaction {
  id: number;
  accountId: number;
  accountName: string;
  bookingDate: string;
  amountCents: number;
  counterparty: string;
  purpose: string;
}

export interface CardCheck {
  /** Kartenumsätze im Abrechnungszeitraum (nach Kaufdatum). */
  purchaseCount: number;
  /** Ihre Summe als positiver Abrechnungsbetrag (Erstattungen mindern ihn). */
  purchasesCents: number;
  /** Abgebuchter Betrag minus Summe der Kartenumsätze; 0 = plausibel. */
  differenceCents: number;
}

export interface Transfer {
  id: number;
  kind: TransferKind;
  origin: TransferOrigin;
  status: TransferStatus;
  fromAccountId: number | null;
  fromAccountName: string | null;
  toAccountId: number | null;
  toAccountName: string | null;
  amountCents: number;
  /** Frühestes Buchungsdatum der beteiligten Buchungen. */
  date: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  reason: string | null;
  transactions: TransferTransaction[];
  /** Eine Seite ist nicht importiert (einseitig oder Abrechnung mit nur einer Seite). */
  counterMissing: boolean;
  /** Nur Kartenabrechnung: Plausibilitätsprüfung. */
  card: CardCheck | null;
}

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------

function loadAccounts(db: Db): OwnAccount[] {
  return db.prepare('SELECT id, name, role, iban FROM accounts').all() as OwnAccount[];
}

interface CandidateRow {
  id: number;
  account_id: number;
  booking_date: string;
  amount_cents: number;
  counterparty: string;
  counterparty_iban: string | null;
  purpose: string;
}

const toCandidate = (r: CandidateRow): TransferCandidate => ({
  id: r.id,
  accountId: r.account_id,
  bookingDate: r.booking_date,
  amountCents: r.amount_cents,
  counterparty: r.counterparty,
  counterpartyIban: r.counterparty_iban,
  purpose: r.purpose,
});

/** Buchungen, die die Erkennung einordnen darf. */
function loadCandidates(db: Db): TransferCandidate[] {
  const rows = db
    .prepare(
      `SELECT id, account_id, booking_date, amount_cents, counterparty, counterparty_iban, purpose
         FROM transactions WHERE transfer_id IS NULL AND transfer_source IS NULL
        ORDER BY booking_date, id`,
    )
    .all() as CandidateRow[];
  return rows.map(toCandidate);
}

function loadTx(db: Db, id: number): CandidateRow & { transfer_id: number | null; transfer_source: TransferOrigin | null } {
  const row = db
    .prepare(
      `SELECT id, account_id, booking_date, amount_cents, counterparty, counterparty_iban, purpose, transfer_id, transfer_source
         FROM transactions WHERE id = ?`,
    )
    .get(id) as (CandidateRow & { transfer_id: number | null; transfer_source: TransferOrigin | null }) | undefined;
  if (!row) throw new AppError(`Buchung ${id} existiert nicht.`, 404);
  return row;
}

function linkedTransactions(db: Db, transferId: number): LinkedTx[] {
  return db
    .prepare(
      `SELECT t.id, t.account_id, a.name AS account_name, t.booking_date, t.amount_cents, t.counterparty, t.purpose,
              t.transfer_source
         FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.transfer_id = ? ORDER BY t.booking_date, t.id`,
    )
    .all(transferId) as LinkedTx[];
}

/** Kartenumsätze eines Kartenkontos: alles dort, was keine Umbuchung ist. */
function cardPurchases(db: Db, cardAccountId: number): CardPurchase[] {
  return (
    db
      .prepare(
        `SELECT booking_date, amount_cents FROM transactions
          WHERE account_id = ? AND transfer_id IS NULL ORDER BY booking_date`,
      )
      .all(cardAccountId) as { booking_date: string; amount_cents: number }[]
  ).map((r) => ({ bookingDate: r.booking_date, amountCents: r.amount_cents }));
}

// ---------------------------------------------------------------------------
// Schreiben
// ---------------------------------------------------------------------------

interface NewTransfer {
  kind: TransferKind;
  origin: TransferOrigin;
  fromAccountId: number | null;
  toAccountId: number | null;
  amountCents: number;
  periodStart?: string | null;
  periodEnd?: string | null;
  reason: string;
}

function insertTransfer(db: Db, t: NewTransfer, transactionIds: number[]): number {
  const now = nowIso();
  const id = Number(
    db
      .prepare(
        `INSERT INTO transfers (kind, origin, status, from_account_id, to_account_id, amount_cents,
                                period_start, period_end, detection_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.kind,
        t.origin,
        t.origin === 'manual' ? 'confirmed' : 'suggested',
        t.fromAccountId,
        t.toAccountId,
        t.amountCents,
        t.periodStart ?? null,
        t.periodEnd ?? null,
        t.reason,
        now,
        now,
      ).lastInsertRowid,
  );
  for (const txId of transactionIds) link(db, txId, id, t.origin);
  return id;
}

function link(db: Db, txId: number, transferId: number, source: TransferOrigin): void {
  db.prepare('UPDATE transactions SET transfer_id = ?, transfer_source = ? WHERE id = ?').run(transferId, source, txId);
}

/** Von wo nach wo: Abfluss = von diesem Konto, Zufluss = auf dieses Konto. */
function direction(t: { account_id: number; amount_cents: number }, otherAccountId: number | null) {
  return t.amount_cents < 0
    ? { fromAccountId: t.account_id, toAccountId: otherAccountId }
    : { fromAccountId: otherAccountId, toAccountId: t.account_id };
}

// ---------------------------------------------------------------------------
// Kartenabrechnung
// ---------------------------------------------------------------------------

/** Ende der letzten Abrechnung derselben Karte vor `date` – der neue Zeitraum beginnt am Tag danach. */
function previousPeriodEnd(db: Db, cardAccountId: number, date: string, excludeId: number | null): string | null {
  const rows = db
    .prepare(
      `SELECT tr.id, tr.period_end, (SELECT min(booking_date) FROM transactions t WHERE t.transfer_id = tr.id) AS d
         FROM transfers tr WHERE tr.kind = 'card_settlement' AND tr.to_account_id = ? AND tr.id IS NOT ?`,
    )
    .all(cardAccountId, excludeId) as { id: number; period_end: string | null; d: string | null }[];
  const before = rows.filter((r) => r.d !== null && r.d < date && r.period_end !== null);
  before.sort((a, b) => (a.d as string).localeCompare(b.d as string));
  const last = before[before.length - 1];
  return last ? addDays(last.period_end as string, 1) : null;
}

function computeCardPeriod(db: Db, cardAccountId: number, amountCents: number, date: string, excludeId: number | null) {
  return findCardPeriod(cardPurchases(db, cardAccountId), amountCents, date, previousPeriodEnd(db, cardAccountId, date, excludeId));
}

/**
 * Zeiträume der vorgeschlagenen Kartenabrechnungen neu bestimmen, in
 * zeitlicher Reihenfolge – neue Kartenumsätze können eine Abweichung
 * auflösen. Bestätigte und von Hand angelegte bleiben, wie sie sind.
 */
function recomputeCardPeriods(db: Db, cardAccountId: number): void {
  const rows = db
    .prepare(
      `SELECT tr.id, tr.amount_cents, tr.origin, tr.status, tr.period_start, tr.period_end,
              (SELECT min(booking_date) FROM transactions t WHERE t.transfer_id = tr.id) AS d
         FROM transfers tr WHERE tr.kind = 'card_settlement' AND tr.to_account_id = ?`,
    )
    .all(cardAccountId) as {
    id: number;
    amount_cents: number;
    origin: TransferOrigin;
    status: TransferStatus;
    period_start: string | null;
    period_end: string | null;
    d: string | null;
  }[];
  rows.sort((a, b) => (a.d ?? '').localeCompare(b.d ?? '') || a.id - b.id);
  const update = db.prepare('UPDATE transfers SET period_start = ?, period_end = ?, updated_at = ? WHERE id = ?');
  for (const row of rows) {
    if (row.d === null || row.origin === 'manual' || row.status === 'confirmed') continue;
    const period = computeCardPeriod(db, cardAccountId, row.amount_cents, row.d, row.id);
    if (period.start !== row.period_start || period.end !== row.period_end) update.run(period.start, period.end, nowIso(), row.id);
  }
}

/** Nächstgelegene Buchung mit Gegenbetrag auf einem bestimmten Konto. */
function nearestCounter(
  candidates: TransferCandidate[],
  used: Set<number>,
  t: { bookingDate: string; amountCents: number },
  accept: (c: TransferCandidate) => boolean,
): TransferCandidate | null {
  let best: TransferCandidate | null = null;
  let bestDays = Infinity;
  for (const c of candidates) {
    if (used.has(c.id) || c.amountCents !== -t.amountCents || !accept(c)) continue;
    const days = daysApart(c.bookingDate, t.bookingDate);
    if (days <= TRANSFER_WINDOW_DAYS && days < bestDays) {
      best = c;
      bestDays = days;
    }
  }
  return best;
}

function detectCardSettlements(db: Db, accounts: OwnAccount[], candidates: TransferCandidate[], used: Set<number>): number {
  let created = 0;
  const cards = accounts.filter((a) => a.role === 'kreditkarte');
  const isCardAccount = (id: number) => cards.some((c) => c.id === id);

  for (const card of cards) {
    // a) Abrechnungen, denen eine Seite fehlt, um die inzwischen importierte ergänzen.
    const open = db
      .prepare(
        `SELECT tr.id, tr.amount_cents, tr.origin, tr.from_account_id,
                (SELECT count(*) FROM transactions t WHERE t.transfer_id = tr.id AND t.account_id = tr.to_account_id) AS card_side,
                (SELECT count(*) FROM transactions t WHERE t.transfer_id = tr.id AND t.account_id <> tr.to_account_id) AS giro_side,
                (SELECT min(booking_date) FROM transactions t WHERE t.transfer_id = tr.id) AS d
           FROM transfers tr WHERE tr.kind = 'card_settlement' AND tr.to_account_id = ?`,
      )
      .all(card.id) as {
      id: number;
      amount_cents: number;
      origin: TransferOrigin;
      from_account_id: number | null;
      card_side: number;
      giro_side: number;
      d: string | null;
    }[];
    for (const s of open) {
      if (s.d === null || (s.card_side > 0 && s.giro_side > 0)) continue;
      const counter =
        s.card_side === 0
          ? nearestCounter(candidates, used, { bookingDate: s.d, amountCents: -s.amount_cents }, (c) =>
              looksLikeCardCredit(c, card, accounts),
            )
          : nearestCounter(
              candidates,
              used,
              { bookingDate: s.d, amountCents: s.amount_cents },
              (c) => !isCardAccount(c.accountId) && (s.from_account_id === null || c.accountId === s.from_account_id),
            );
      if (!counter) continue;
      used.add(counter.id);
      link(db, counter.id, s.id, 'auto');
      if (s.from_account_id === null && counter.amountCents < 0) {
        db.prepare('UPDATE transfers SET from_account_id = ?, updated_at = ? WHERE id = ?').run(counter.accountId, nowIso(), s.id);
      }
    }

    // b) Gutschrift auf dem Kartenkonto (Ausgleich) + Sammelabbuchung vom Girokonto.
    for (const credit of candidates) {
      if (used.has(credit.id) || !looksLikeCardCredit(credit, card, accounts)) continue;
      const debit = nearestCounter(candidates, used, credit, (c) => {
        if (isCardAccount(c.accountId)) return false;
        // Nennt die Abbuchung ein anderes eigenes Konto, ist sie keine Kartenabrechnung.
        const named = ownAccountNamedBy(c, accounts);
        return named === null || named.account.id === card.id;
      });
      used.add(credit.id);
      if (debit) used.add(debit.id);
      const date = debit && debit.bookingDate < credit.bookingDate ? debit.bookingDate : credit.bookingDate;
      const period = computeCardPeriod(db, card.id, credit.amountCents, date, null);
      insertTransfer(
        db,
        {
          kind: 'card_settlement',
          origin: 'auto',
          fromAccountId: debit?.accountId ?? null,
          toAccountId: card.id,
          amountCents: credit.amountCents,
          periodStart: period.start,
          periodEnd: period.end,
          reason: debit
            ? 'Ausgleich auf dem Kartenkonto und Abbuchung mit gleichem Betrag'
            : 'Ausgleich auf dem Kartenkonto; Abbuchung vom Girokonto nicht importiert',
        },
        debit ? [debit.id, credit.id] : [credit.id],
      );
      created += 1;
    }

    // c) Sammelabbuchung ohne importierte Gutschrift: über die IBAN der Karte,
    //    oder Begriffe wie „Visa“ plus genau passende Summe der Kartenumsätze.
    for (const debit of candidates) {
      if (used.has(debit.id) || isCardAccount(debit.accountId)) continue;
      const hint = cardDebitHint(debit, card, accounts);
      if (hint === null) continue;
      const period = computeCardPeriod(db, card.id, -debit.amountCents, debit.bookingDate, null);
      if (hint === 'word' && !period.exact) continue;
      used.add(debit.id);
      insertTransfer(
        db,
        {
          kind: 'card_settlement',
          origin: 'auto',
          fromAccountId: debit.accountId,
          toAccountId: card.id,
          amountCents: -debit.amountCents,
          periodStart: period.start,
          periodEnd: period.end,
          reason:
            hint === 'iban'
              ? `Abbuchung nennt das Kartenkonto „${card.name}“`
              : 'Abbuchung nennt eine Kreditkarte, Betrag = Summe der Kartenumsätze',
        },
        [debit.id],
      );
      created += 1;
    }

    recomputeCardPeriods(db, card.id);
  }
  return created;
}

// ---------------------------------------------------------------------------
// Erkennung
// ---------------------------------------------------------------------------

export interface DetectionResult {
  /** Neu angelegte Umbuchungen. */
  created: number;
  /** Bestehende einseitige Umbuchungen, deren Gegenbuchung jetzt gefunden wurde. */
  completed: number;
}

/**
 * Erkennt Umbuchungen unter allen Buchungen, die nie von Hand eingeordnet
 * wurden: zuerst Kartenabrechnungen, dann Gegenbuchungen zu bestehenden
 * einseitigen Umbuchungen, dann Paare, zuletzt vermutete einseitige.
 * Läuft nach jedem Import; ändert nie eine Kategorie.
 */
export function detectTransfers(db: Db): DetectionResult {
  return db.transaction(() => {
    const accounts = loadAccounts(db);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const candidates = loadCandidates(db);
    const used = new Set<number>();

    let created = detectCardSettlements(db, accounts, candidates, used);

    // Einseitige (automatisch erkannte) Umbuchungen vervollständigen.
    let completed = 0;
    const oneSided = db
      .prepare(
        `SELECT tr.id, tr.from_account_id, tr.to_account_id, tr.detection_reason, t.id AS tx_id, t.account_id, t.booking_date,
                t.amount_cents, t.counterparty_iban
           FROM transfers tr JOIN transactions t ON t.transfer_id = tr.id
          WHERE tr.kind = 'one_sided' AND tr.origin = 'auto'`,
      )
      .all() as {
      id: number;
      from_account_id: number | null;
      to_account_id: number | null;
      detection_reason: string | null;
      tx_id: number;
      account_id: number;
      booking_date: string;
      amount_cents: number;
      counterparty_iban: string | null;
    }[];
    for (const s of oneSided) {
      const known = s.amount_cents < 0 ? s.to_account_id : s.from_account_id;
      const counter = nearestCounter(candidates, used, { bookingDate: s.booking_date, amountCents: s.amount_cents }, (c) => {
        const account = byId.get(c.accountId);
        if (c.accountId === s.account_id || account?.role === 'kreditkarte') return false;
        if (known !== null && c.accountId !== known) return false;
        if (s.counterparty_iban && account?.iban && s.counterparty_iban !== account.iban) return false;
        return true;
      });
      if (!counter) continue;
      used.add(counter.id);
      link(db, counter.id, s.id, 'auto');
      const dir = direction({ account_id: s.account_id, amount_cents: s.amount_cents }, counter.accountId);
      db.prepare(
        `UPDATE transfers SET kind = 'pair', from_account_id = ?, to_account_id = ?, detection_reason = ?, updated_at = ?
          WHERE id = ?`,
      ).run(dir.fromAccountId, dir.toAccountId, `${s.detection_reason ?? ''}; Gegenbuchung gefunden`, nowIso(), s.id);
      completed += 1;
    }

    // Paare 1:1.
    const free = candidates.filter((c) => !used.has(c.id));
    const byTx = new Map(candidates.map((c) => [c.id, c]));
    for (const pair of matchPairs(free, accounts)) {
      const debit = byTx.get(pair.debitId) as TransferCandidate;
      const credit = byTx.get(pair.creditId) as TransferCandidate;
      used.add(debit.id);
      used.add(credit.id);
      insertTransfer(
        db,
        {
          kind: 'pair',
          origin: 'auto',
          fromAccountId: debit.accountId,
          toAccountId: credit.accountId,
          amountCents: credit.amountCents,
          reason: pair.reason,
        },
        [debit.id, credit.id],
      );
      created += 1;
    }

    // Vermutete einseitige Umbuchungen.
    for (const t of candidates) {
      if (used.has(t.id)) continue;
      const match = oneSidedEvidence(t, accounts);
      if (!match) continue;
      used.add(t.id);
      const other = match.otherAccountId !== null ? byId.get(match.otherAccountId) : undefined;
      if (other?.role === 'kreditkarte' && t.amountCents < 0) {
        // Gehört zur Karte, aber ohne Gutschrift: als Kartenabrechnung führen.
        const period = computeCardPeriod(db, other.id, -t.amountCents, t.bookingDate, null);
        insertTransfer(
          db,
          {
            kind: 'card_settlement',
            origin: 'auto',
            fromAccountId: t.accountId,
            toAccountId: other.id,
            amountCents: -t.amountCents,
            periodStart: period.start,
            periodEnd: period.end,
            reason: match.reason,
          },
          [t.id],
        );
      } else {
        insertTransfer(
          db,
          {
            kind: 'one_sided',
            origin: 'auto',
            ...direction({ account_id: t.accountId, amount_cents: t.amountCents }, match.otherAccountId),
            amountCents: Math.abs(t.amountCents),
            reason: match.reason,
          },
          [t.id],
        );
      }
      created += 1;
    }

    return { created, completed };
  })();
}

/**
 * Nach dem Löschen von Buchungen (Import rückgängig): Umbuchungen ohne
 * Buchung verschwinden; automatisch erkannte Paare mit nur noch einer
 * Seite werden aufgelöst (die übrige Buchung ist wieder frei), von Hand
 * angelegte werden einseitig. Danach läuft die Erkennung erneut.
 */
export function repairTransfersAfterDelete(db: Db): void {
  db.transaction(() => {
    db.prepare('DELETE FROM transfers WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.transfer_id = transfers.id)').run();
    const broken = db
      .prepare(
        `SELECT tr.id, tr.origin FROM transfers tr
          WHERE tr.kind = 'pair' AND (SELECT count(*) FROM transactions t WHERE t.transfer_id = tr.id) < 2`,
      )
      .all() as { id: number; origin: TransferOrigin }[];
    for (const b of broken) {
      if (b.origin === 'auto') {
        db.prepare('UPDATE transactions SET transfer_id = NULL, transfer_source = NULL WHERE transfer_id = ?').run(b.id);
        db.prepare('DELETE FROM transfers WHERE id = ?').run(b.id);
      } else {
        db.prepare("UPDATE transfers SET kind = 'one_sided', updated_at = ? WHERE id = ?").run(nowIso(), b.id);
      }
    }
    detectTransfers(db);
  })();
}

// ---------------------------------------------------------------------------
// Übersicht
// ---------------------------------------------------------------------------

function cardCheck(db: Db, row: TransferRow): CardCheck | null {
  if (row.kind !== 'card_settlement' || row.to_account_id === null || !row.period_start || !row.period_end) return null;
  const sums = db
    .prepare(
      `SELECT count(*) AS n, coalesce(-sum(amount_cents), 0) AS cents FROM transactions
        WHERE account_id = ? AND transfer_id IS NULL AND booking_date BETWEEN ? AND ?`,
    )
    .get(row.to_account_id, row.period_start, row.period_end) as { n: number; cents: number };
  return { purchaseCount: sums.n, purchasesCents: sums.cents, differenceCents: row.amount_cents - sums.cents };
}

function toTransfer(db: Db, row: TransferRow, names: Map<number, string>): Transfer {
  const txs = linkedTransactions(db, row.id);
  const accountIds = new Set(txs.map((t) => t.account_id));
  const counterMissing =
    row.kind === 'one_sided' ||
    (row.kind === 'card_settlement' &&
      !(row.to_account_id !== null && accountIds.has(row.to_account_id) && [...accountIds].some((id) => id !== row.to_account_id)));
  return {
    id: row.id,
    kind: row.kind,
    origin: row.origin,
    status: row.status,
    fromAccountId: row.from_account_id,
    fromAccountName: row.from_account_id === null ? null : (names.get(row.from_account_id) ?? null),
    toAccountId: row.to_account_id,
    toAccountName: row.to_account_id === null ? null : (names.get(row.to_account_id) ?? null),
    amountCents: row.amount_cents,
    date: txs[0]?.booking_date ?? null,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    reason: row.detection_reason,
    transactions: txs.map((t) => ({
      id: t.id,
      accountId: t.account_id,
      accountName: t.account_name,
      bookingDate: t.booking_date,
      amountCents: t.amount_cents,
      counterparty: t.counterparty,
      purpose: t.purpose,
    })),
    counterMissing,
    card: cardCheck(db, row),
  };
}

export interface TransferFilter {
  status?: TransferStatus | undefined;
  accountId?: number | undefined;
}

/** Alle Umbuchungen, neueste zuerst – damit Fehlerkennungen auffallen (§ 10). */
export function listTransfers(db: Db, filter: TransferFilter = {}): Transfer[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.accountId !== undefined) {
    where.push('(from_account_id = ? OR to_account_id = ? OR EXISTS (SELECT 1 FROM transactions t WHERE t.transfer_id = transfers.id AND t.account_id = ?))');
    params.push(filter.accountId, filter.accountId, filter.accountId);
  }
  const rows = db
    .prepare(`SELECT * FROM transfers ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}`)
    .all(...params) as TransferRow[];
  const names = new Map((db.prepare('SELECT id, name FROM accounts').all() as { id: number; name: string }[]).map((a) => [a.id, a.name]));
  return rows
    .map((r) => toTransfer(db, r, names))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.id - a.id);
}

export function getTransfer(db: Db, id: number): Transfer {
  const row = db.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as TransferRow | undefined;
  if (!row) throw new AppError(`Umbuchung ${id} existiert nicht.`, 404);
  const names = new Map((db.prepare('SELECT id, name FROM accounts').all() as { id: number; name: string }[]).map((a) => [a.id, a.name]));
  return toTransfer(db, row, names);
}

// ---------------------------------------------------------------------------
// Von Hand
// ---------------------------------------------------------------------------

/** Erkannte Umbuchung bestätigen. */
export function confirmTransfer(db: Db, id: number): Transfer {
  getTransfer(db, id);
  db.prepare("UPDATE transfers SET status = 'confirmed', updated_at = ? WHERE id = ?").run(nowIso(), id);
  return getTransfer(db, id);
}

/**
 * Umbuchung aufheben (Fehlerkennung): alle ihre Buchungen gelten wieder
 * als Einnahme bzw. Ausgabe und sind als „keine Umbuchung“ markiert,
 * damit die Erkennung sie nicht erneut vorschlägt.
 */
export function dissolveTransfer(db: Db, id: number): { released: number } {
  getTransfer(db, id);
  return db.transaction(() => {
    const released = db
      .prepare("UPDATE transactions SET transfer_id = NULL, transfer_source = 'manual' WHERE transfer_id = ?")
      .run(id).changes;
    db.prepare('DELETE FROM transfers WHERE id = ?').run(id);
    return { released };
  })();
}

/**
 * Löst eine Buchung aus ihrer Umbuchung (ihre eigene Herkunft setzt der
 * Aufrufer). Bei automatisch erkannten Umbuchungen werden die übrigen
 * Buchungen frei – die Erkennung darf sie neu einordnen – und die
 * Umbuchung verschwindet. Von Hand angelegte bleiben mit der übrigen Seite
 * bestehen (ein Paar wird einseitig).
 */
function detach(db: Db, txId: number, transferId: number): void {
  db.prepare('UPDATE transactions SET transfer_id = NULL WHERE id = ?').run(txId);
  const row = db.prepare('SELECT kind, origin FROM transfers WHERE id = ?').get(transferId) as
    | { kind: TransferKind; origin: TransferOrigin }
    | undefined;
  if (!row) return;
  const rest = (db.prepare('SELECT count(*) AS n FROM transactions WHERE transfer_id = ?').get(transferId) as { n: number }).n;
  if (rest === 0 || row.origin === 'auto') {
    db.prepare('UPDATE transactions SET transfer_id = NULL, transfer_source = NULL WHERE transfer_id = ?').run(transferId);
    db.prepare('DELETE FROM transfers WHERE id = ?').run(transferId);
  } else if (row.kind === 'pair') {
    db.prepare("UPDATE transfers SET kind = 'one_sided', updated_at = ? WHERE id = ?").run(nowIso(), transferId);
  }
}

export interface MarkInput {
  /** Gegenkonto, falls bekannt; bei Kreditkarte entsteht eine Kartenabrechnung. */
  accountId: number | null;
}

/**
 * Buchung von Hand als Umbuchung markieren (§ 10). Mit Gegenkonto sucht
 * die App dort die Gegenbuchung (gleicher Betrag, umgekehrtes Vorzeichen,
 * wenige Tage) und legt ein Paar an; ohne Treffer bleibt sie einseitig.
 * Ist das Gegenkonto eine Kreditkarte, entsteht eine Kartenabrechnung.
 */
export function markTransfer(db: Db, txId: number, input: MarkInput): Transfer {
  return db.transaction(() => {
    const tx = loadTx(db, txId);
    if (tx.amount_cents === 0) throw new AppError('Eine Buchung über 0,00 € kann keine Umbuchung sein.');
    const accounts = loadAccounts(db);
    const own = accounts.find((a) => a.id === tx.account_id) as OwnAccount;
    const other = input.accountId === null ? null : accounts.find((a) => a.id === input.accountId);
    if (input.accountId !== null && !other) throw new AppError(`Konto ${input.accountId} existiert nicht.`, 404);
    if (other && other.id === tx.account_id) throw new AppError('Gegenkonto und Konto der Buchung sind dasselbe.');

    if (tx.transfer_id !== null) detach(db, tx.id, tx.transfer_id);

    const candidates = loadCandidates(db).filter((c) => c.id !== tx.id);
    const self = { bookingDate: tx.booking_date, amountCents: tx.amount_cents };
    const amount = Math.abs(tx.amount_cents);

    // Kartenabrechnung: Abbuchung → Karte, oder Ausgleich auf der Karte ← Girokonto.
    const card = other?.role === 'kreditkarte' && tx.amount_cents < 0 ? other : own.role === 'kreditkarte' && tx.amount_cents > 0 ? own : null;
    if (card) {
      const counterAccountId = card === own ? (other?.id ?? null) : card.id;
      const counter =
        counterAccountId === null ? null : nearestCounter(candidates, new Set(), self, (c) => c.accountId === counterAccountId);
      const giroAccountId = card === own ? (counter?.accountId ?? other?.id ?? null) : own.id;
      const date = counter && counter.bookingDate < tx.booking_date ? counter.bookingDate : tx.booking_date;
      const period = computeCardPeriod(db, card.id, amount, date, null);
      const id = insertTransfer(
        db,
        {
          kind: 'card_settlement',
          origin: 'manual',
          fromAccountId: giroAccountId,
          toAccountId: card.id,
          amountCents: amount,
          periodStart: period.start,
          periodEnd: period.end,
          reason: 'von Hand',
        },
        counter ? [tx.id, counter.id] : [tx.id],
      );
      return getTransfer(db, id);
    }

    const otherId = other?.id ?? null;
    const counter = otherId === null ? null : nearestCounter(candidates, new Set(), self, (c) => c.accountId === otherId);
    const id = insertTransfer(
      db,
      {
        kind: counter ? 'pair' : 'one_sided',
        origin: 'manual',
        ...direction(tx, otherId),
        amountCents: amount,
        reason: counter ? 'von Hand, Gegenbuchung gefunden' : 'von Hand',
      },
      counter ? [tx.id, counter.id] : [tx.id],
    );
    return getTransfer(db, id);
  })();
}

/**
 * „Keine Umbuchung“: die Buchung zählt wieder als Einnahme bzw. Ausgabe,
 * und die Erkennung lässt sie künftig in Ruhe. Eine Gegenbuchung wird frei.
 */
export function unmarkTransfer(db: Db, txId: number): void {
  db.transaction(() => {
    const tx = loadTx(db, txId);
    if (tx.transfer_id !== null) detach(db, tx.id, tx.transfer_id);
    db.prepare("UPDATE transactions SET transfer_id = NULL, transfer_source = 'manual' WHERE id = ?").run(tx.id);
  })();
}

/**
 * Handarbeit aufheben: die Buchung ist wieder unberührt, und die Erkennung
 * darf sie sofort neu einordnen.
 */
export function resetTransfer(db: Db, txId: number): DetectionResult {
  return db.transaction(() => {
    const tx = loadTx(db, txId);
    if (tx.transfer_id !== null) detach(db, tx.id, tx.transfer_id);
    db.prepare('UPDATE transactions SET transfer_id = NULL, transfer_source = NULL WHERE id = ?').run(tx.id);
    return detectTransfers(db);
  })();
}
