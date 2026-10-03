import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { fetchAccounts, type Account } from '../api/accounts';
import {
  createManualBalance,
  deleteManualBalance,
  fetchFunding,
  type FundingAnalysis,
  type FundingMonth,
  type StandingOrder,
} from '../api/funding';
import { BypassSection } from '../components/BypassSection';
import { notifyDataChanged, useDataChanged } from '../lib/events';
import { formatCents, formatDate, formatMonth } from '../lib/format';
import { BALANCE_SOURCE_LABELS } from '../lib/labels';
import { hrefFor } from '../lib/route';

interface Props {
  params: URLSearchParams;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const STATUS_HINTS: Record<FundingMonth['status'], string | null> = {
  complete: null,
  partial: 'teilweise importiert',
  missing: 'nicht importiert',
};

/** Letzter Tag eines Monats `YYYY-MM` (nur für Links in die Buchungsliste). */
function lastDayOf(month: string): string {
  const day = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

function Difference({ cents, inline = false }: { cents: number; inline?: boolean }) {
  if (cents === 0) return <span>{formatCents(0)}</span>;
  const label = cents < 0 ? 'Unterdeckung' : 'Überdeckung';
  return (
    <span className={cents < 0 ? 'deficit' : 'surplus'}>
      {formatCents(cents, { sign: true })}
      {inline ? ` (${label})` : <small className="block">{label}</small>}
    </span>
  );
}

/** Zusammenfassung: gedeckt? seit wann nicht? wächst es? was empfiehlt sich? */
function Verdict({ f }: { f: FundingAnalysis }) {
  const t = f.trend;
  const r = f.recommendation;
  const b = f.balance;
  const months = t.windowMonths.length;
  const directionText =
    t.direction === 'growing' ? 'und sie wird größer' : t.direction === 'shrinking' ? 'sie wird aber kleiner' : t.direction === 'steady' ? 'gleichbleibend' : '';

  return (
    <div className={`panel verdict ${t.status === 'trend' ? 'verdict-bad' : t.status === 'single' ? 'verdict-warn' : 'verdict-ok'}`}>
      {t.status === 'unknown' && <p>Noch kein vollständig importierter Monat – ohne vollständige Monate lässt sich die Deckung nicht beurteilen.</p>}
      {t.status === 'covered' && (
        <p>
          <strong>Gedeckt:</strong> Im letzten vollständigen Monat haben die Daueraufträge die Abbuchungen gedeckt.
        </p>
      )}
      {t.status === 'single' && (
        <p>
          <strong>Unterdeckung seit {formatMonth(t.deficitSince as string)}</strong> ({t.deficitStreak} Monat
          {t.deficitStreak === 1 ? '' : 'e'} in Folge{directionText ? `, ${directionText}` : ''}). Ein schlechter Monat kann Zufall
          sein – ab drei in Folge ist es ein Trend.
        </p>
      )}
      {t.status === 'trend' && (
        <p>
          <strong>
            Unterdeckung seit {formatMonth(t.deficitSince as string)} – {t.deficitStreak} Monate in Folge
          </strong>
          {directionText ? `, ${directionText}` : ''}. Das ist ein Trend, kein Zufall.
        </p>
      )}
      {months > 0 && (
        <p>
          Letzte {months} vollständige Monat{months === 1 ? '' : 'e'}: Daueraufträge Ø {formatCents(t.averageStandingOrdersCents ?? 0)},
          Abbuchungen Ø {formatCents(t.averageExpensesCents ?? 0)}, Differenz Ø{' '}
          <Difference cents={t.averageDifferenceCents ?? 0} inline />
          {t.deficitMonthsInWindow > 0 && <> · {t.deficitMonthsInWindow} davon mit Unterdeckung</>}
        </p>
      )}

      {b.status === 'negative' && b.current && (
        <p className="deficit">
          <strong>Das Konto ist im Minus:</strong> {formatCents(b.current.balanceCents)} am {formatDate(b.current.date)}.
        </p>
      )}
      {b.status === 'cushion' && b.current && (
        <p>
          Kontostand {formatCents(b.current.balanceCents)} am {formatDate(b.current.date)}
          <small className="muted"> ({BALANCE_SOURCE_LABELS[b.current.source]})</small>
          {b.runwayMonths !== null && (
            <>
              {' '}
              – die Unterdeckung zehrt an diesem Polster; bei gleichbleibender Unterdeckung reicht es noch etwa{' '}
              <strong>
                {b.runwayMonths} Monat{b.runwayMonths === 1 ? '' : 'e'}
              </strong>
              .
            </>
          )}
          {b.changeCents !== null && b.changeSince && (
            <>
              {' '}
              Veränderung seit Ende {formatMonth(b.changeSince)}: {formatCents(b.changeCents, { sign: true })}.
            </>
          )}
        </p>
      )}
      {b.status === 'unknown' && (
        <p className="muted">Kein Kontostand bekannt – unten einen Kontostand mit Datum erfassen, dann wird der Verlauf berechnet.</p>
      )}

      {r ? (
        <div className="recommendation">
          <p>
            <strong>Empfehlung: Daueraufträge insgesamt {formatCents(r.recommendedCents)} je Monat</strong> (aktuell{' '}
            {formatCents(r.currentCents)},{' '}
            {r.changeCents > 0 ? (
              <span className="deficit">{formatCents(r.changeCents)} mehr</span>
            ) : r.changeCents < 0 ? (
              <span className="surplus">{formatCents(-r.changeCents)} weniger würden reichen</span>
            ) : (
              'passt'
            )}
            ).
          </p>
          <p className="hint">
            Ø Abbuchungen der letzten {r.basisMonths} vollständigen Monate {formatCents(r.averageExpensesCents)} + Puffer für
            schwankende Posten {formatCents(r.bufferCents)}
            {r.plannedMovesCents > 0 && <> + umzustellende Posten {formatCents(r.plannedMovesCents)}</>}, aufgerundet auf volle
            10 €. Der Puffer deckt einen Monat, der teurer ist als 4 von 5 Monaten.
          </p>
          {r.fluctuating.length > 0 && (
            <p className="hint">
              Stark schwankend:{' '}
              {r.fluctuating
                .map((i) => `${i.label} (${formatCents(i.minCents)} – ${formatCents(i.maxCents)}, Ø ${formatCents(i.averageCents)})`)
                .join(' · ')}
            </p>
          )}
        </div>
      ) : (
        months > 0 && <p className="hint">Für eine Empfehlung braucht es mindestens drei vollständig importierte Monate.</p>
      )}
    </div>
  );
}

function StandingOrders({ f }: { f: FundingAnalysis }) {
  if (f.standingOrders.length === 0) {
    return (
      <p>
        Keine Daueraufträge erkannt. Grundlage sind Umbuchungen aufs Konto – fehlen sie, bitte auf der Seite{' '}
        <a href={hrefFor('umbuchungen', { accountId: f.accountId })}>Umbuchungen</a> prüfen, ob die Überweisungen als
        Umbuchung erkannt sind.
      </p>
    );
  }
  const status = (o: StandingOrder) =>
    !o.active ? `beendet seit ${o.endedSince ? formatMonth(o.endedSince) : '?'}` : o.suspected ? 'vermutet (erst einmal gesehen)' : 'läuft';
  return (
    <>
      <table className="data">
        <thead>
          <tr>
            <th>Termin</th>
            <th>Von</th>
            <th className="num">Betrag</th>
            <th>Ausführungen</th>
            <th>Änderungen</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {f.standingOrders.map((o, i) => (
            <tr key={i} className={o.active ? undefined : 'inactive'}>
              <td>am {o.dayOfMonth}.</td>
              <td>{o.sourceAccountName ?? <span className="muted">unbekannt</span>}</td>
              <td className="num">{formatCents(o.amountCents)}</td>
              <td>
                {o.occurrences.length}× · {formatDate(o.firstDate)} – {formatDate(o.lastDate)}
              </td>
              <td>
                {o.changes.length === 0 ? (
                  <span className="muted">–</span>
                ) : (
                  o.changes.map((c) => (
                    <small key={c.date} className="block">
                      ab {formatDate(c.date)}: {formatCents(c.fromCents)} → {formatCents(c.toCents)}
                    </small>
                  ))
                )}
              </td>
              <td>{status(o)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={2}>Laufende Daueraufträge zusammen</th>
            <th className="num">{formatCents(f.standingOrdersTotalCents)}</th>
            <th colSpan={3} />
          </tr>
        </tfoot>
      </table>
      {f.extraTransferCount > 0 && (
        <p className="hint">
          {f.extraTransferCount} weitere Umbuchung(en) aufs Konto gehören zu keinem Dauerauftrag (Sonderüberweisungen) – in der
          Monatsübersicht unter „weitere Umbuchungen“. Sie gleichen eine Unterdeckung aus, ohne sie zu beheben.
        </p>
      )}
    </>
  );
}

function Months({ f }: { f: FundingAnalysis }) {
  const max = Math.max(1, ...f.months.map((m) => Math.abs(m.differenceCents)));
  return (
    <table className="data">
      <thead>
        <tr>
          <th>Monat</th>
          <th className="num">Daueraufträge</th>
          <th className="num">weitere Umbuchungen</th>
          <th className="num">Abbuchungen</th>
          <th className="num">Differenz</th>
          <th />
          <th className="num">Kontostand Monatsende</th>
        </tr>
      </thead>
      <tbody>
        {[...f.months].reverse().map((m) => {
          const hint = STATUS_HINTS[m.status];
          const range = { first: `${m.month}-01`, last: lastDayOf(m.month) };
          return (
            <tr key={m.month} className={hint ? 'incomplete' : undefined}>
              <td>
                {formatMonth(m.month)}
                {hint && (
                  <a className="warnings block" href={hrefFor('import', { accountId: f.accountId })}>
                    <small>{hint} – Werte unvollständig</small>
                  </a>
                )}
              </td>
              <td className="num">{formatCents(m.standingOrdersCents)}</td>
              <td className="num">{m.otherTransfersCents === 0 ? <span className="muted">–</span> : formatCents(m.otherTransfersCents, { sign: true })}</td>
              <td className="num">
                <a href={hrefFor('buchungen', { accountId: f.accountId, from: range.first, to: range.last, transfers: 'exclude' })}>
                  {formatCents(m.expensesCents)}
                </a>
                {m.creditsCents > 0 && <small className="muted block">davon {formatCents(m.creditsCents)} Erstattungen</small>}
              </td>
              <td className="num">
                <Difference cents={m.differenceCents} />
              </td>
              <td className="bar-cell">
                <span
                  className={`bar ${m.differenceCents < 0 ? 'bar-deficit' : 'bar-surplus'}`}
                  style={{ width: `${(Math.abs(m.differenceCents) / max) * 100}%` }}
                />
              </td>
              <td className="num">
                {m.balanceEndCents === null ? (
                  <span className="muted">–</span>
                ) : (
                  <span className={m.balanceEndCents < 0 ? 'deficit' : undefined}>{formatCents(m.balanceEndCents)}</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Causes({ f }: { f: FundingAnalysis }) {
  const c = f.causes;
  if (!c) return <p className="hint">Für einen Vergleich braucht es mindestens vier vollständig importierte Monate.</p>;
  const period = (months: string[]) =>
    months.length === 1 ? formatMonth(months[0] as string) : `${formatMonth(months[0] as string)} – ${formatMonth(months[months.length - 1] as string)}`;
  return (
    <>
      <p className="hint">
        Durchschnitt je Monat {period(c.recentMonths)} gegenüber {period(c.referenceMonths)}. Abbuchungen insgesamt:{' '}
        {formatCents(c.totalChangeCents, { sign: true })} je Monat.
      </p>
      {c.items.length === 0 ? (
        <p>Kein Posten ist um mehr als 5 € im Monat gestiegen.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Posten</th>
              <th className="num">vorher Ø</th>
              <th className="num">zuletzt Ø</th>
              <th className="num">Anstieg je Monat</th>
              <th>Hinweis</th>
            </tr>
          </thead>
          <tbody>
            {c.items.map((i) => (
              <tr key={i.key}>
                <td>
                  <a href={hrefFor('buchungen', { accountId: f.accountId, q: i.label, transfers: 'exclude' })}>{i.label}</a>
                </td>
                <td className="num">{formatCents(i.beforeCents)}</td>
                <td className="num">{formatCents(i.recentCents)}</td>
                <td className="num deficit">{formatCents(i.increaseCents, { sign: true })}</td>
                <td>
                  {i.isNew && 'neu'}
                  {i.priceChange && (
                    <>
                      teurer seit {formatDate(i.priceChange.date)}: {formatCents(i.priceChange.fromCents)} →{' '}
                      {formatCents(i.priceChange.toCents)}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function ManualBalances({ f, onChange }: { f: FundingAnalysis; onChange: () => void }) {
  const [date, setDate] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createManualBalance(f.accountId, { date, amount, notes: notes || null });
      setAmount('');
      setNotes('');
      onChange();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setError(null);
    try {
      await deleteManualBalance(id);
      onChange();
    } catch (err) {
      setError(message(err));
    }
  }

  return (
    <>
      <p className="hint">
        {f.hasBankBalances
          ? 'Dieses Konto liefert zu jeder Buchung einen Saldo – ein Kontostand von Hand ist nur für Zeiträume ohne Saldo nötig.'
          : 'Der Export dieses Kontos enthält keinen Saldo. Einen Kontostand mit Datum erfassen (Stand am Ende des Tages, z. B. aus dem Online-Banking) – der Verlauf wird daraus über die Buchungen vor- und zurückgerechnet. Über eine Importlücke hinweg wird nicht gerechnet.'}
      </p>
      <form className="panel inline-form" onSubmit={(e) => void submit(e)}>
        <label>
          Datum
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Kontostand (€)
          <input required inputMode="decimal" placeholder="1.234,56" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label>
          Notiz
          <input value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <div className="form-actions">
          <button type="submit" disabled={busy}>
            Kontostand speichern
          </button>
        </div>
      </form>
      {error && <p className="error">{error}</p>}
      {f.manualBalances.length > 0 && (
        <ul className="plain">
          {f.manualBalances.map((b) => (
            <li key={b.id}>
              {formatDate(b.date)}: {formatCents(b.balanceCents)}
              {b.notes && <span className="muted"> – {b.notes}</span>}{' '}
              <button type="button" className="link" onClick={() => void remove(b.id)}>
                löschen
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * Deckungsprüfung (CLAUDE.md § 12): Reicht der monatliche Dauerauftrag für
 * das, was tatsächlich vom Konto abgebucht wird? Für jedes Konto mit Rolle
 * „Ausgaben“ (per Dauerauftrag gespeist), dazu § 13.
 */
export function FundingPage({ params }: Props) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [funding, setFunding] = useState<FundingAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAccounts()
      .then(setAccounts)
      .catch((err: unknown) => setError(message(err)));
  }, []);

  const candidates = (accounts ?? []).filter((a) => a.role === 'ausgaben' && a.active);
  const requested = Number(params.get('accountId')) || undefined;
  const accountId = requested ?? candidates[0]?.id;

  const reload = useCallback(() => {
    if (accountId === undefined) return;
    fetchFunding(accountId)
      .then((f) => {
        setFunding(f);
        setError(null);
      })
      .catch((err: unknown) => setError(message(err)));
  }, [accountId]);
  useEffect(reload, [reload]);
  useDataChanged(reload);

  const changed = () => {
    reload();
    notifyDataChanged();
  };

  if (accounts === null) return error ? <p className="error">{error}</p> : <p>Lade…</p>;

  return (
    <section>
      <h2>Deckungsprüfung</h2>
      <p className="hint">
        Reicht der monatliche Dauerauftrag noch für das, was tatsächlich vom Konto abgebucht wird? Zufluss sind die
        erkannten Daueraufträge (Umbuchungen aufs Konto), Abfluss alle Abbuchungen ohne Umbuchungen abzüglich
        Erstattungen. Nur vollständig importierte Monate zählen für Verlauf und Empfehlung.
      </p>

      {candidates.length === 0 && !requested ? (
        <p className="panel">
          Kein aktives Konto mit der Rolle „Ausgaben“ angelegt. Die Rolle legt fest, welches Konto per Dauerauftrag
          gespeist wird – sie lässt sich auf der Seite <a href={hrefFor('konten')}>Konten</a> ändern.
        </p>
      ) : (
        candidates.length > 1 && (
          <div className="panel filter-form">
            <label>
              Konto
              <select
                value={accountId ?? ''}
                onChange={(e) => {
                  window.location.hash = hrefFor('deckung', { accountId: Number(e.target.value) || undefined });
                }}
              >
                {candidates.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )
      )}

      {error && <p className="error panel">{error}</p>}

      {funding && funding.accountId === accountId && (
        <>
          <h3>
            {funding.accountName}
            {funding.dataEnd && <small className="muted"> · importiert bis {formatDate(funding.dataEnd)}</small>}
          </h3>
          <Verdict f={funding} />

          <h3>Daueraufträge</h3>
          <StandingOrders f={funding} />

          <h3>Monatsverlauf</h3>
          <Months f={funding} />

          <h3>Was ist teurer geworden?</h3>
          <Causes f={funding} />

          <h3>Kontostand</h3>
          <ManualBalances f={funding} onChange={changed} />
        </>
      )}

      <BypassSection onChange={reload} />
    </section>
  );
}
