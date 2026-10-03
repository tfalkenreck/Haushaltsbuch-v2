/**
 * Cent → „1.234,56 €“. Rein über Ganzzahlen und Zeichenketten, ohne
 * Float-Division.
 */
export function formatCents(cents: number, options: { sign?: boolean } = {}): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const euros = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const rest = String(abs % 100).padStart(2, '0');
  const prefix = negative ? '−' : options.sign && cents > 0 ? '+' : '';
  return `${prefix}${euros},${rest} €`;
}

/** `YYYY-MM-DD` → `TT.MM.JJJJ`. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/** `YYYY-MM` → „Sep 2026“. */
export function formatMonth(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1] ?? month.slice(5, 7)} ${month.slice(0, 4)}`;
}

/** ISO-Zeitstempel → „03.10.2026, 14:05“ in lokaler Zeit. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
