/** Aktueller Zeitstempel als ISO-8601 mit Uhrzeit (UTC). */
export function nowIso(): string {
  return new Date().toISOString();
}
