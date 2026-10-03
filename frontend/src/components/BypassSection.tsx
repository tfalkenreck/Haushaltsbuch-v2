import { useCallback, useEffect, useState } from 'react';
import { fetchBypass, setBypassDecision, type BypassDecision, type BypassItem, type BypassOverview } from '../api/funding';
import { useDataChanged } from '../lib/events';
import { formatCents, formatDate } from '../lib/format';
import { INTERVAL_LABELS } from '../lib/labels';
import { hrefFor } from '../lib/route';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface Props {
  /** Nach einer Entscheidung: die Empfehlung der Deckungsprüfung ändert sich. */
  onChange: () => void;
}

/**
 * Ausgaben am Ausgabenkonto vorbei (CLAUDE.md § 13): wiederkehrende
 * Abbuchungen, die noch vom Einnahmenkonto laufen. Pro Posten wird
 * entschieden, damit die Liste nicht jeden Monat dieselben Fälle zeigt.
 */
export function BypassSection({ onChange }: Props) {
  const [overview, setOverview] = useState<BypassOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [showDecided, setShowDecided] = useState(false);

  const reload = useCallback(() => {
    fetchBypass()
      .then(setOverview)
      .catch((err: unknown) => setError(message(err)));
  }, []);
  useEffect(reload, [reload]);
  useDataChanged(reload);

  async function decide(item: BypassItem, decision: BypassDecision | null, targetAccountId?: number | null) {
    setBusyKey(item.key);
    setError(null);
    try {
      setOverview(
        await setBypassDecision({
          sourceAccountId: item.sourceAccountId,
          key: item.key,
          decision,
          targetAccountId: targetAccountId ?? item.targetAccountId,
        }),
      );
      onChange();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusyKey(null);
    }
  }

  if (!overview) return error ? <p className="error panel">{error}</p> : null;

  const active = overview.items.filter((i) => i.status === 'active');
  const open = active.filter((i) => i.decision === null);
  const moves = active.filter((i) => i.decision === 'move');
  const kept = active.filter((i) => i.decision === 'keep');
  const done = overview.items.filter((i) => i.status !== 'active');

  const row = (item: BypassItem) => (
    <tr key={`${item.sourceAccountId}-${item.key}`}>
      <td>
        <a href={hrefFor('buchungen', { accountId: item.sourceAccountId, q: item.label, transfers: 'exclude' })}>{item.label}</a>
        <small className="muted block">
          {item.sourceAccountName}
          {item.categoryPath ? ` · ${item.categoryPath}` : ''}
        </small>
      </td>
      <td className="num">{formatCents(item.lastAmountCents)}</td>
      <td>
        {INTERVAL_LABELS[item.interval]}
        <small className="muted block">
          {item.count}× seit {formatDate(item.firstDate)}, nächste ca. {formatDate(item.nextDueDate)}
        </small>
      </td>
      <td className="num">{formatCents(item.monthlyCents)}</td>
      <td className="row-actions">
        {item.decision === null ? (
          <>
            <button type="button" disabled={busyKey !== null} onClick={() => void decide(item, 'move')}>
              Soll umgestellt werden
            </button>
            <button type="button" disabled={busyKey !== null} onClick={() => void decide(item, 'keep')}>
              Bleibt bewusst hier
            </button>
          </>
        ) : (
          <>
            {item.decision === 'move' && overview.targets.length > 1 && (
              <select
                value={item.targetAccountId ?? ''}
                disabled={busyKey !== null}
                onChange={(e) => void decide(item, 'move', Number(e.target.value) || null)}
              >
                <option value="">Ziel wählen…</option>
                {overview.targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}{' '}
            <button type="button" disabled={busyKey !== null} onClick={() => void decide(item, null)}>
              Zurücknehmen
            </button>
          </>
        )}
      </td>
    </tr>
  );

  const table = (items: BypassItem[]) => (
    <table className="data">
      <thead>
        <tr>
          <th>Gegenpartei</th>
          <th className="num">Betrag</th>
          <th>Intervall</th>
          <th className="num">je Monat</th>
          <th />
        </tr>
      </thead>
      <tbody>{items.map(row)}</tbody>
    </table>
  );

  return (
    <section>
      <h3>Ausgaben am Ausgabenkonto vorbei</h3>
      <p className="hint">
        Wiederkehrende Abbuchungen, die noch direkt vom Einnahmenkonto laufen (Versicherung, Telefon, Abo,
        Mitgliedschaft …). Pro Posten festhalten, ob er aufs Ausgabenkonto umziehen soll oder bewusst bleibt – dann
        erscheint er hier nicht mehr als offen. Bargeld und Umbuchungen sind ausgenommen.
      </p>
      {error && <p className="error panel">{error}</p>}

      {overview.plannedIncreases.map((p) => (
        <p key={p.accountId} className="panel notice">
          Für {p.count} umzustellende(n) Posten müsste der Dauerauftrag auf „{p.accountName}“ um{' '}
          <strong>{formatCents(p.monthlyCents)}</strong> je Monat steigen. Das ist in der Empfehlung oben enthalten.
        </p>
      ))}
      {overview.unassignedMoves > 0 && (
        <p className="panel notice warnings">
          {overview.unassignedMoves} umzustellende(r) Posten ohne Zielkonto – bitte unten ein Ausgabenkonto wählen.
        </p>
      )}

      {overview.items.length === 0 && <p>Keine wiederkehrenden Abbuchungen auf Einnahmenkonten gefunden.</p>}

      {open.length > 0 && (
        <>
          <h4>Offen ({open.length})</h4>
          {table(open)}
        </>
      )}
      {moves.length > 0 && (
        <>
          <h4>Soll umgestellt werden ({moves.length})</h4>
          {table(moves)}
        </>
      )}
      {kept.length > 0 && (
        <p>
          <button type="button" className="link" onClick={() => setShowDecided((v) => !v)}>
            {showDecided ? 'Ausblenden' : `${kept.length} Posten bleiben bewusst auf dem Einnahmenkonto – anzeigen`}
          </button>
        </p>
      )}
      {showDecided && kept.length > 0 && table(kept)}

      {done.length > 0 && (
        <>
          <h4>Umgestellt oder beendet</h4>
          <ul className="plain">
            {done.map((item) => (
              <li key={`${item.sourceAccountId}-${item.key}`}>
                {item.label} ({formatCents(item.lastAmountCents)} {INTERVAL_LABELS[item.interval]}):{' '}
                {item.switchedTo
                  ? `seit ${formatDate(item.switchedTo.date)} auf „${item.switchedTo.accountName}“ – zählt dort, nicht doppelt.`
                  : `letzte Abbuchung ${formatDate(item.lastDate)}, seitdem keine mehr.`}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
