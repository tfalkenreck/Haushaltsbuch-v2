import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection.js';
import { loadMigrations, migrate, migrationChecksum, type Migration } from '../src/db/migrate.js';

function migration(version: number, sql: string): Migration {
  const name = `${String(version).padStart(3, '0')}_test.sql`;
  return { version, name, sql, checksum: migrationChecksum(sql) };
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hhb-migrate-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Migrationsrunner', () => {
  it('wendet die echten Migrationen an und merkt sich jede', () => {
    const db = openDatabase(':memory:');
    const { applied } = migrate(db);

    expect(applied).toEqual(['001_initial.sql', '002_seed_categories.sql']);
    const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    expect(rows).toEqual([
      { version: 1, name: '001_initial.sql' },
      { version: 2, name: '002_seed_categories.sql' },
    ]);
  });

  it('ist beim zweiten Lauf ein No-op', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    expect(migrate(db).applied).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM categories').get()).toEqual({ n: 19 });
  });

  it('wendet nur neue Migrationen an', () => {
    const db = openDatabase(':memory:');
    const first = migration(1, 'CREATE TABLE a (x INTEGER) STRICT;');
    migrate(db, [first]);

    const result = migrate(db, [first, migration(2, 'CREATE TABLE b (y INTEGER) STRICT;')]);
    expect(result.applied).toEqual(['002_test.sql']);
  });

  it('bricht ab, wenn eine angewendete Migration geändert wurde', () => {
    const db = openDatabase(':memory:');
    migrate(db, [migration(1, 'CREATE TABLE a (x INTEGER) STRICT;')]);

    expect(() => migrate(db, [migration(1, 'CREATE TABLE a (x INTEGER, z TEXT) STRICT;')])).toThrow(
      /001_test\.sql wurde nach dem Anwenden geändert/,
    );
  });

  it('wertet CRLF-Zeilenenden nicht als Änderung', () => {
    const db = openDatabase(':memory:');
    migrate(db, [migration(1, 'CREATE TABLE a (\n  x INTEGER\n) STRICT;\n')]);

    expect(migrate(db, [migration(1, 'CREATE TABLE a (\r\n  x INTEGER\r\n) STRICT;\r\n')]).applied).toEqual([]);
  });

  it('bricht ab, wenn die Datei einer angewendeten Migration fehlt', () => {
    const db = openDatabase(':memory:');
    migrate(db, [migration(1, 'CREATE TABLE a (x INTEGER) STRICT;')]);

    expect(() => migrate(db, [])).toThrow(/Datei fehlt/);
  });

  it('rollt eine fehlerhafte Migration vollständig zurück', () => {
    const db = openDatabase(':memory:');
    const broken = migration(1, 'CREATE TABLE a (x INTEGER) STRICT; INSERT INTO gibt_es_nicht VALUES (1);');

    expect(() => migrate(db, [broken])).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get()).toBeUndefined();
    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 0 });
  });

  it('liest Migrationsdateien sortiert und verlangt lückenlose Nummern', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '002_zwei.sql'), 'SELECT 2;');
    writeFileSync(join(dir, '001_eins.sql'), 'SELECT 1;');
    writeFileSync(join(dir, 'README.txt'), 'ignoriert');
    expect(loadMigrations(dir).map((m) => m.name)).toEqual(['001_eins.sql', '002_zwei.sql']);

    writeFileSync(join(dir, '004_vier.sql'), 'SELECT 4;');
    expect(() => loadMigrations(dir)).toThrow(/lückenlos/);
  });

  it('lehnt falsch benannte Migrationsdateien ab', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '1-initial.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(/Ungültiger Migrationsdateiname/);
  });

  it('setzt die Pflicht-Pragmas pro Verbindung', () => {
    const dir = tempDir();
    const db = openDatabase(join(dir, 'unterordner', 'test.db'));
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
  });
});
