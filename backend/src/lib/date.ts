/** `TT.MM.JJJJ` → `YYYY-MM-DD`; `null`, wenn kein gültiges Datum. */
export function parseGermanDate(input: string): string | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(input.trim());
  if (!match) return null;
  const [, day, month, year] = match as unknown as [string, string, string, string];
  const iso = `${year}-${month}-${day}`;
  return isValidIsoDate(iso) ? iso : null;
}

/** Prüft, ob `YYYY-MM-DD` ein existierender Kalendertag ist. */
export function isValidIsoDate(iso: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Verschiebt ein ISO-Datum um `days` Tage (UTC, ohne Zeitzonen-Effekte). */
export function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM` des Datums. */
export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/** Erster und letzter Tag eines Monats `YYYY-MM`. */
export function monthBounds(month: string): { first: string; last: string } {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return { first: `${month}-01`, last: `${month}-${String(daysInMonth(year, m)).padStart(2, '0')}` };
}

/** Alle Monate `YYYY-MM` von `from` bis `to` (beide inklusive). */
export function monthRange(from: string, to: string): string[] {
  const months: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const endKey = to.slice(0, 7);
  for (;;) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    if (key > endKey) break;
    months.push(key);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/** `YYYY-MM-DD` → `TT.MM.JJJJ` für deutsche Meldungen. */
export function formatDateDe(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}
