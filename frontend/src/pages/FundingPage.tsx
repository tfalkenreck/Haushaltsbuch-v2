import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { fetchAccounts, type Account } from '../api/accounts';
import {
  createManualBalance,
  deleteManualBalance,
  fetchFunding,
  setFundingStart,
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

function Difference({ cents, inline = false, neutral = false }: { cents: number; inline?: boolean; neutral?: boolean }) {
  // Unvollständige Monate: Wert ohne Wertung – ein halber Monat ist weder gedeckt noch unterdeckt.
  if (neutral) return <span className="muted">{formatCents(cents, { sign: true })}</span>;
  if (cents === 0) return <span>{formatCents(0)}</span>;
  const label = cents < 0 ? 'Unterdeckung' : 'Überdeckung';
  return (
    <span className={cents < 0 ? 'deficit' : 'surplus'}>
      {formatCents(cents, { sign: true })}
      {inline ? ` (${label})` : <small className="block">{label}</small>}
    </span>
  );
}

const period = (months: string[]) =>
  months.length === 1 ? formatMonth(months[0] as string) : `${formatMonth(months[0] as string)} – ${formatMonth(months[months.length - 1] as string)}`;

/** Ab wann ausgewertet wird: letzte Umstellung der Daueraufträge oder von Hand, umschaltbar. */
function Evaluation({ f, onChange }: { f: FundingAnalysis; onChange: (f: FundingAnalysis) => void }) {
  const e = f.evaluation;
  const [error, setError] = useState<string | null>(null);
  const choices = f.months.filter((m) => m.status !== 'missing').map((m) => m.month);

  async function choose(value: string) {
    setError(null);
    try {
      onChange(await setFundingStart(f.accountId, value === '' ? null : value));
    } catch (err) {
      setError(message(err));
    }
  }

  const n = e.basisMonths.length;
  return (
    <div className="panel">
      <p>
        {e.source === 'switch' && e.detectedSwitch && (
          <>
            <strong>Ausgewertet ab {formatMonth(e.detectedSwitch.month)}:</strong> Da wurden die Daueraufträge umgestellt (
            {formatCents(e.detectedSwitch.fromCents)} → {formatCents(e.detectedSwitch.toCents)} je Monat). Monate davor
            beschreiben einen anderen Stand und zählen nicht für Verlauf, Empfehlung und Ursachen.
          </>
        )}
        {e.source === 'manual' && e.startMonth && (
          <>
            <strong>Ausgewertet ab {formatMonth(e.startMonth)}</strong> (von Hand festgelegt)
            {e.detectedSwitch && e.detectedSwitch.month !== e.startMonth && (
              <>
                {' '}
                – erkannt wäre die Umstellung im {formatMonth(e.detectedSwitch.month)} ({formatCents(e.detectedSwitch.fromCents)} →{' '}
                {formatCents(e.detectedSwitch.toCents)})
              </>
            )}
            .
          </>
        )}
        {e.source === 'all' && <>Keine Umstellung der Daueraufträge erkannt – ausgewertet werden alle vollständigen Monate (höchstens zwölf).</>}
      </p>
      {n > 0 && !e.sufficient && (
        <p className="warnings">
          {e.startMonth ? `Seit ${formatMonth(e.startMonth)}` : 'Bisher'} gibt es erst {n} vollständig importierte{n === 1 ? 'n' : ''} Monat
          {n === 1 ? '' : 'e'}. Für belastbare Durchschnitte und eine Empfehlung braucht es drei – die Aussagen unten sind vorläufig.
        </p>
      )}
      {n === 0 && e.startMonth && (
        <p className="warnings">
          Seit {formatMonth(e.startMonth)} gibt es noch keinen vollständig importierten Monat – Deckung und Empfehlung lassen sich
          noch nicht beurteilen.
        </p>
      )}
      <label className="inline">
        Auswertung ab{' '}
        <select value={e.manualStartMonth ?? ''} onChange={(ev) => void choose(ev.target.value)}>
          <option value="">
            automatisch{e.detectedSwitch ? ` (letzte Umstellung, ${formatMonth(e.detectedSwitch.month)})` : ' (alle Monate)'}
          </option>
          {choices.map((m) => (
            <option key={m} value={m}>
              {formatMonth(m)}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function Recommendation({ f }: { f: FundingAnalysis }) {
  const r = f.recommendation;
  const n = f.evaluation.basisMonths.length;
  if (!r) {
    return n > 0 ? (
      <p className="hint">
        Keine Empfehlung: Für einen belastbaren Durchschnitt braucht es mindestens drei vollständig importierte Monate
        {f.evaluation.startMonth ? ` seit ${formatMonth(f.evaluation.startMonth)}` : ''} (bisher {n}).
      </p>
    ) : null;
  }
  const since = period(f.evaluation.basisMonths);
  const plannedOnly = r.allMonthsCovered && r.balanceFalling !== true;
  return (
    <div className="recommendation">
      {r.verdict === 'fits' ? (
        <p>
          <strong className="surplus">Empfehlung: passt, keine Änderung nötig</strong> – die Daueraufträge von{' '}
          {formatCents(r.currentCents)} je Monat reichen.
        </p>
      ) : (
        <p>
          <strong>Empfehlung: Daueraufträge insgesamt {formatCents(r.recommendedCents)} je Monat</strong> (aktuell{' '}
          {formatCents(r.currentCents)}, <span className="deficit">{formatCents(r.changeCents)} mehr</span>).
        </p>
      )}
      {plannedOnly ? (
        <p className="hint">
          {since}: jeder Monat gedeckt, mindestens {formatCents(r.minSurplusCents ?? 0)} Überdeckung
          {r.balanceFalling === false ? ', der Kontostand ist nicht gefallen' : ' (Kontostand unbekannt)'}.
          {r.plannedMovesCents > 0 &&
            (r.verdict === 'increase' ? (
              <>
                {' '}
                Die umzustellenden Posten ({formatCents(r.plannedMovesCents)} je Monat) passen nicht mehr in die kleinste Überdeckung –
                daher die Erhöhung, aufgerundet auf volle 10 €.
              </>
            ) : (
              <> Die umzustellenden Posten ({formatCents(r.plannedMovesCents)} je Monat) passen noch in die kleinste Überdeckung.</>
            ))}
        </p>
      ) : (
        <p className="hint">
          Bedarf {formatCents(r.neededCents)}: Ø Abbuchungen {since} {formatCents(r.averageExpensesCents)} + Puffer{' '}
          {formatCents(r.bufferCents)}
          {r.plannedMovesCents > 0 && <> + umzustellende Posten {formatCents(r.plannedMovesCents)}</>}, aufgerundet auf volle 10 €.
          {r.balanceFalling && r.allMonthsCovered && <> Jeder Monat war gedeckt, der Kontostand ist aber gefallen.</>}
        </p>
      )}
      <p className="hint">
        Der Puffer kommt aus der Schwankung der monatlichen Abbuchungssumme ({formatCents(r.minExpensesCents)} bis{' '}
        {formatCents(r.maxExpensesCents)}): er deckt einen Monat, der teurer ist als 4 von 5 Monaten. Posten, die sich innerhalb
        eines Monats ausgleichen, kosten keinen Puffer.
      </p>
      {r.fluctuating.length > 0 && (
        <p className="hint">
          Stark schwankende Posten (zur Information):{' '}
          {r.fluctuating
            .map((i) => `${i.label} (${formatCents(i.minCents)} – ${formatCents(i.maxCents)}, Ø ${formatCents(i.averageCents)})`)
            .join(' · ')}
        </p>
      )}
    </div>
  );
}

/** Zusammenfassung: gedeckt? seit wann nicht? wächst es? was empfiehlt sich? */
function Verdict({ f }: { f: FundingAnalysis }) {
  const t = f.trend;
  const b = f.balance;
  const months = t.windowMonths.length;
  const directionText =
    t.direction === 'growing' ? 'und sie wird größer' : t.direction === 'shrinking' ? 'sie wird aber kleiner' : t.direction === 'steady' ? 'gleichbleibend' : '';
  const fits = f.recommendation?.verdict === 'fits';

  return (
    <div className={`panel verdict ${t.status === 'trend' ? 'verdict-bad' : t.status === 'single' && !fits ? 'verdict-warn' : 'verdict-ok'}`}>
      {t.status === 'unknown' && <p>Noch kein vollständig importierter Monat im Auswertungszeitraum – ohne vollständige Monate lässt sich die Deckung nicht beurteilen.</p>}
      {t.status === 'covered' && (
        <p>
          <strong>Gedeckt:</strong>{' '}
          {t.deficitMonthsInWindow === 0
            ? `${months === 1 ? 'Im' : 'In jedem der'} ${months === 1 ? '' : `${months} `}ausgewerteten Monat${months === 1 ? '' : 'e'} haben die Daueraufträge die Abbuchungen gedeckt.`
            : 'Im letzten vollständigen Monat haben die Daueraufträge die Abbuchungen gedeckt.'}
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
          {period(t.windowMonths)}: Daueraufträge Ø {formatCents(t.averageStandingOrdersCents ?? 0)}, Abbuchungen Ø{' '}
          {formatCents(t.averageExpensesCents ?? 0)}, Differenz Ø <Difference cents={t.averageDifferenceCents ?? 0} inline />
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
              Veränderung seit Ende {formatMonth(b.changeSince)}:{' '}
              <span className={b.changeCents < 0 ? 'deficit' : 'surplus'}>{formatCents(b.changeCents, { sign: true })}</span>.
            </>
          )}
        </p>
      )}
      {b.status === 'unknown' && (
        <p className="muted">Kein Kontostand bekannt – unten einen Kontostand mit Datum erfassen, dann wird der Verlauf berechnet.</p>
      )}

      <Recommendation f={f} />
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
  const max = Math.max(1, ...f.months.filter((m) => m.status === 'complete').map((m) => Math.abs(m.differenceCents)));
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
          const beforeStart = f.evaluation.startMonth !== null && m.month < f.evaluation.startMonth;
          return (
            <tr key={m.month} className={hint ? 'incomplete' : beforeStart ? 'inactive' : undefined}>
              <td>
                {formatMonth(m.month)}
                {hint && (
                  <a className="warnings block" href={hrefFor('import', { accountId: f.accountId })}>
                    <small>{hint} – Werte unvollständig</small>
                  </a>
                )}
                {beforeStart && !hint && <small className="muted block">vor der Umstellung – zählt nicht</small>}
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
                <Difference cents={m.differenceCents} neutral={hint !== null} />
              </td>
              <td className="bar-cell">
                {hint === null && (
                  <span
                    className={`bar ${m.differenceCents < 0 ? 'bar-deficit' : 'bar-surplus'}`}
                    style={{ width: `${(Math.abs(m.differenceCents) / max) * 100}%` }}
                  />
                )}
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
  if (!c) {
    const since = f.evaluation.startMonth ? ` seit ${formatMonth(f.evaluation.startMonth)}` : '';
    return (
      <p className="hint">
        Für einen Vergleich braucht es mindestens vier vollständig importierte Monate{since} (bisher {f.evaluation.basisMonths.length}).
        Monate vor einer Umstellung werden nicht verglichen – sie beschreiben einen anderen Stand.
      </p>
    );
  }
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
        Erstattungen. Für Verlauf, Empfehlung und Ursachen zählen nur vollständig importierte Monate seit der letzten
        Umstellung der Daueraufträge.
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
          <Evaluation f={funding} onChange={setFunding} />
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
