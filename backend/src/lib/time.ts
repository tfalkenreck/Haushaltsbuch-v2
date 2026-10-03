/** Aktueller Zeitstempel als ISO-8601 mit Uhrzeit (UTC). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Heutiges Datum als YYYY-MM-DD in der lokalen Zeitzone des Rechners. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
