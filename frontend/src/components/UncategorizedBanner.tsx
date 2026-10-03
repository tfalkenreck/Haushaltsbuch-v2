import { useCallback, useEffect, useState } from 'react';
import { fetchUncategorizedSummary, type UncategorizedSummary } from '../api/transactions';
import { useDataChanged } from '../lib/events';
import { formatCents } from '../lib/format';
import { hrefFor } from '../lib/route';

/**
 * Immer sichtbar (CLAUDE.md § 2.5): wie viele Buchungen noch keine
 * Kategorie haben und um welche Summen es geht – mit Sprung zur
 * gefilterten Liste.
 */
export function UncategorizedBanner({ routeKey }: { routeKey: string }) {
  const [summary, setSummary] = useState<UncategorizedSummary | null>(null);

  const reload = useCallback(() => {
    fetchUncategorizedSummary()
      .then(setSummary)
      .catch(() => setSummary(null));
  }, []);

  useEffect(reload, [reload, routeKey]);
  useDataChanged(reload);

  if (summary === null) return null;
  if (summary.count === 0) return <p className="uncategorized-banner done">Alle Buchungen sind kategorisiert.</p>;

  return (
    <p className="uncategorized-banner">
      <a href={hrefFor('buchungen', { uncategorized: 1 })}>
        <strong>{summary.count} unkategorisierte Buchungen</strong>
      </a>{' '}
      · Abflüsse <span className="amount-out">{formatCents(summary.outflowCents)}</span>
      {summary.inflowCents > 0 && (
        <>
          {' '}
          · Zuflüsse <span className="amount-in">{formatCents(summary.inflowCents)}</span>
        </>
      )}{' '}
      – fehlen in jeder Auswertung nach Kategorie.
    </p>
  );
}
