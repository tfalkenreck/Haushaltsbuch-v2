import { useCallback, useEffect, useState } from 'react';
import { fetchAccounts, type Account } from '../api/accounts';
import type { MonthStatus } from '../api/funding';
import { fetchAttention, fetchOverview, type AttentionItem, type MonthCompleteness, type MonthOverview, type MonthTotals } from '../api/insights';
import { AttentionList } from '../components/AttentionList';
import { useDataChanged } from '../lib/events';
import { formatCents, formatMonth, formatPermille } from '../lib/format';
import { hrefFor } from '../lib/route';

interface Props {
  params: URLSearchParams;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const STATUS_HINTS: Record<MonthStatus, string | null> = {
  complete: null,
  partial: 'teilweise importiert',
  missing: 'nicht importiert',
};

function lastDayOf(month: string): string {
  const day = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

/** Hinweis, wenn der Monat nicht vollständig importiert ist – sonst sieht ein halber Monat aus wie ein sparsamer. */
function CompletenessHint({ c }: { c: MonthCompleteness }) {
  if (c.status === 'complete') {
    return c.notYetImported.length > 0 ? (
      <p className="hint">
        Erst später importiert und daher nicht enthalten: {c.notYetImported.map((a) => `„${a.accountName}“`).join(', ')}.
      </p>
    ) : null;
  }
  return (
    <p className="warnings panel">
      <strong>{formatMonth(c.month)} ist nicht vollständig importiert</strong> – die Zahlen sind unvollständig, ein halber Monat sieht
      sonst aus wie ein sparsamer.{' '}
      {c.incomplete.map((a, i) => (
        <span key={a.accountId}>
          {i > 0 && ', '}
          <a href={hrefFor('import', { accountId: a.accountId })}>
            „{a.accountName}“ {STATUS_HINTS[a.status]}
          </a>
        </span>
      ))}
    </p>
  );
}

function Change({ cents, invert = false }: { cents: number; invert?: boolean }) {
  if (cents === 0) return <span className="muted">±0,00 €</span>;
  // Bei Ausgaben ist ein Plus schlecht, bei Einnahmen und Saldo gut.
  const good = invert ? cents < 0 : cents > 0;
  return <span className={good ? 'surplus' : 'deficit'}>{formatCents(cents, { sign: true })}</span>;
}

function Tiles({ o }: { o: MonthOverview }) {
  const t = o.totals;
  const p = o.previous;
  const prevHint = p.status !== 'complete' ? ` (${STATUS_HINTS[p.status]})` : '';
  return (
    <div className="tiles">
      <div className="tile">
        <span className="tile-label">Einnahmen</span>
        <strong className="tile-value amount-in">{formatCents(t.incomeCents)}</strong>
        <small>
          zum Vormonat <Change cents={t.incomeCents - p.incomeCents} />
          {prevHint}
        </small>
      </div>
      <div className="tile">
        <span className="tile-label">Ausgaben</span>
        <strong className="tile-value">{formatCents(t.expensesCents)}</strong>
        <small>
          zum Vormonat <Change cents={t.expensesCents - p.expensesCents} invert />
          {prevHint}
        </small>
      </div>
      <div className="tile">
        <span className="tile-label">Saldo</span>
        <strong className={`tile-value ${t.balanceCents < 0 ? 'deficit' : 'surplus'}`}>{formatCents(t.balanceCents, { sign: true })}</strong>
        <small>
          zum Vormonat <Change cents={t.balanceCents - p.balanceCents} />
          {prevHint}
        </small>
      </div>
    </div>
  );
}

function Categories({ o }: { o: MonthOverview }) {
  const range = { from: `${o.month}-01`, to: lastDayOf(o.month) };
  const accountId = o.accountId ?? undefined;
  if (o.categories.length === 0) return <p className="muted">Keine Ausgaben in diesem Monat.</p>;
  return (
    <table className="data">
      <thead>
        <tr>
          <th>Kategorie</th>
          <th className="num">Ausgaben</th>
          <th className="num">Anteil</th>
          <th />
          <th className="num">Vormonat</th>
          <th className="num">Veränderung</th>
        </tr>
      </thead>
      <tbody>
        {o.categories.map((c) => (
          <tr key={c.categoryId ?? 'none'} className={c.categoryId === null ? 'incomplete' : undefined}>
            <td>
              <a
                href={hrefFor('buchungen', {
                  ...range,
                  accountId,
                  transfers: 'exclude',
                  ...(c.categoryId === null ? { uncategorized: 1 } : { categoryId: c.categoryId }),
                })}
              >
                {c.name}
              </a>
              {c.inflowCents > 0 && <small className="muted block">davon erstattet/gutgeschrieben {formatCents(c.inflowCents)}</small>}
            </td>
            <td className="num">{formatCents(c.outflowCents)}</td>
            <td className="num">{formatPermille(c.sharePermille)}</td>
            <td className="bar-cell">
              <span className="bar bar-neutral" style={{ width: `${c.sharePermille / 10}%` }} />
            </td>
            <td className="num muted">{formatCents(c.previousOutflowCents)}</td>
            <td className="num">
              <Change cents={c.changeCents} invert />
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th>Zusammen</th>
          <th className="num">{formatCents(o.totals.expensesCents)}</th>
          <th colSpan={2} />
          <th className="num">{formatCents(o.previous.expensesCents)}</th>
          <th className="num">
            <Change cents={o.totals.expensesCents - o.previous.expensesCents} invert />
          </th>
        </tr>
      </tfoot>
    </table>
  );
}

function History({ o, onPick }: { o: MonthOverview; onPick: (month: string) => void }) {
  const max = Math.max(1, ...o.history.map((m) => Math.max(m.incomeCents, m.expensesCents)));
  const width = (cents: number) => `${(cents / max) * 100}%`;
  return (
    <table className="data">
      <thead>
        <tr>
          <th>Monat</th>
          <th className="num">Einnahmen</th>
          <th className="num">Ausgaben</th>
          <th />
          <th className="num">Saldo</th>
        </tr>
      </thead>
      <tbody>
        {[...o.history].reverse().map((m: MonthTotals) => {
          const hint = STATUS_HINTS[m.status];
          return (
            <tr key={m.month} className={hint ? 'incomplete' : m.month === o.month ? 'selected' : undefined}>
              <td>
                <button type="button" className="link" onClick={() => onPick(m.month)}>
                  {formatMonth(m.month)}
                </button>
                {hint && <small className="warnings block">{hint} – unvollständig</small>}
              </td>
              <td className="num amount-in">{formatCents(m.incomeCents)}</td>
              <td className="num">{formatCents(m.expensesCents)}</td>
              <td className="bar-cell bar-pair">
                <span className="bar bar-surplus" style={{ width: width(m.incomeCents) }} />
                <span className="bar bar-deficit" style={{ width: width(m.expensesCents) }} />
              </td>
              <td className="num">
                <span className={hint ? 'muted' : m.balanceCents < 0 ? 'deficit' : 'surplus'}>{formatCents(m.balanceCents, { sign: true })}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Startseite (CLAUDE.md § 15): oben die offenen Punkte, darunter die
 * Monatsübersicht – gesamt oder pro Konto, Umbuchungen nie mitgezählt.
 */
export function OverviewPage({ params }: Props) {
  const month = params.get('month') ?? undefined;
  const accountId = Number(params.get('accountId')) || undefined;
  const [attention, setAttention] = useState<AttentionItem[] | null>(null);
  const [overview, setOverview] = useState<MonthOverview | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    Promise.all([fetchAttention(), fetchOverview({ month, accountId })])
      .then(([a, o]) => {
        setAttention(a.items);
        setOverview(o);
        setError(null);
      })
      .catch((err: unknown) => setError(message(err)));
  }, [month, accountId]);
  useEffect(reload, [reload]);
  useDataChanged(reload);
  useEffect(() => {
    fetchAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);

  const navigate = (next: { month?: string | undefined; accountId?: number | undefined }) => {
    window.location.hash = hrefFor('uebersicht', { month, accountId, ...next });
  };

  return (
    <section>
      <h2>Übersicht</h2>
      {error && <p className="error panel">{error}</p>}

      <h3>Offene Punkte</h3>
      {attention === null ? <p className="muted">Lädt …</p> : <AttentionList items={attention} />}

      {overview && (
        <>
          <h3>Monatsübersicht</h3>
          <div className="filter-form panel">
            <label>
              Monat
              <select value={overview.month} onChange={(e) => navigate({ month: e.target.value })}>
                {overview.availableMonths.map((m) => (
                  <option key={m} value={m}>
                    {formatMonth(m)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Konto
              <select value={accountId ?? ''} onChange={(e) => navigate({ accountId: Number(e.target.value) || undefined })}>
                <option value="">alle Konten</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.active ? '' : ' (deaktiviert)'}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <CompletenessHint c={overview.completeness} />
          <Tiles o={overview} />
          <p className="hint">
            Umbuchungen zwischen eigenen Konten zählen weder als Einnahme noch als Ausgabe
            {overview.transfers.count > 0 && (
              <>
                {' '}
                ({overview.transfers.count} Buchung{overview.transfers.count === 1 ? '' : 'en'} in {formatMonth(overview.month)},{' '}
                <a href={hrefFor('buchungen', { from: `${overview.month}-01`, to: lastDayOf(overview.month), accountId, transfers: 'only' })}>
                  anzeigen
                </a>
                )
              </>
            )}
            . Kartenumsätze zählen mit ihrem Kaufdatum.
          </p>
          {overview.uncategorized.count > 0 && (
            <p className="warnings">
              {overview.uncategorized.count} Buchung{overview.uncategorized.count === 1 ? '' : 'en'} in {formatMonth(overview.month)} ohne
              Kategorie ({formatCents(overview.uncategorized.outflowCents)} Abflüsse) –{' '}
              <a href={hrefFor('buchungen', { uncategorized: 1, from: `${overview.month}-01`, to: lastDayOf(overview.month), accountId })}>
                kategorisieren
              </a>
              .
            </p>
          )}

          <h3>Ausgaben nach Kategorie</h3>
          <Categories o={overview} />

          <h3>Verlauf über 12 Monate</h3>
          <History o={overview} onPick={(m) => navigate({ month: m })} />
        </>
      )}
    </section>
  );
}
