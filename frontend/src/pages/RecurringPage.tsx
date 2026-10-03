import { Fragment, useCallback, useEffect, useState } from 'react';
import { fetchAccounts, type Account } from '../api/accounts';
import { fetchCategories, type Category } from '../api/categories';
import {
  confirmSuggestion,
  createRecurring,
  deleteRecurring,
  dismissSuggestion,
  fetchRecurring,
  updateRecurring,
  type ItemCheck,
  type OccurrenceState,
  type RecurringItem,
  type RecurringItemInput,
  type RecurringKind,
  type RecurringOverview,
  type RecurringSuggestion,
} from '../api/recurring';
import { RecurringForm } from '../components/RecurringForm';
import { notifyDataChanged, useDataChanged } from '../lib/events';
import { addMonthsIso, centsToInput, formatCents, formatDate } from '../lib/format';
import { CHECK_STATUS_LABELS, INTERVAL_LABELS, NOTICE_UNIT_LABELS, RECURRING_KIND_LABELS } from '../lib/labels';
import { hrefFor } from '../lib/route';

interface Props {
  params: URLSearchParams;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const STATUS_CLASS: Record<ItemCheck['status'], string> = {
  ok: 'tag tag-ok',
  differs: 'tag tag-warn',
  missing: 'tag tag-bad',
  ended: 'tag tag-bad',
  no_bookings: 'tag tag-bad',
  not_due: 'tag',
  inactive: 'tag',
};

const OCCURRENCE_LABELS: Record<OccurrenceState, string> = {
  ok: 'passt',
  differs: 'Betrag weicht ab',
  missing: 'fehlt',
  not_imported: 'nicht importiert',
};

/** Erklärung zum Status des Soll/Ist-Abgleichs. */
function statusText(item: RecurringItem): string {
  const c = item.check;
  const missing = c.occurrences.find((o) => o.state === 'missing');
  switch (c.status) {
    case 'ok':
      return c.lastBooking ? `zuletzt ${formatDate(c.lastBooking.date)}` : '';
    case 'differs':
      return c.lastBooking ? `zuletzt ${formatCents(c.lastBooking.amountCents)} statt ${formatCents(item.amountCents)}` : '';
    case 'missing':
      return missing ? `erwartet am ${formatDate(missing.dueDate)} – verschoben, gekündigt oder anderes Konto?` : '';
    case 'ended':
      return c.lastBooking ? `seit ${formatDate(c.lastBooking.date)} keine Abbuchung mehr – beendet?` : '';
    case 'no_bookings':
      return 'keine passende Buchung gefunden – Konto nicht importiert oder andere Schreibweise der Gegenpartei?';
    case 'not_due':
      return 'im importierten Zeitraum noch nicht fällig';
    case 'inactive':
      return 'als beendet eingetragen';
  }
}

/** Offene Punkte, die Handlung erfordern. */
function Attention({ overview }: { overview: RecurringOverview }) {
  const points: { key: string; text: string }[] = [];
  for (const i of overview.items) {
    if (!i.active) continue;
    if (['missing', 'ended', 'no_bookings'].includes(i.check.status)) {
      points.push({ key: `s${i.id}`, text: `${i.name}: ${statusText(i)}` });
    }
    if (i.check.suggestedAmountCents !== null) {
      points.push({
        key: `p${i.id}`,
        text: `${i.name}: ${i.check.priceChange && i.check.priceChange.toCents > i.check.priceChange.fromCents ? 'teurer geworden' : 'Betrag geändert'} – zuletzt zweimal ${formatCents(i.check.suggestedAmountCents)} statt ${formatCents(i.amountCents)}`,
      });
    }
    const cancel = i.check.cancel;
    if (cancel && cancel.state === 'soon') {
      points.push({ key: `k${i.id}`, text: `${i.name}: kündbar bis ${formatDate(cancel.cancelBy)} (Vertragsende ${formatDate(cancel.contractEndDate)})` });
    }
    if (cancel && cancel.state === 'expired') {
      points.push({ key: `e${i.id}`, text: `${i.name}: Vertragsende ${formatDate(cancel.contractEndDate)} ist vorbei – verlängert? Datum anpassen.` });
    }
    if (i.duplicates.length > 0) points.push({ key: `d${i.id}`, text: `${i.name}: doppelt? Ähnlich: ${i.duplicates.join(', ')}` });
  }
  const fresh = overview.suggestions.filter((s) => !s.ended).length;
  if (fresh > 0) points.push({ key: 'new', text: `${fresh} erkannte${fresh === 1 ? 's' : ''} Abo/Fixkosten zum Prüfen (unten)` });
  if (points.length === 0) return null;
  return (
    <div className="panel warnings">
      <strong>Zu prüfen</strong>
      <ul className="attention">
        {points.map((p) => (
          <li key={p.key}>{p.text}</li>
        ))}
      </ul>
    </div>
  );
}

function CheckDetails({ item }: { item: RecurringItem }) {
  const c = item.check;
  return (
    <div>
      {c.scheduleFromBookings && (
        <p className="hint">Der eingetragene Termin passt nicht zu den Buchungen – abgeglichen wird nach dem Termin der letzten Buchung.</p>
      )}
      {c.occurrences.length === 0 ? (
        <p className="hint">Keine fälligen Termine im importierten Zeitraum.</p>
      ) : (
        <table className="data occurrences">
          <thead>
            <tr>
              <th>Termin</th>
              <th>Buchung</th>
              <th className="num">Betrag</th>
              <th>Abgleich</th>
            </tr>
          </thead>
          <tbody>
            {c.occurrences.map((o) => (
              <tr key={o.dueDate}>
                <td>{formatDate(o.dueDate)}</td>
                <td>{o.date ? formatDate(o.date) : <span className="muted">–</span>}</td>
                <td className="num">{o.amountCents === null ? '' : formatCents(o.amountCents)}</td>
                <td>
                  <span className={o.state === 'ok' ? 'tag tag-ok' : o.state === 'not_imported' ? 'tag' : o.state === 'differs' ? 'tag tag-warn' : 'tag tag-bad'}>
                    {OCCURRENCE_LABELS[o.state]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {c.extraBookings.length > 0 && (
        <p className="hint">
          Weitere zugeordnete Buchungen ohne Termin:{' '}
          {c.extraBookings.map((b) => `${formatDate(b.date)} ${formatCents(b.amountCents)}`).join(' · ')}
        </p>
      )}
      {c.priceChange && (
        <p className="hint">
          Betragsänderung ab {formatDate(c.priceChange.date)}: {formatCents(c.priceChange.fromCents)} → {formatCents(c.priceChange.toCents)}
        </p>
      )}
    </div>
  );
}

const toInput = (i: RecurringItem): RecurringItemInput => ({
  name: i.name,
  kind: i.kind,
  accountId: i.accountId,
  counterparty: i.counterparty,
  amount: centsToInput(i.amountCents),
  interval: i.interval,
  nextDueDate: i.check.nextDueDate ?? i.nextDueDate ?? '',
  contractEndDate: i.contractEndDate,
  noticePeriodValue: i.noticePeriodValue,
  noticePeriodUnit: i.noticePeriodUnit,
  categoryId: i.categoryId,
  creditorId: i.creditorId,
  mandateReference: i.mandateReference,
  active: i.active,
  notes: i.notes,
});

function Items({
  overview,
  accounts,
  categories,
  onChange,
}: {
  overview: RecurringOverview;
  accounts: Account[];
  categories: Category[];
  onChange: (o: RecurringOverview) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<RecurringOverview>) {
    setError(null);
    try {
      onChange(await action());
    } catch (err) {
      setError(message(err));
    }
  }

  if (overview.items.length === 0) {
    return <p className="hint">Noch nichts eingetragen. Oben von Hand anlegen oder unten einen Vorschlag übernehmen.</p>;
  }

  return (
    <>
      {error && <p className="error">{error}</p>}
      <table className="data">
        <thead>
          <tr>
            <th>Name</th>
            <th>Konto</th>
            <th className="num">Soll</th>
            <th>Intervall</th>
            <th className="num">je Monat</th>
            <th>Nächster Termin</th>
            <th>Soll/Ist</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {overview.items.map((i) => (
            <Fragment key={i.id}>
              <tr className={i.active ? undefined : 'inactive'}>
                <td>
                  {i.name} <span className="tag">{RECURRING_KIND_LABELS[i.kind]}</span>
                  {i.isSuspected && <span className="tag tag-warn">vermutet</span>}
                  {i.categoryPath && <small className="muted block">{i.categoryPath}</small>}
                  {i.check.cancel && (
                    <small className={`block ${i.check.cancel.state === 'soon' ? 'deficit' : 'muted'}`}>
                      Vertragsende {formatDate(i.check.cancel.contractEndDate)}
                      {i.noticePeriodValue !== null && i.noticePeriodUnit !== null && (
                        <>
                          , Kündigungsfrist {i.noticePeriodValue} {NOTICE_UNIT_LABELS[i.noticePeriodUnit]} → kündbar bis{' '}
                          {formatDate(i.check.cancel.cancelBy)}
                        </>
                      )}
                      {i.check.cancel.state === 'passed' && ' (Frist verstrichen)'}
                      {i.check.cancel.state === 'expired' && ' (vorbei – verlängert?)'}
                    </small>
                  )}
                  {i.duplicates.length > 0 && <small className="warnings block">doppelt? ähnlich: {i.duplicates.join(', ')}</small>}
                </td>
                <td>{i.accountName ?? <span className="muted">beliebig</span>}</td>
                <td className="num">{formatCents(i.amountCents)}</td>
                <td>{INTERVAL_LABELS[i.interval]}</td>
                <td className="num">{formatCents(i.monthlyCents)}</td>
                <td>{formatDate(i.check.nextDueDate ?? i.nextDueDate)}</td>
                <td>
                  <span className={STATUS_CLASS[i.check.status]}>{CHECK_STATUS_LABELS[i.check.status]}</span>
                  <small className="muted block">{statusText(i)}</small>
                  {i.check.suggestedAmountCents !== null && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => void run(() => updateRecurring(i.id, { ...toInput(i), amount: centsToInput(i.check.suggestedAmountCents as number) }))}
                    >
                      Soll auf {formatCents(i.check.suggestedAmountCents)} setzen
                    </button>
                  )}
                </td>
                <td className="row-actions">
                  <button type="button" className="link" onClick={() => setOpen(open === i.id ? null : i.id)}>
                    {open === i.id ? 'Abgleich zu' : 'Abgleich'}
                  </button>{' '}
                  · <a href={hrefFor('buchungen', { recurringItemId: i.id })}>{i.bookingCount} Buchungen</a> ·{' '}
                  <button type="button" className="link" onClick={() => setEditing(editing === i.id ? null : i.id)}>
                    bearbeiten
                  </button>{' '}
                  ·{' '}
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      if (window.confirm(`„${i.name}“ löschen? Von Hand zugeordnete Buchungen werden wieder frei.`)) void run(() => deleteRecurring(i.id));
                    }}
                  >
                    löschen
                  </button>
                </td>
              </tr>
              {open === i.id && (
                <tr>
                  <td colSpan={8}>
                    <CheckDetails item={i} />
                  </td>
                </tr>
              )}
              {editing === i.id && (
                <tr>
                  <td colSpan={8}>
                    <RecurringForm
                      accounts={accounts}
                      categories={categories}
                      initial={toInput(i)}
                      editing
                      submitLabel="Speichern"
                      onCancel={() => setEditing(null)}
                      onSubmit={async (input) => {
                        onChange(await updateRecurring(i.id, input));
                        setEditing(null);
                      }}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Suggestions({ overview, onChange }: { overview: RecurringOverview; onChange: (o: RecurringOverview) => void }) {
  const [kinds, setKinds] = useState<Record<string, RecurringKind>>({});
  const [error, setError] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);

  async function run(action: () => Promise<RecurringOverview>) {
    setError(null);
    try {
      onChange(await action());
    } catch (err) {
      setError(message(err));
    }
  }

  const running = overview.suggestions.filter((s) => !s.ended);
  const ended = overview.suggestions.filter((s) => s.ended);

  const table = (list: RecurringSuggestion[]) => (
    <table className="data">
      <thead>
        <tr>
          <th>Gegenpartei</th>
          <th>Konto</th>
          <th className="num">Betrag</th>
          <th>Intervall</th>
          <th className="num">je Monat</th>
          <th>Gesehen</th>
          <th>Hinweise</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {list.map((s) => (
          <tr key={s.key}>
            <td>
              {s.label}
              {s.categoryPath && <small className="muted block">{s.categoryPath}</small>}
            </td>
            <td>{s.accountName}</td>
            <td className="num">{formatCents(s.lastAmountCents)}</td>
            <td>{INTERVAL_LABELS[s.interval]}</td>
            <td className="num">{formatCents(s.monthlyCents)}</td>
            <td>
              {s.count}× · {formatDate(s.firstDate)} – {formatDate(s.lastDate)}
            </td>
            <td>
              {s.suspected && <small className="block">vermutet (einzelner Jahresbeitrag)</small>}
              {s.priceChange && (
                <small className="block deficit">
                  {s.priceChange.toCents > s.priceChange.fromCents ? 'teurer' : 'geändert'} seit {formatDate(s.priceChange.date)}:{' '}
                  {formatCents(s.priceChange.fromCents)} → {formatCents(s.priceChange.toCents)}
                </small>
              )}
              {s.duplicates.length > 0 && <small className="block warnings">doppelt? ähnlich: {s.duplicates.join(', ')}</small>}
              {s.ended && <small className="block muted">seit {formatDate(s.lastDate)} keine Abbuchung mehr</small>}
            </td>
            <td className="row-actions">
              <select
                aria-label="Art"
                value={kinds[s.key] ?? s.kind}
                onChange={(e) => setKinds({ ...kinds, [s.key]: e.target.value as RecurringKind })}
              >
                {(Object.keys(RECURRING_KIND_LABELS) as RecurringKind[]).map((k) => (
                  <option key={k} value={k}>
                    {RECURRING_KIND_LABELS[k]}
                  </option>
                ))}
              </select>{' '}
              <button type="button" onClick={() => void run(async () => (await confirmSuggestion({ key: s.key, kind: kinds[s.key] ?? s.kind })).overview)}>
                Übernehmen
              </button>
              <button type="button" className="secondary" onClick={() => void run(() => dismissSuggestion(s.key))}>
                Verwerfen
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      {error && <p className="error">{error}</p>}
      {running.length === 0 ? <p className="hint">Keine neuen Vorschläge.</p> : table(running)}
      {ended.length > 0 && (
        <p>
          <button type="button" className="link" onClick={() => setShowEnded(!showEnded)}>
            {ended.length} beendete erkannt{showEnded ? ' – ausblenden' : ' – anzeigen'}
          </button>
        </p>
      )}
      {showEnded && ended.length > 0 && table(ended)}
      {overview.dismissed.length > 0 && (
        <details>
          <summary>{overview.dismissed.length} verworfene Vorschläge</summary>
          <ul className="plain">
            {overview.dismissed.map((d) => (
              <li key={d.id}>
                {d.name} · {formatCents(d.amountCents)} {INTERVAL_LABELS[d.interval]}{' '}
                <button type="button" className="link" onClick={() => void run(() => deleteRecurring(d.id))}>
                  wieder vorschlagen
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/** Vorbelegung aus einer Buchung („als wiederkehrend anlegen“ in der Buchungsliste). */
function prefillFrom(params: URLSearchParams): Partial<RecurringItemInput> | null {
  const date = params.get('date');
  const amount = params.get('amount');
  if (!date || !amount) return null;
  return {
    counterparty: params.get('counterparty') ?? '',
    amount,
    accountId: Number(params.get('accountId')) || null,
    nextDueDate: addMonthsIso(date, 1),
    interval: 'monthly',
  };
}

/**
 * Fixkosten und Abos (CLAUDE.md § 14): von Hand anlegen ist der Hauptweg,
 * die Erkennung schlägt nur vor. Soll/Ist-Abgleich zeigt fehlende
 * Abbuchungen, Preiserhöhungen, beendete und doppelte Abos.
 */
export function RecurringPage({ params }: Props) {
  const [overview, setOverview] = useState<RecurringOverview | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const prefill = prefillFrom(params);
  const [creating, setCreating] = useState(prefill !== null);

  const reload = useCallback(() => {
    fetchRecurring()
      .then((o) => {
        setOverview(o);
        setError(null);
      })
      .catch((err: unknown) => setError(message(err)));
  }, []);
  useEffect(reload, [reload]);
  useDataChanged(reload);
  useEffect(() => {
    Promise.all([fetchAccounts(), fetchCategories()])
      .then(([a, c]) => {
        setAccounts(a);
        setCategories(c);
      })
      .catch((err: unknown) => setError(message(err)));
  }, []);

  const changed = (o: RecurringOverview) => {
    setOverview(o);
    notifyDataChanged();
  };

  return (
    <section>
      <h2>Fixkosten &amp; Abos</h2>
      <p className="hint">
        Fixkosten und Abos von Hand eintragen ist der Hauptweg. Die Erkennung schlägt nach jedem Import wiederkehrende
        Abbuchungen vor – übernommen wird nur, was du bestätigst. Umbuchungen zwischen eigenen Konten zählen nie.
      </p>
      {error && <p className="error panel">{error}</p>}

      {overview && (
        <>
          <p className="summary">
            {overview.totals.count} laufende Posten · zusammen <strong>{formatCents(overview.totals.monthlyCents)}</strong> je Monat
            (Fixkosten {formatCents(overview.totals.fixedCostMonthlyCents)}, Abos {formatCents(overview.totals.subscriptionMonthlyCents)})
          </p>
          <Attention overview={overview} />

          <h3>Eingetragen</h3>
          {creating ? (
            <RecurringForm
              key={params.toString()}
              accounts={accounts}
              categories={categories}
              initial={prefill ?? {}}
              submitLabel="Anlegen"
              onCancel={() => setCreating(false)}
              onSubmit={async (input) => {
                changed((await createRecurring(input)).overview);
                setCreating(false);
                if (prefill) window.location.hash = hrefFor('fixkosten');
              }}
            />
          ) : (
            <div className="toolbar">
              <button type="button" onClick={() => setCreating(true)}>
                Fixkosten/Abo von Hand anlegen
              </button>
            </div>
          )}
          <Items overview={overview} accounts={accounts} categories={categories} onChange={changed} />

          <h3>Vorschläge der Erkennung</h3>
          <Suggestions overview={overview} onChange={changed} />
        </>
      )}
    </section>
  );
}
