/**
 * Wandelt einen deutschen Betrag in Cent um – rein über Zeichenketten,
 * ohne Float-Umweg: `-1.234,56` → -123456, `7,5` → 750, `12` → 1200.
 * Erlaubt Vorzeichen (+/-), Tausenderpunkte und Leerzeichen; liefert
 * `null`, wenn der Text kein Betrag ist.
 */
export function parseGermanAmount(input: string): number | null {
  const text = input.replace(/[\s ]/g, '');
  const match = /^([+-]?)(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/.exec(text);
  if (!match) return null;

  const sign = match[1] === '-' ? -1 : 1;
  const euros = (match[2] ?? '').replace(/\./g, '');
  const cents = (match[3] ?? '').padEnd(2, '0');
  const value = Number(euros) * 100 + Number(cents);
  if (!Number.isSafeInteger(value)) return null;
  return value === 0 ? 0 : sign * value;
}
