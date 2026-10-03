import type { ImportResult } from '../api/imports';
import { formatDate } from '../lib/format';
import { hrefFor } from '../lib/route';

/** Ergebnis eines Imports: was übernommen, was übersprungen wurde und warum. */
export function ImportResultView({ result }: { result: ImportResult }) {
  return (
    <div className="panel import-result">
      <p>
        <strong>{result.fileName}</strong>: {result.imported} neue Buchungen
        {result.imported > 0 && ` (${result.categorized} per Regel kategorisiert)`}
        {result.duplicates > 0 && `, ${result.duplicates} bereits vorhanden`}
        {result.otherAccount > 0 && `, ${result.otherAccount} von einem anderen Konto`}. Zeitraum{' '}
        {formatDate(result.periodStart)} – {formatDate(result.periodEnd)}.
        {result.batchId !== null && (
          <>
            {' '}
            <a href={hrefFor('buchungen', { accountId: result.accountId, importBatchId: result.batchId })}>
              Importierte Buchungen ansehen
            </a>
          </>
        )}
      </p>

      {result.warnings.length > 0 && (
        <ul className="warnings">
          {result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {result.pending.length > 0 && (
        <details open>
          <summary>{result.pending.length} vorgemerkte Umsätze nicht importiert (ändern sich noch)</summary>
          <ul>
            {result.pending.map((p) => (
              <li key={p.line}>
                Zeile {p.line}: {p.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      {result.ignored.length > 0 && (
        <details>
          <summary>{result.ignored.length} Zeilen ignoriert (keine Buchung)</summary>
          <ul>
            {result.ignored.map((p) => (
              <li key={p.line}>
                Zeile {p.line}: {p.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
