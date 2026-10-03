import type { AccountCoverage } from '../api/imports';
import { formatDate, formatMonth } from '../lib/format';

const STATUS_LABEL = {
  complete: 'vollständig',
  partial: 'teilweise',
  missing: 'fehlt',
} as const;

/** Monate mit Importstatus und offene Lücken eines Kontos. */
export function CoverageView({ coverage }: { coverage: AccountCoverage }) {
  if (coverage.months.length === 0) return <p>Noch nichts importiert.</p>;

  return (
    <div className="panel">
      <ol className="coverage">
        {coverage.months.map((m) => (
          <li key={m.month} className={`coverage-${m.status}`} title={`${STATUS_LABEL[m.status]}, ${m.transactionCount} Buchungen`}>
            <span>{formatMonth(m.month)}</span>
            <small>{STATUS_LABEL[m.status]}</small>
          </li>
        ))}
      </ol>
      {coverage.gaps.length > 0 ? (
        <>
          <p className="hint">Lücken – hier fehlen Kontoauszüge:</p>
          <ul className="warnings">
            {coverage.gaps.map((g) => (
              <li key={g.start}>
                {formatDate(g.start)} – {formatDate(g.end)}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="hint">Keine Lücken.</p>
      )}
    </div>
  );
}
