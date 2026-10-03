/**
 * Saldoverlauf eines Kontos (CLAUDE.md § 12.5) – reine Funktionen.
 *
 * Bekannte Kontostände („Anker“) kommen aus drei Quellen:
 * - `bank`: Saldo nach Buchung je Zeile (Volksbank), daraus der Stand am Tagesende,
 * - `import`: Kontostand laut Datei (Comdirect-Metadaten, falls vorhanden),
 * - `manual`: von Hand erfasster Kontostand mit Datum (Konten ohne Saldo).
 * Jeder Anker ist der Stand am Ende seines Tages. Für jedes andere Datum
 * wird vom nächstgelegenen Anker über die Buchungen vor- bzw.
 * zurückgerechnet.
 */

export type BalanceSource = 'bank' | 'import' | 'manual';

export interface Movement {
  id: number;
  /** Buchungstag der Bank (für den Kontostand maßgeblich). */
  date: string;
  amountCents: number;
  balanceAfterCents: number | null;
}

export interface BalanceAnchor {
  date: string;
  balanceCents: number;
  source: BalanceSource;
}

export interface BalanceAt {
  balanceCents: number;
  /** Quelle des verwendeten Ankers. */
  source: BalanceSource;
  /** Datum des verwendeten Ankers. */
  anchorDate: string;
}

/**
 * Kontostand am Ende jedes Tages, an dem die Bank zu jeder Zeile einen
 * Saldo liefert. Die Reihenfolge innerhalb eines Tages ist unbekannt: Der
 * Tagesendstand ist der Saldo, der zugleich „Saldo vor der ersten Buchung
 * plus Tagessumme“ ist. Passt nichts (Kette gebrochen), gilt der Saldo der
 * zuerst importierten Zeile (Volksbank exportiert die neueste zuerst).
 */
export function dayEndBalances(movements: Movement[]): BalanceAnchor[] {
  const byDay = new Map<string, Movement[]>();
  for (const m of movements) {
    const list = byDay.get(m.date);
    if (list) list.push(m);
    else byDay.set(m.date, [m]);
  }
  const anchors: BalanceAnchor[] = [];
  for (const [date, list] of byDay) {
    if (list.some((m) => m.balanceAfterCents === null)) continue;
    const total = list.reduce((sum, m) => sum + m.amountCents, 0);
    const afters = new Set(list.map((m) => m.balanceAfterCents as number));
    const end = list
      .map((m) => (m.balanceAfterCents as number) - m.amountCents + total)
      .find((candidate) => afters.has(candidate));
    const fallback = [...list].sort((a, b) => a.id - b.id)[0]?.balanceAfterCents as number;
    anchors.push({ date, balanceCents: end ?? fallback, source: 'bank' });
  }
  return anchors.sort((a, b) => a.date.localeCompare(b.date));
}

const SOURCE_RANK: Record<BalanceSource, number> = { bank: 0, import: 1, manual: 2 };

function dayDistance(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
}

/**
 * Kontostand am Ende von `date`: nächstgelegener Anker (bei gleichem
 * Abstand der Bank-Saldo vor Datei und Handeingabe), dann über die
 * Buchungen dazwischen gerechnet. `null` ohne jeden Anker.
 */
export function balanceAt(date: string, anchors: BalanceAnchor[], movements: Movement[]): BalanceAt | null {
  let best: BalanceAnchor | null = null;
  for (const a of anchors) {
    if (
      best === null ||
      dayDistance(a.date, date) < dayDistance(best.date, date) ||
      (dayDistance(a.date, date) === dayDistance(best.date, date) && SOURCE_RANK[a.source] < SOURCE_RANK[best.source])
    ) {
      best = a;
    }
  }
  if (best === null) return null;
  const anchor = best;
  let balance = anchor.balanceCents;
  if (anchor.date <= date) {
    for (const m of movements) if (m.date > anchor.date && m.date <= date) balance += m.amountCents;
  } else {
    for (const m of movements) if (m.date > date && m.date <= anchor.date) balance -= m.amountCents;
  }
  return { balanceCents: balance, source: anchor.source, anchorDate: anchor.date };
}
