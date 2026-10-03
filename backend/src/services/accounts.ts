import { isBankAdapterId } from '../adapters/registry.js';
import type { Db } from '../db/connection.js';
import { AppError } from '../lib/errors.js';
import { isValidIban, normalizeIban } from '../lib/iban.js';
import { nowIso } from '../lib/time.js';

export const ACCOUNT_ROLES = ['einnahmen', 'ausgaben', 'sparen', 'kreditkarte'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export interface Account {
  id: number;
  name: string;
  role: AccountRole;
  bankAdapter: string;
  iban: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  /** Kontostand laut jüngstem Import, der einen nennt. */
  balanceCents: number | null;
  balanceDate: string | null;
  /** Von Importen abgedeckter Zeitraum (frühester Beginn bis spätestes Ende). */
  coverageStart: string | null;
  coverageEnd: string | null;
  transactionCount: number;
  /** Importe mit Kartenumsätzen ohne Buchungstag der Bank (vor Migration 004). */
  needsReimport: boolean;
}

export interface AccountInput {
  name: string;
  role: string;
  bankAdapter: string;
  iban?: string | null;
}

export interface AccountPatch {
  name?: string;
  role?: string;
  bankAdapter?: string;
  iban?: string | null;
  active?: boolean;
}

interface AccountRow {
  id: number;
  name: string;
  role: AccountRole;
  bank_adapter: string;
  iban: string | null;
  active: number;
  created_at: string;
  updated_at: string;
  balance_cents: number | null;
  balance_date: string | null;
  coverage_start: string | null;
  coverage_end: string | null;
  transaction_count: number;
  needs_reimport: number;
}

/** Konto plus Kennzahlen für die Übersicht (Saldo, Abdeckung, Anzahl Buchungen). */
const ACCOUNT_SELECT = `
  SELECT a.*,
         lb.balance_cents, lb.balance_date,
         (SELECT min(period_start) FROM import_batches b WHERE b.account_id = a.id) AS coverage_start,
         (SELECT max(period_end) FROM import_batches b WHERE b.account_id = a.id) AS coverage_end,
         (SELECT count(*) FROM transactions t WHERE t.account_id = a.id) AS transaction_count,
         EXISTS (SELECT 1 FROM transactions t
                  WHERE t.account_id = a.id AND t.bank_booking_date IS NULL) AS needs_reimport
    FROM accounts a
    LEFT JOIN import_batches lb ON lb.id = (
      SELECT b.id FROM import_batches b
       WHERE b.account_id = a.id AND b.balance_cents IS NOT NULL
       ORDER BY b.balance_date DESC, b.id DESC LIMIT 1
    )`;

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    bankAdapter: row.bank_adapter,
    iban: row.iban,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    balanceCents: row.balance_cents,
    balanceDate: row.balance_date,
    coverageStart: row.coverage_start,
    coverageEnd: row.coverage_end,
    transactionCount: row.transaction_count,
    needsReimport: row.needs_reimport === 1,
  };
}

function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new AppError('Der Kontoname darf nicht leer sein.');
  if (trimmed.length > 100) throw new AppError('Der Kontoname darf höchstens 100 Zeichen lang sein.');
  return trimmed;
}

function validateRole(role: string): AccountRole {
  if (!(ACCOUNT_ROLES as readonly string[]).includes(role)) {
    throw new AppError(`Unbekannte Rolle „${role}“. Erlaubt: ${ACCOUNT_ROLES.join(', ')}.`);
  }
  return role as AccountRole;
}

function validateBankAdapter(id: string): string {
  if (!isBankAdapterId(id)) throw new AppError(`Unbekannter Bank-Adapter „${id}“.`);
  return id;
}

/** Leere Eingabe = keine IBAN. Sonst normalisieren und prüfen. */
function validateIban(iban: string | null | undefined): string | null {
  if (iban == null) return null;
  const normalized = normalizeIban(iban);
  if (normalized.length === 0) return null;
  if (!isValidIban(normalized)) throw new AppError(`„${iban}“ ist keine gültige IBAN.`);
  return normalized;
}

function assertIbanFree(db: Db, iban: string | null, ownId?: number): void {
  if (iban === null) return;
  const other = db
    .prepare('SELECT id, name FROM accounts WHERE iban = ? AND id IS NOT ?')
    .get(iban, ownId ?? null) as { id: number; name: string } | undefined;
  if (other) {
    throw new AppError(`Die IBAN ist bereits dem Konto „${other.name}“ zugeordnet.`, 409);
  }
}

export function listAccounts(db: Db): Account[] {
  const rows = db
    .prepare(`${ACCOUNT_SELECT} ORDER BY a.active DESC, a.name COLLATE NOCASE, a.id`)
    .all() as AccountRow[];
  return rows.map(toAccount);
}

export function getAccount(db: Db, id: number): Account {
  const row = db.prepare(`${ACCOUNT_SELECT} WHERE a.id = ?`).get(id) as AccountRow | undefined;
  if (!row) throw new AppError(`Konto ${id} existiert nicht.`, 404);
  return toAccount(row);
}

export function createAccount(db: Db, input: AccountInput): Account {
  const name = validateName(input.name);
  const role = validateRole(input.role);
  const bankAdapter = validateBankAdapter(input.bankAdapter);
  const iban = validateIban(input.iban);
  assertIbanFree(db, iban);

  const now = nowIso();
  const result = db
    .prepare(
      `INSERT INTO accounts (name, role, bank_adapter, iban, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(name, role, bankAdapter, iban, now, now);
  return getAccount(db, Number(result.lastInsertRowid));
}

/**
 * Ändert einzelne Felder. Name, Rolle, Adapter und IBAN sind jederzeit
 * änderbar; Löschen gibt es nicht, nur Deaktivieren (`active: false`).
 */
export function updateAccount(db: Db, id: number, patch: AccountPatch): Account {
  const current = getAccount(db, id);

  const next = {
    name: patch.name !== undefined ? validateName(patch.name) : current.name,
    role: patch.role !== undefined ? validateRole(patch.role) : current.role,
    bankAdapter: patch.bankAdapter !== undefined ? validateBankAdapter(patch.bankAdapter) : current.bankAdapter,
    iban: patch.iban !== undefined ? validateIban(patch.iban) : current.iban,
    active: patch.active ?? current.active,
  };
  assertIbanFree(db, next.iban, id);

  db.prepare(
    `UPDATE accounts
        SET name = ?, role = ?, bank_adapter = ?, iban = ?, active = ?, updated_at = ?
      WHERE id = ?`,
  ).run(next.name, next.role, next.bankAdapter, next.iban, next.active ? 1 : 0, nowIso(), id);

  return getAccount(db, id);
}
