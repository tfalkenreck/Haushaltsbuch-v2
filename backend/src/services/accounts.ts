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
}

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
    .prepare('SELECT * FROM accounts ORDER BY active DESC, name COLLATE NOCASE, id')
    .all() as AccountRow[];
  return rows.map(toAccount);
}

export function getAccount(db: Db, id: number): Account {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
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
