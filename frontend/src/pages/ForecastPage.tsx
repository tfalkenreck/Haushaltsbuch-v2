import { useCallback, useEffect, useState } from 'react';
import { fetchForecast, type Forecast } from '../api/insights';
import { useDataChanged } from '../lib/events';
import { formatCents, formatMonth } from '../lib/format';
import { INTERVAL_LABELS, RECURRING_KIND_LABELS } from '../lib/labels';
import { hrefFor } from '../lib/route';

interface Props {
  params: URLSearchParams;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const HORIZONS = [6, 12, 24];

const period = (months: string[]) =>
  months.length === 0 ? '' : months.length === 1 ? formatMonth(months[0] as string) : `${formatMonth(months[0] as string)} – ${formatMonth(months[months.length - 1] as string)}`;

function Amount({ cents, strong = false }: { cents: number; strong?: boolean }) {
  if (cents === 0) return <span className="muted">–</span>;
  const text = formatCents(cents, { sign: true });
  const className = cents > 0 ? 'amount-in' : undefined;
  return strong ? <strong className={className}>{text}</strong> : <span className={className}>{text}</span>;
}

/**
 * Prognose (CLAUDE.md § 15): Fixkosten aus Fixkosten & Abos mit Termin und
 * Betrag, variable Kategorien über den Median der letzten vollständigen
 * Monate, Einnahmen aus den wiederkehrenden Eingängen. Pro Kategorie, Monat
 * und Gesamtsaldo.
 */
export function ForecastPage({ params }: Props) {
  const requested = Number(params.get('months'));
  const horizon = HORIZONS.includes(requested) ? requested : 12;
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showItems, setShowItems] = useState(false);

  const reload = useCallback(() => {
    fetchForecast(horizon)
      .then((f) => {
        setForecast(f);
        setError(null);
      })
      .catch((err: unknown) => setError(message(err)));
  }, [horizon]);
  useEffect(reload, [reload]);
  useDataChanged(reload);

