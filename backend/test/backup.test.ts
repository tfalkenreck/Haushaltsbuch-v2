import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupBeforeMigrations, backupDir, BACKUPS_KEPT, pruneBackups } from '../src/db/backup.js';
import { openDatabase, type Db } from '../src/db/connection.js';
import { loadMigrations, migrate, pendingMigrations } from '../src/db/migrate.js';

let dir: string;
let dbPath: string;
const open: Db[] = [];

function openDb(path: string): Db {
  const db = openDatabase(path);
  open.push(db);
  return db;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'haushaltsbuch-backup-'));
  dbPath = join(dir, 'haushaltsbuch.db');
});

afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date(2026, 9, 5, 18, 30, 12);
const all = loadMigrations();

describe('Sicherung vor Migrationen', () => {
  it('sichert eine bestehende Datenbank, bevor ausstehende Migrationen laufen', async () => {
    const db = openDb(dbPath);
    migrate(db, all.slice(0, 7));
    db.prepare(
      "INSERT INTO accounts (name, role, bank_adapter, created_at, updated_at) VALUES ('Giro', 'einnahmen', 'volksbank-owl', 'x', 'x')",
    ).run();
    expect(pendingMigrations(db, all)).toMatchObject({ appliedCount: 7, pending: [{ version: 8 }, { version: 9 }] });

    const backup = await backupBeforeMigrations(db, dbPath, NOW, all);
    expect(backup).toBe(join(backupDir(dbPath), 'haushaltsbuch-2026-10-05_183012-vor-008.db'));
    migrate(db, all);

    // Die Sicherung ist der Stand vor der Umstellung – vollständig, mit Daten.
    const copy = openDb(backup as string);
    expect(copy.prepare('SELECT max(version) AS v FROM schema_migrations').get()).toEqual({ v: 7 });
    expect(copy.prepare('SELECT name FROM accounts').all()).toEqual([{ name: 'Giro' }]);
    expect(copy.prepare("SELECT 1 FROM sqlite_master WHERE name = 'app_state'").get()).toBeUndefined();
  });

  it('sichert nichts, wenn nichts aussteht oder die Datenbank neu ist', async () => {
    const fresh = openDb(dbPath);
    expect(await backupBeforeMigrations(fresh, dbPath, NOW, all)).toBeNull();
    migrate(fresh, all);
    expect(await backupBeforeMigrations(fresh, dbPath, NOW, all)).toBeNull();
    expect(await backupBeforeMigrations(openDb(':memory:'), ':memory:', NOW, all)).toBeNull();
  });

  it(`behält die letzten ${BACKUPS_KEPT} Sicherungen`, async () => {
    const backups = backupDir(dbPath);
    const db = openDb(dbPath);
    migrate(db, all.slice(0, 8));
    await backupBeforeMigrations(db, dbPath, NOW, all);
    for (let day = 10; day <= 21; day++) writeFileSync(join(backups, `haushaltsbuch-2026-09-${day}_120000-vor-007.db`), '');
    writeFileSync(join(backups, 'eigene-kopie.db'), '');

    expect(pruneBackups(backups)).toHaveLength(3);
    const left = readdirSync(backups).sort();
    expect(left).toHaveLength(BACKUPS_KEPT + 1);
    // Die neueste (Oktober) bleibt, fremde Dateien bleiben unberührt.
    expect(left).toContain('haushaltsbuch-2026-10-05_183012-vor-009.db');
    expect(left).toContain('eigene-kopie.db');
    expect(left).not.toContain('haushaltsbuch-2026-09-10_120000-vor-007.db');
  });
});
