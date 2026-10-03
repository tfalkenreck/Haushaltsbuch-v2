import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './connection.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

const FILE_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/;

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
}

/**
 * Prüfsumme über den Inhalt mit vereinheitlichten Zeilenenden – ein
 * Checkout mit CRLF unter Windows zählt nicht als Änderung.
 */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Liest alle Migrationen aus einem Ordner, aufsteigend nach Nummer. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations: Migration[] = [];

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.sql')) continue;
    const match = FILE_PATTERN.exec(file);
    if (!match?.[1]) {
      throw new Error(`Ungültiger Migrationsdateiname: ${file} (erwartet z. B. 003_beschreibung.sql)`);
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    migrations.push({ version: Number(match[1]), name: file, sql, checksum: migrationChecksum(sql) });
  }

  migrations.sort((a, b) => a.version - b.version);

  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`Migrationen müssen lückenlos ab 001 nummeriert sein; ${m.name} hat Nummer ${m.version}, erwartet ${i + 1}`);
    }
  });

  return migrations;
}

/**
 * Wendet alle noch nicht angewendeten Migrationen an, jede in einer eigenen
 * Transaktion. Angewendete Migrationen stehen mit Prüfsumme in
 * schema_migrations; wurde eine davon nachträglich geändert, bricht der
 * Runner ab (bestehende Migrationen werden NIE geändert).
 */
export function migrate(db: Db, migrations: Migration[] = loadMigrations()): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      checksum   TEXT    NOT NULL,
      applied_at TEXT    NOT NULL
    ) STRICT
  `);

  const appliedRows = db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as { version: number; name: string; checksum: string }[];
  const applied = new Map(appliedRows.map((row) => [row.version, row]));

  for (const row of appliedRows) {
    const file = migrations.find((m) => m.version === row.version);
    if (!file) {
      throw new Error(`Migration ${row.name} ist in der Datenbank angewendet, aber die Datei fehlt`);
    }
    if (file.checksum !== row.checksum) {
      throw new Error(`Migration ${row.name} wurde nach dem Anwenden geändert – stattdessen eine neue Migration anlegen`);
    }
  }

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  );
  const result: MigrationResult = { applied: [] };

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    })();
    result.applied.push(migration.name);
  }

  // Fremdschlüssel nach allen Migrationen prüfen (Tabellen-Umbauten in
  // späteren Migrationen dürfen keine verwaisten Verweise hinterlassen).
  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(`Fremdschlüsselverletzungen nach der Migration: ${JSON.stringify(violations)}`);
  }

  return result;
}