  const f = forecast;
  return (
    <section>
      <h2>Prognose</h2>
      <p className="hint">
        Fixkosten und Abos mit ihrem Soll an ihren Terminen – Jahresbeiträge landen im richtigen Monat. Variable Ausgaben je Kategorie
        über den <strong>Median</strong> der letzten vollständig importierten Monate (ohne Buchungen, die zu Fixkosten oder Abos
        gehören). Einnahmen aus den wiederkehrenden Eingängen. Umbuchungen zählen nicht.
      </p>
      {error && <p className="error panel">{error}</p>}
      {f && (
        <>
          <div className="filter-form panel">
            <label>
              Zeitraum
              <select value={horizon} onChange={(e) => (window.location.hash = hrefFor('prognose', { months: e.target.value }))}>
                {HORIZONS.map((h) => (
                  <option key={h} value={h}>
                    {h} Monate
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="panel">
            <p>
              Ø Überschuss je Monat:{' '}
              <strong className={f.averageSurplusCents < 0 ? 'deficit' : 'surplus'}>{formatCents(f.averageSurplusCents, { sign: true })}</strong>{' '}
              · über {f.months.length} Monate zusammen {formatCents(f.totals[f.totals.length - 1]?.cumulativeCents ?? 0, { sign: true })}
            </p>
            {f.basisMonths.length > 0 ? (
              <p className="hint">
                Median aus {f.basisMonths.length} vollständigen Monat{f.basisMonths.length === 1 ? '' : 'en'}: {period(f.basisMonths)}.
                {f.basisMonths.length < 3 && ' Das ist wenig – die variablen Ausgaben sind entsprechend unsicher.'}
              </p>
            ) : (
              <p className="warnings">Kein vollständig importierter Monat – variable Ausgaben fehlen in der Prognose.</p>
            )}
            {f.income.length === 0 && (
              <p className="warnings">Keine wiederkehrenden Eingänge erkannt – die Prognose enthält keine Einnahmen.</p>
            )}
            {f.startBalance.knownAccounts < f.startBalance.activeAccounts && (
              <p className="hint">
                Kontostand nur für {f.startBalance.knownAccounts} von {f.startBalance.activeAccounts} aktiven Konten bekannt – kein
                Gesamtstand. Fehlende Stände lassen sich auf der Seite <a href={hrefFor('deckung')}>Deckung</a> von Hand erfassen.
              </p>
            )}
            {f.excludedItems.length > 0 && (
              <p className="hint">
                Nicht berücksichtigt:{' '}
                {f.excludedItems.map((i) => `${i.name} (${i.reason === 'ended' ? 'beendet?' : 'ohne Termin'})`).join(', ')} –{' '}
                <a href={hrefFor('fixkosten')}>Fixkosten &amp; Abos</a>.
              </p>
            )}
          </div>

          <div className="table-scroll">
            <table className="data forecast">
              <thead>
                <tr>
                  <th />
                  {f.months.map((m) => (
                    <th key={m} className="num">
                      {formatMonth(m)}
                    </th>
                  ))}
                  <th className="num">Summe</th>
                </tr>
              </thead>
              <tbody>
                <tr className="group">
                  <th colSpan={f.months.length + 2}>Einnahmen</th>
                </tr>
                {f.income.map((s) => (
                  <tr key={s.key}>
                    <td>
                      {s.label} <small className="muted">{INTERVAL_LABELS[s.interval]}</small>
                    </td>
                    {s.months.map((v, i) => (
                      <td key={i} className="num">
                        <Amount cents={v} />
                      </td>
                    ))}
                    <td className="num">
                      <Amount cents={s.totalCents} />
                    </td>
                  </tr>
                ))}
                <tr className="group">
                  <th colSpan={f.months.length + 2}>Ausgaben nach Kategorie (Fixkosten + variabel)</th>
                </tr>
                {f.categories.map((c) => {
                  // Grundlast der Fixkosten (Abbuchungen sind negativ): was mehr ist, ist ein seltener Posten.
                  const usual = Math.max(...c.fixedMonths);
                  return (
                  <tr key={c.categoryId ?? 'none'}>
                    <td>
                      {c.name}
                      {c.variableCents !== 0 && (
                        <small className="muted block">variabel {formatCents(c.variableCents, { sign: true })} je Monat (Median)</small>
                      )}
                    </td>
                    {c.months.map((v, i) => (
                      <td key={i} className={`num${(c.fixedMonths[i] ?? 0) < usual ? ' fixed-due' : ''}`}>
                        <Amount cents={v} />
                      </td>
                    ))}
                    <td className="num">
                      <Amount cents={c.totalCents} />
                    </td>
                  </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th>Überschuss</th>
                  {f.totals.map((t) => (
                    <th key={t.month} className={`num ${t.balanceCents < 0 ? 'deficit' : 'surplus'}`}>
                      {formatCents(t.balanceCents, { sign: true })}
                    </th>
                  ))}
                  <th className="num">{formatCents(f.totals[f.totals.length - 1]?.cumulativeCents ?? 0, { sign: true })}</th>
                </tr>
                <tr>
                  <td>aufsummiert</td>
                  {f.totals.map((t) => (
                    <td key={t.month} className={`num ${t.cumulativeCents < 0 ? 'deficit' : ''}`}>
                      {formatCents(t.cumulativeCents, { sign: true })}
                    </td>
                  ))}
                  <td />
                </tr>
                {f.totals[0]?.projectedBalanceCents !== null && (
                  <tr>
                    <td>
                      Kontostand gesamt
                      <small className="muted block">heute {formatCents(f.startBalance.totalCents)}</small>
                    </td>
                    {f.totals.map((t) => (
                      <td key={t.month} className={`num ${(t.projectedBalanceCents ?? 0) < 0 ? 'deficit' : ''}`}>
                        {formatCents(t.projectedBalanceCents ?? 0)}
                      </td>
                    ))}
                    <td />
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
          <p className="hint">Hervorgehoben: Monate, in denen eine Fixkosten-Abbuchung fällig ist, die nicht jeden Monat kommt.</p>

          <p>
            <button type="button" className="link" onClick={() => setShowItems(!showItems)}>
              {f.fixedItems.length} Fixkosten &amp; Abos in der Prognose {showItems ? '– ausblenden' : '– anzeigen'}
            </button>
          </p>
          {showItems && (
            <table className="data">
              <thead>
                <tr>
                  <th>Posten</th>
                  <th>Art</th>
                  <th>Intervall</th>
                  <th className="num">Soll</th>
                  <th className="num">im Zeitraum</th>
                </tr>
              </thead>
              <tbody>
                {f.fixedItems.map((i) => (
                  <tr key={i.id}>
                    <td>{i.name}</td>
                    <td>{RECURRING_KIND_LABELS[i.kind]}</td>
                    <td>{INTERVAL_LABELS[i.interval]}</td>
                    <td className="num">{formatCents(i.amountCents)}</td>
                    <td className="num">{formatCents(i.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
