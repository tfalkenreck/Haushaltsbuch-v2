import { useCallback, useEffect, useState } from 'react';
import { fetchBudget, type Budget, type BudgetBucket, type BudgetSpan } from '../api/insights';
import { useDataChanged } from '../lib/events';
import { formatCents, formatDate, formatMonth, formatPermille } from '../lib/format';
import { BUCKET_LABELS, INTERVAL_LABELS } from '../lib/labels';
import { hrefFor } from '../lib/route';

interface Props {
  params: URLSearchParams;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const SPANS: { value: BudgetSpan; label: string }[] = [
  { value: 1, label: 'einen Monat' },
  { value: 3, label: 'Ø 3 Monate' },
  { value: 6, label: 'Ø 6 Monate' },
  { value: 12, label: 'Ø 12 Monate' },
];

function lastDayOf(month: string): string {
  const day = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

const period = (b: Budget) =>
  b.months.length === 1 ? formatMonth(b.month) : `${formatMonth(b.months[0]?.month ?? b.month)} – ${formatMonth(b.month)}`;

function Income({ b }: { b: Budget }) {
  const i = b.income;
  return (
    <div className="panel">
      {i.basisSource === 'none' ? (
        <p className="warnings">
          Keine wiederkehrenden Eingänge erkannt – ohne Nettoeinkommen lassen sich keine Ziele berechnen. Ein Gehalt wird erkannt,
          sobald es mindestens dreimal monatlich eingegangen ist.
        </p>
      ) : (
        <p>
          <strong>Nettoeinkommen {formatCents(i.basisCents)} je Monat</strong>{' '}
          {i.basisSource === 'actual' ? (
            <>– wiederkehrende Eingänge {period(b)}.</>
          ) : (
            <>
              – erwarteter Monatswert der laufenden wiederkehrenden Eingänge, weil {period(b)} nicht vollständig importiert ist oder kein
              Eingang darin liegt (tatsächlich {formatCents(i.actualCents)}).
            </>
          )}
        </p>
      )}
      <p className="hint">
        Grundlage sind nur wiederkehrende Eingänge, nicht alle Gutschriften – Erstattungen und einmalige Eingänge verzerren das Einkommen.
        Alle Gutschriften ohne Umbuchungen: {formatCents(i.allCreditsCents)} je Monat.
      </p>
      {i.sources.length > 0 && (
        <ul className="plain">
          {i.sources.map((s) => (
            <li key={s.key} className={s.ended ? 'muted' : undefined}>
              {s.label} ({s.accountName}): {formatCents(s.lastAmountCents)} {INTERVAL_LABELS[s.interval]}, {s.count}× seit{' '}
              {formatDate(s.firstDate)}
              {s.ended && ' – beendet'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Deviation({ cents, save = false }: { cents: number | null; save?: boolean }) {
  if (cents === null) return <span className="muted">–</span>;
  if (cents === 0) return <span className="muted">±0,00 €</span>;
  // Bei Sparen ist mehr gut, bei Ausgaben weniger.
  const good = save ? cents > 0 : cents < 0;
  return <span className={good ? 'surplus' : 'deficit'}>{formatCents(cents, { sign: true })}</span>;
}

function BucketTable({ b, budget }: { b: BudgetBucket; budget: Budget }) {
  const save = b.bucket === 'save';
  const range = { from: `${budget.months[0]?.month ?? budget.month}-01`, to: lastDayOf(budget.month) };
  const ratio = b.targetCents > 0 ? Math.min(100, (b.actualCents / b.targetCents) * 100) : 0;
  const over = b.targetCents > 0 && b.actualCents > b.targetCents;
  return (
    <div className="panel">
      <h3>
        {BUCKET_LABELS[b.bucket]}: {formatCents(b.actualCents)} von {formatCents(b.targetCents)}{' '}
        <small className="muted">({formatPermille(b.incomePermille)} des Einkommens, Ziel {b.targetPercent} %)</small>
      </h3>
      <div className="meter">
        <span className={`meter-fill ${over !== save ? 'meter-over' : 'meter-ok'}`} style={{ width: `${ratio}%` }} />
      </div>
      <p>
        Abweichung vom Ziel: <Deviation cents={b.deviationCents} save={save} />
        {save && b.savingsTransfersCents !== 0 && (
          <span className="hint"> · davon Umbuchungen aufs Sparkonto {formatCents(b.savingsTransfersCents)}</span>
        )}
      </p>
      {b.categories.length > 0 && (
        <table className="data">
          <thead>
            <tr>
              <th>Kategorie</th>
              <th className="num">Ist</th>
              <th className="num">üblich</th>
              <th className="num">Abweichung</th>
            </tr>
          </thead>
          <tbody>
            {b.categories.map((c) => (
              <tr key={c.categoryId}>
                <td>
                  <a href={hrefFor('buchungen', { ...range, categoryId: c.categoryId, transfers: 'exclude' })}>{c.path}</a>
                </td>
                <td className="num">{formatCents(c.actualCents)}</td>
                <td className="num muted">{c.typicalCents === null ? '–' : formatCents(c.typicalCents)}</td>
                <td className="num">
                  <Deviation cents={c.deviationCents} save={save} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Budget 50/30/20 (CLAUDE.md § 15): Nettoeinkommen aus den
 * wiederkehrenden Eingängen, Ausgaben nach Bucket, Ist gegen Ziel und die
 * Abweichung je Kategorie gegenüber dem Üblichen.
 */
export function BudgetPage({ params }: Props) {
  const month = params.get('month') ?? undefined;
  const spanParam = Number(params.get('span'));
  const span = SPANS.some((s) => s.value === spanParam) ? (spanParam as BudgetSpan) : undefined;
  const [budget, setBudget] = useState<Budget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchBudget({ month, span })
      .then((b) => {
        setBudget(b);
        setError(null);
      })
      .catch((err: unknown) => setError(message(err)));
  }, [month, span]);
  useEffect(reload, [reload]);
  useDataChanged(reload);

  const navigate = (next: { month?: string | undefined; span?: BudgetSpan | undefined }) => {
    window.location.hash = hrefFor('budget', { month: budget?.month ?? month, span, ...next });
  };

  const monthOptions = (() => {
    if (!budget) return [];
    const options: string[] = [];
    const [y, m] = [Number(budget.month.slice(0, 4)), Number(budget.month.slice(5, 7))];
    for (let i = -24; i <= 3; i++) {
      const index = y * 12 + m - 1 + i;
      options.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`);
    }
    return options.reverse();
  })();

  return (
    <section>
      <h2>Budget 50/30/20</h2>
      <p className="hint">
        50 % des Nettoeinkommens für Bedarf, 30 % für Wünsche, 20 % fürs Sparen. Der Nutzen liegt in der Abweichung je Kategorie: „üblich“
        ist der Median der vollständig importierten Monate davor. Den Bucket einer Kategorie änderst du unter{' '}
        <a href={hrefFor('kategorien')}>Kategorien</a>. Umbuchungen zählen nicht als Ausgabe; Umbuchungen aufs Sparkonto erscheinen
        aber beim Sparen.
      </p>
      {error && <p className="error panel">{error}</p>}
      {budget && (
        <>
          <div className="filter-form panel">
            <label>
              Monat
              <select value={budget.month} onChange={(e) => navigate({ month: e.target.value })}>
                {monthOptions.map((m) => (
                  <option key={m} value={m}>
                    {formatMonth(m)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Zeitraum
              <select value={budget.span} onChange={(e) => navigate({ span: Number(e.target.value) as BudgetSpan })}>
                {SPANS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!budget.allComplete && (
            <p className="warnings panel">
              Nicht vollständig importiert:{' '}
              {budget.months
                .filter((m) => m.status !== 'complete')
                .map((m) => formatMonth(m.month))
                .join(', ')}{' '}
              – die Ausgaben sind unvollständig. <a href={hrefFor('import')}>Zum Import</a>
            </p>
          )}
          <Income b={budget} />
          {budget.buckets.map((b) => (
            <BucketTable key={b.bucket} b={b} budget={budget} />
          ))}
          {budget.unassigned.totalCents > 0 && (
            <div className="panel">
              <h3>Ohne Bucket: {formatCents(budget.unassigned.totalCents)}</h3>
              <p className="hint">Fließt nicht in die 50/30/20-Rechnung ein – sichtbar, damit die Auswertung nicht geschönt ist.</p>
              <ul className="plain">
                {budget.unassigned.uncategorizedCents > 0 && (
                  <li>
                    <a href={hrefFor('buchungen', { uncategorized: 1, from: `${budget.months[0]?.month ?? budget.month}-01`, to: lastDayOf(budget.month) })}>
                      ohne Kategorie
                    </a>
                    : {formatCents(budget.unassigned.uncategorizedCents)}
                  </li>
                )}
                {budget.unassigned.categories.map((c) => (
                  <li key={c.categoryId}>
                    {c.path}: {formatCents(c.actualCents)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {budget.typicalMonths.length === 0 && (
            <p className="hint">Für „üblich“ fehlen vollständig importierte Monate vor dem Zeitraum.</p>
          )}
        </>
      )}
    </section>
  );
}
