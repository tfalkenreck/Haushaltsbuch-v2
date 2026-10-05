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

/** Cent → Eingabetext ohne Währung („1234,56“), z. B. als Vorbelegung eines Betragsfelds. */
export function centsToInput(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` plus `months` Monate; der Tag wird aufs Monatsende begrenzt. */
export function addMonthsIso(iso: string, months: number): string {
  const index = Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1 + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(Number(iso.slice(8, 10)), last);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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

/** Promille → „12,3 %“ (ganzzahlig, ohne Float-Division). */
export function formatPermille(permille: number): string {
  const negative = permille < 0;
  const abs = Math.abs(permille);
  return `${negative ? '−' : ''}${Math.trunc(abs / 10)},${abs % 10} %`;
}

/** Anzahl Monate → „1 Monat“ / „3 Monate“. */
export function formatMonthCount(n: number): string {
  return `${n} ${n === 1 ? 'Monat' : 'Monate'}`;
}
