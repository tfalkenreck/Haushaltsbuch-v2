export interface CsvRow {
  /** Zeilennummer in der Datei (1-basiert), an der der Datensatz beginnt. */
  line: number;
  fields: string[];
}

/**
 * Quote-aware CSV-Parser für Semikolon-getrennte Bankexporte.
 * - Felder in Anführungszeichen dürfen Trennzeichen und Zeilenumbrüche
 *   enthalten; `""` steht für ein Anführungszeichen.
 * - Zeilenenden CRLF, LF oder CR.
 * - Leere Zeilen bleiben als Datensatz mit einem leeren Feld erhalten
 *   (der Aufrufer entscheidet, was er damit macht).
 */
export function parseCsv(text: string, delimiter = ';'): CsvRow[] {
  const rows: CsvRow[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowStart = 1;
  let i = 0;

  const endRow = () => {
    fields.push(field);
    rows.push({ line: rowStart, fields });
    fields = [];
    field = '';
  };

  while (i < text.length) {
    const char = text[i] as string;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (char === '\r' || char === '\n') {
        if (char === '\r' && text[i + 1] === '\n') i += 1;
        field += '\n';
        line += 1;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"' && field.trim() === '') {
      field = '';
      inQuotes = true;
    } else if (char === delimiter) {
      fields.push(field);
      field = '';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
      line += 1;
      rowStart = line;
    } else {
      field += char;
    }
    i += 1;
  }

  // Letzte Zeile ohne abschließenden Zeilenumbruch.
  if (field !== '' || fields.length > 0) endRow();

  return rows;
}

/** true, wenn alle Felder leer sind (Leerzeile oder nur Trennzeichen). */
export function isBlankRow(row: CsvRow): boolean {
  return row.fields.every((f) => f.trim() === '');
}
