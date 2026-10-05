/**
 * Median ganzzahliger Cent-Beträge. Bei gerader Anzahl der Mittelwert der
 * beiden mittleren Werte, auf ganze Cent gerundet. Leere Liste → 0.
 */
export function medianCents(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** Durchschnitt ganzzahliger Cent-Beträge, auf ganze Cent gerundet. Leere Liste → 0. */
export function averageCents(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length);
}

/** Anteil in Promille (1000 = 100 %), gerundet; 0 bei Gesamt ≤ 0. */
export function permille(part: number, total: number): number {
  return total > 0 ? Math.round((part * 1000) / total) : 0;
}
