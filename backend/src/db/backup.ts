import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from './connection.js';
import { loadMigrations, pendingMigrations, type Migration } from './migrate.js';

/**
 * Automatische Sicherung vor Migrationen (CLAUDE.md § 16, Phase 8): Bevor
 * ein Update die Datenbank umstellt, wird sie per SQLite-Backup-API nach
 * `data/backups/` kopiert – konsistent auch bei WAL. Die letzten
 * `BACKUPS_KEPT` Sicherungen bleiben, ältere werden gelöscht.
 */

export const BACKUPS_KEPT = 10;

/** `haushaltsbuch-2026-10-05_183012-vor-008.db` – lexikalisch = zeitlich sortiert. */
const BACKUP_FILE = /^haushaltsbuch-\d{4}-\d{2}-\d{2}_\d{6}-vor-\d{3}\.db$/;

/** Ordner der Sicherungen neben der Datenbank (`data/backups`). */
export function backupDir(dbPath: string): string {
  return join(dirname(dbPath), 'backups');
}

/** Lokale Zeit als `2026-10-05_183012`. */
function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Löscht alle Sicherungen außer den `keep` neuesten; liefert die gelöschten Dateinamen. */
export function pruneBackups(dir: string, keep: number = BACKUPS_KEPT): string[] {
  const files = readdirSync(dir)
    .filter((f) => BACKUP_FILE.test(f))
    .sort()
    .reverse();
  const removed = files.slice(keep);
  for (const file of removed) rmSync(join(dir, file));
  return removed;
}

/**
 * Sichert die Datenbank, wenn Migrationen ausstehen und schon welche
 * angewendet sind (eine frische, leere Datenbank braucht keine Sicherung).
 * Liefert den Pfad der Sicherung oder `null`.
 */
export async function backupBeforeMigrations(
  db: Db,
  dbPath: string,
  now: Date = new Date(),
  migrations: Migration[] = loadMigrations(),
): Promise<string | null> {
  if (dbPath === ':memory:') return null;
  const { pending, appliedCount } = pendingMigrations(db, migrations);
  const first = pending[0];
  if (!first || appliedCount === 0) return null;

  const dir = backupDir(dbPath);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `haushaltsbuch-${stamp(now)}-vor-${String(first.version).padStart(3, '0')}.db`);
  await db.backup(target);
  pruneBackups(dir);
  return target;
}
