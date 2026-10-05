import type { Db } from '../db/connection.js';
import { AppError } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';

/**
 * Export aller Daten als JSON und Re-Import auf einem neuen Rechner
 * (CLAUDE.md § 16). Das Format ist bewusst schlicht und offen: je Tabelle
 * die Zeilen, wie sie in der Datenbank stehen (Spaltennamen in
 * snake_case, Geld in Cent, Datum als ISO-Text). Damit bleibt jede Zahl
 * exakt, und ein Re-Import ergibt dieselbe Datenbank.
 *
 * Re-Import nur in eine leere Datenbank mit demselben Schema-Stand – so
 * kann nichts vermischt oder halb übernommen werden.
 */

export const EXPORT_FORMAT = 'haushaltsbuch-export';
export const EXPORT_VERSION = 1;

/** Verwaltungstabellen, die nicht zu den Daten gehören. */
const NOT_DATA = new Set(['schema_migrations', 'app_state']);

/** Gehören einer frischen Datenbank (Seed aus Migration 002) und werden beim Re-Import ersetzt. */
const REPLACEABLE = new Set(['categories']);

const LAST_EXPORT_KEY = 'last_export_at';

export type Row = Record<string, string | number | null>;

export interface DataExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  /** Zeitpunkt des Exports, ISO-8601 mit Uhrzeit. */
  exportedAt: string;
  /** Höchste angewendete Migration. */
  schemaVersion: number;
  tables: Record<string, Row[]>;
}

export interface ExportStatus {
  lastExportAt: string | null;
  /** Die Datenbank enthält noch keine Daten – nur dann ist ein Re-Import möglich. */
  empty: boolean;
}

/** Datentabellen in fester Reihenfolge. */
export function dataTables(db: Db): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
      name: string;
    }[]
  )
    .map((t) => t.name)
    .filter((name) => !NOT_DATA.has(name));
}

function schemaVersion(db: Db): number {
  return (db.prepare('SELECT coalesce(max(version), 0) AS v FROM schema_migrations').get() as { v: number }).v;
}

function columnsOf(db: Db, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name));
}

export function lastExportAt(db: Db): string | null {
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(LAST_EXPORT_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

function recordExport(db: Db, at: string): void {
  db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(LAST_EXPORT_KEY, at, nowIso());
}

/** Leer = keine Daten außer den mitgelieferten Kategorien. */
function isEmpty(db: Db): boolean {
  return dataTables(db)
    .filter((t) => !REPLACEABLE.has(t))
    .every((t) => !db.prepare(`SELECT 1 FROM "${t}" LIMIT 1`).get());
}

export function exportStatus(db: Db): ExportStatus {
  return { lastExportAt: lastExportAt(db), empty: isEmpty(db) };
}

/** Alle Daten als JSON-Objekt; merkt sich den Zeitpunkt für den Hinweis auf der Übersicht. */
export function exportData(db: Db, now: string = nowIso()): DataExport {
  return db.transaction((): DataExport => {
    const tables: Record<string, Row[]> = {};
    for (const table of dataTables(db)) {
      tables[table] = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Row[];
    }
    recordExport(db, now);
    return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: now, schemaVersion: schemaVersion(db), tables };
  })();
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Prüft Aufbau und Herkunft einer Exportdatei. */
function validate(db: Db, data: unknown): DataExport {
  if (!isRecord(data) || data['format'] !== EXPORT_FORMAT) {
    throw new AppError('Das ist keine Exportdatei des Haushaltsbuchs.');
  }
  if (data['version'] !== EXPORT_VERSION) {
    throw new AppError(`Exportformat ${String(data['version'])} wird nicht unterstützt (erwartet ${EXPORT_VERSION}).`);
  }
  const current = schemaVersion(db);
  if (data['schemaVersion'] !== current) {
    throw new AppError(
      `Die Datei stammt aus einem anderen Programmstand (Datenbank-Version ${String(data['schemaVersion'])}, hier ${current}). ` +
        'Beide Rechner auf denselben Stand bringen („Haushaltsbuch aktualisieren.cmd“) und erneut exportieren bzw. importieren.',
    );
  }
  if (typeof data['exportedAt'] !== 'string' || !isRecord(data['tables'])) throw new AppError('Die Exportdatei ist unvollständig.');

  const tables = data['tables'];
  const known = dataTables(db);
  for (const name of Object.keys(tables)) {
    if (!known.includes(name)) throw new AppError(`Unbekannte Tabelle „${name}“ in der Exportdatei.`);
  }
  for (const name of known) {
    const rows = tables[name];
    if (!Array.isArray(rows)) throw new AppError(`Tabelle „${name}“ fehlt in der Exportdatei.`);
    const columns = columnsOf(db, name);
    for (const row of rows) {
      if (!isRecord(row)) throw new AppError(`Ungültige Zeile in Tabelle „${name}“.`);
      for (const [column, value] of Object.entries(row)) {
        if (!columns.has(column)) throw new AppError(`Unbekannte Spalte „${column}“ in Tabelle „${name}“.`);
        if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
          throw new AppError(`Ungültiger Wert in „${name}.${column}“.`);
        }
      }
    }
  }
  return data as unknown as DataExport;
}

export interface ImportResult {
  /** Übernommene Zeilen je Tabelle. */
  rows: Record<string, number>;
}

/**
 * Übernimmt eine Exportdatei in eine leere Datenbank – alles oder nichts
 * (eine Transaktion). Die mitgelieferten Kategorien einer frischen
 * Datenbank werden durch die aus der Datei ersetzt. Fremdschlüssel werden
 * erst am Ende geprüft, die Reihenfolge der Tabellen spielt keine Rolle.
 */
export function importData(db: Db, input: unknown): ImportResult {
  const data = validate(db, input);
  if (!isEmpty(db)) {
    throw new AppError(
      'Der Re-Import ist nur in eine leere Datenbank möglich – hier sind schon Konten oder Buchungen. ' +
        'Auf dem neuen Rechner direkt nach der Einrichtung importieren.',
      409,
    );
  }
  return db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    for (const table of REPLACEABLE) db.prepare(`DELETE FROM "${table}"`).run();
    const rows: Record<string, number> = {};
    for (const table of dataTables(db)) {
      const list = data.tables[table] ?? [];
      for (const row of list) {
        const columns = Object.keys(row);
        if (columns.length === 0) continue;
        try {
          db.prepare(`INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
            ...columns.map((c) => row[c] ?? null),
          );
        } catch (err) {
          // STRICT-Tabellen und CHECKs lehnen z. B. Kommabeträge in Cent-Spalten ab.
          throw new AppError(`Ungültige Zeile in Tabelle „${table}“: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      rows[table] = list.length;
    }
    const violations = db.pragma('foreign_key_check') as { table: string }[];
    if (violations.length > 0) {
      throw new AppError(`Die Exportdatei ist nicht stimmig: ${violations.length} Verweis(e) ins Leere (z. B. in „${violations[0]?.table}“).`);
    }
    // Der Stand der Datei ist gesichert – so alt ist der letzte Export.
    recordExport(db, data.exportedAt);
    return { rows };
  })();
}
