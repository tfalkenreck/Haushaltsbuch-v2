import type { CsvRow } from '../lib/csv.js';

function clean(field: string): string {
  return field.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Sucht die Kopfzeile: die erste Zeile, die alle Pflichtspalten enthält
 * (Groß-/Kleinschreibung und Leerraum egal). Liefert Index der Zeile und
 * eine Zuordnung Spaltenname → Feldindex, oder `null`.
 */
export function findHeader(
  rows: CsvRow[],
  required: readonly string[],
): { index: number; columns: Map<string, number> } | null {
  const wanted = required.map(clean);
  for (let index = 0; index < rows.length; index++) {
    const fields = (rows[index] as CsvRow).fields.map(clean);
    if (wanted.every((name) => fields.includes(name))) {
      const columns = new Map<string, number>();
      fields.forEach((name, i) => {
        if (name !== '' && !columns.has(name)) columns.set(name, i);
      });
      return { index, columns };
    }
  }
  return null;
}

/** Feldwert einer Spalte (getrimmt), '' wenn die Spalte fehlt. */
export function field(row: CsvRow, columns: Map<string, number>, name: string): string {
  const index = columns.get(clean(name));
  return index === undefined ? '' : (row.fields[index] ?? '').trim();
}
