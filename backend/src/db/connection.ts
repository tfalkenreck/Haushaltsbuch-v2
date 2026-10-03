import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** Repository-Wurzel – gleich tief unter src/db/ und dist/db/. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const DEFAULT_DB_PATH = resolve(REPO_ROOT, 'data', 'haushaltsbuch.db');

/**
 * Pfad zur Datenbank: Umgebungsvariable HAUSHALTSBUCH_DB (relativ zur
 * Repository-Wurzel oder absolut, ':memory:' erlaubt), sonst
 * data/haushaltsbuch.db.
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['HAUSHALTSBUCH_DB']?.trim();
  if (!fromEnv) return DEFAULT_DB_PATH;
  if (fromEnv === ':memory:' || isAbsolute(fromEnv)) return fromEnv;
  return resolve(REPO_ROOT, fromEnv);
}

/**
 * Öffnet eine Verbindung mit den Pflicht-Pragmas aus CLAUDE.md § 7.
 * Legt den Ordner der DB-Datei bei Bedarf an.
 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  return db;
}
