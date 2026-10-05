import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { fetchAccounts, type Account } from '../api/accounts';
import {
  createSavingsGoal,
  deleteSavingsGoal,
  fetchSavingsGoals,
  updateSavingsGoal,
  type SavingsGoal,
  type SavingsGoalInput,
  type SavingsOverview,
} from '../api/savings';
import { useDataChanged } from '../lib/events';
import { centsToInput, formatCents, formatDate, formatMonth, formatMonthCount } from '../lib/format';
import { hrefFor } from '../lib/route';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function GoalForm({
  accounts,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  accounts: Account[];
  initial: SavingsGoalInput;
  submitLabel: string;
  onSubmit: (input: SavingsGoalInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [input, setInput] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof SavingsGoalInput>(key: K, value: SavingsGoalInput[K]) => setInput((prev) => ({ ...prev, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(input);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="recurring-form panel" onSubmit={(e) => void submit(e)}>
      <label>
        Name
        <input value={input.name} onChange={(e) => set('name', e.target.value)} required maxLength={200} />
      </label>
      <label>
        Zielbetrag
        <input value={input.amount} onChange={(e) => set('amount', e.target.value)} placeholder="z. B. 5.000" required inputMode="decimal" />
      </label>
      <label>
        Wunschdatum (optional)
        <input type="date" value={input.targetDate ?? ''} onChange={(e) => set('targetDate', e.target.value || null)} />
      </label>
      <label>
        Priorität (1 = am wichtigsten)
        <input type="number" min={1} max={1000} value={input.priority} onChange={(e) => set('priority', Number(e.target.value) || 1)} />
      </label>
      <label>
        Stand aus Konto
        <select value={input.accountId ?? ''} onChange={(e) => set('accountId', Number(e.target.value) || null)}>
          <option value="">kein Konto (Stand 0)</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.role === 'sparen' ? ' (Sparkonto)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={input.active} onChange={(e) => set('active', e.target.checked)} /> aktiv
      </label>
      {error && <p className="error wide">{error}</p>}
      <p className="form-actions">
        <button type="submit" disabled={busy}>
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel}>
          Abbrechen
        </button>
      </p>
    </form>
  );
}

function PlanText({ goal, overview }: { goal: SavingsGoal; overview: SavingsOverview }) {
  const p = goal.plan;
  if (!p) return <span className="muted">inaktiv</span>;
  if (p.remainingCents === 0) return <strong className="surplus">erreicht</strong>;
  return (
    <>
      {p.monthsToReach === null ? (
        <span className="deficit">mit dem prognostizierten Überschuss nicht erreichbar</span>
      ) : (
        <>
          erreicht Ende {formatMonth(p.reachMonth as string)} ({formatMonthCount(p.monthsToReach)})
          {p.onTrack === true && <> <span className="tag tag-ok">rechtzeitig</span></>}
          {p.onTrack === false && <> <span className="tag tag-bad">zu spät</span></>}
        </>
      )}
      {p.neededMonthlyCents !== null && p.monthsAvailable !== null && (
        <small className="block">
          nötig für den Wunschtermin: {formatCents(p.neededMonthlyCents)} je Monat über {formatMonthCount(p.monthsAvailable)}
          {p.neededMonthlyCents > overview.surplusCents && <span className="deficit"> – mehr als der Überschuss</span>}
        </small>
      )}
      {goal.withoutSelected && (
        <small className="block">
          ohne die ausgewählten Abos:{' '}
          {goal.withoutSelected.monthsToReach === null ? (
            'weiterhin nicht erreichbar'
          ) : p.monthsToReach === null ? (
            <strong className="surplus">erreichbar Ende {formatMonth(goal.withoutSelected.reachMonth as string)}</strong>
          ) : goal.withoutSelected.monthsEarlier ? (
            <strong className="surplus">{formatMonthCount(goal.withoutSelected.monthsEarlier)} früher</strong>
          ) : (
            'nicht früher'
          )}
        </small>
      )}
    </>
  );
}

const emptyInput = (accounts: Account[], goals: SavingsGoal[]): SavingsGoalInput => {
  const savings = accounts.filter((a) => a.active && a.role === 'sparen');
  return {
    name: '',
    amount: '',
    targetDate: null,
    priority: Math.max(0, ...goals.map((g) => g.priority)) + 1,
    accountId: savings.length === 1 ? (savings[0] as Account).id : null,
    active: true,
  };
};

/**
 * Sparziele (CLAUDE.md § 15): mehrere Ziele nach Priorität gestaffelt, Stand
 * aus dem Sparkonto, nötige Monatsrate gegen den prognostizierten
 * Überschuss und die Rückkopplung zu den Abos.
 */
export function SavingsGoalsPage() {
  const [overview, setOverview] = useState<SavingsOverview | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [without, setWithout] = useState<number[] | undefined>(undefined);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchSavingsGoals(without)
      .then((o) => {
        setOverview(o);
        setError(null);
      })
      .catch((err: unknown) => setError(message(err)));
  }, [without]);
  useEffect(reload, [reload]);
  useDataChanged(reload);
  useEffect(() => {
    fetchAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);

  const toggle = (id: number) => {
    if (!overview) return;
    const selected = overview.subscriptions.filter((s) => s.selected).map((s) => s.id);
    setWithout(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  async function remove(goal: SavingsGoal) {
    if (!window.confirm(`Sparziel „${goal.name}“ löschen?`)) return;
    try {
      await deleteSavingsGoal(goal.id);
      reload();
    } catch (err) {
      setError(message(err));
    }
  }

  const o = overview;
  return (
    <section>
      <h2>Sparziele</h2>
      <p className="hint">
        Der Stand ergibt sich aus dem Guthaben des Kontos – mehrere Ziele auf einem Konto teilen es sich nach Priorität. Der
        prognostizierte Überschuss (siehe <a href={hrefFor('prognose')}>Prognose</a>) fließt erst ins wichtigste Ziel, dann ins nächste.
      </p>
      {error && <p className="error panel">{error}</p>}
      {o && (
        <>
          <div className="panel">
            <p>
              Prognostizierter Überschuss:{' '}
              <strong className={o.surplusCents < 0 ? 'deficit' : 'surplus'}>{formatCents(o.surplusCents, { sign: true })}</strong> je Monat
              (Ø der nächsten {o.forecastMonths} Monate)
              {o.neededTotalCents > 0 && (
                <>
                  {' '}
                  · nötige Raten aller Ziele mit Wunschtermin zusammen:{' '}
                  <strong className={o.neededTotalCents > o.surplusCents ? 'deficit' : undefined}>{formatCents(o.neededTotalCents)}</strong>
                </>
              )}
            </p>
            {o.accounts.map((a) => (
              <p key={a.accountId} className="hint">
                {a.accountName}:{' '}
                {a.balanceCents === null ? (
                  <span className="warnings">Kontostand unbekannt – Stand zählt als 0</span>
                ) : (
                  <>
                    {formatCents(a.balanceCents)} am {formatDate(a.balanceDate)}, davon {formatCents(a.allocatedCents)} den Zielen zugeteilt
                  </>
                )}
              </p>
            ))}
          </div>

          {editing === 'new' ? (
            <GoalForm
              accounts={accounts}
              initial={emptyInput(accounts, o.goals)}
              submitLabel="Anlegen"
              onCancel={() => setEditing(null)}
              onSubmit={async (input) => {
                await createSavingsGoal(input);
                setEditing(null);
                reload();
              }}
            />
          ) : (
            <div className="toolbar">
              <button type="button" onClick={() => setEditing('new')}>
                Sparziel anlegen
              </button>
            </div>
          )}

          {o.goals.length === 0 ? (
            <p className="muted">Noch keine Sparziele.</p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Prio</th>
                  <th>Ziel</th>
                  <th className="num">Betrag</th>
                  <th className="num">Stand</th>
                  <th>Wunschtermin</th>
                  <th>Plan</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {o.goals.map((g) =>
                  editing === g.id ? (
                    <tr key={g.id}>
                      <td colSpan={7}>
                        <GoalForm
                          accounts={accounts}
                          initial={{
                            name: g.name,
                            amount: centsToInput(g.targetCents),
                            targetDate: g.targetDate,
                            priority: g.priority,
                            accountId: g.accountId,
                            active: g.active,
                          }}
                          submitLabel="Speichern"
                          onCancel={() => setEditing(null)}
                          onSubmit={async (input) => {
                            await updateSavingsGoal(g.id, input);
                            setEditing(null);
                            reload();
                          }}
                        />
                      </td>
                    </tr>
                  ) : (
                    <tr key={g.id} className={g.active ? undefined : 'inactive'}>
                      <td>{g.priority}</td>
                      <td>
                        {g.name}
                        <small className="muted block">{g.accountName ?? 'kein Konto'}</small>
                      </td>
                      <td className="num">{formatCents(g.targetCents)}</td>
                      <td className="num">
                        {g.plan ? formatCents(g.plan.currentCents) : '–'}
                        {g.balanceUnknown && <small className="warnings block">Kontostand unbekannt</small>}
                      </td>
                      <td>{formatDate(g.targetDate)}</td>
                      <td>
                        <PlanText goal={g} overview={o} />
                      </td>
                      <td className="row-actions">
                        <button type="button" onClick={() => setEditing(g.id)}>
                          Bearbeiten
                        </button>
                        <button type="button" onClick={() => void remove(g)}>
                          Löschen
                        </button>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          )}

          <h3>Wenn Abos wegfallen …</h3>
          {o.subscriptions.length === 0 ? (
            <p className="hint">
              Keine Abos in der Prognose. Abos trägst du unter <a href={hrefFor('fixkosten')}>Fixkosten &amp; Abos</a> ein (Art „Abo“).
            </p>
          ) : (
            <div className="panel">
              <p className="hint">Ausgewählte Abos fallen in der Rechnung weg – der Plan oben zeigt, wie viel früher jedes Ziel erreicht wäre.</p>
              <ul className="plain">
                {o.subscriptions.map((s) => (
                  <li key={s.id}>
                    <label>
                      <input type="checkbox" checked={s.selected} onChange={() => toggle(s.id)} /> {s.name}{' '}
                      <span className="muted">{formatCents(s.monthlyCents)} je Monat</span>
                    </label>
                  </li>
                ))}
              </ul>
              <p>
                Ohne die ausgewählten Abos: <strong className="surplus">{formatCents(o.selectedMonthlyCents, { sign: true })}</strong> Überschuss
                je Monat.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
