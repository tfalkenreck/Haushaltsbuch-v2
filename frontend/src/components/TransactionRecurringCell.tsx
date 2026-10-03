import { useState } from 'react';
import type { RecurringItem } from '../api/recurring';
import type { Transaction } from '../api/transactions';
import { centsToInput } from '../lib/format';
import { hrefFor } from '../lib/route';

interface Props {
  transaction: Transaction;
  /** Übernommene Posten zur Auswahl. */
  items: RecurringItem[];
  busy: boolean;
  /** Von Hand einem Posten zuordnen; `null` = „nicht wiederkehrend“. */
  onSet: (itemId: number | null) => void;
  /** Handarbeit aufheben – wieder automatisch über die Merkmale der Posten. */
  onReset: () => void;
}

/**
 * Fixkosten/Abo einer Buchung (CLAUDE.md § 14): jede Abbuchung lässt sich
 * von Hand als wiederkehrend markieren, eine Fehlerkennung lässt sich
 * entfernen.
 */
export function TransactionRecurringCell({ transaction: t, items, busy, onSet, onReset }: Props) {
  const [choosing, setChoosing] = useState(false);
  if (t.amountCents >= 0 || t.transferId !== null) return null;

  const createHref = hrefFor('fixkosten', {
    counterparty: t.counterparty,
    amount: centsToInput(-t.amountCents),
    date: t.bookingDate,
    accountId: t.accountId,
  });

  if (choosing) {
    return (
      <div className="transfer-cell">
        <select
          defaultValue=""
          disabled={busy}
          aria-label="Fixkosten/Abo"
          onChange={(e) => {
            if (e.target.value === '') return;
            setChoosing(false);
            onSet(Number(e.target.value));
          }}
        >
          <option value="">Posten wählen…</option>
          {items
            .filter((i) => i.active)
            .map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
        </select>
        <small className="block">
          <a href={createHref}>neu anlegen</a> ·{' '}
          <button type="button" className="link" disabled={busy} onClick={() => setChoosing(false)}>
            abbrechen
          </button>
        </small>
      </div>
    );
  }

  if (t.recurringItemId !== null) {
    return (
      <div className="transfer-cell">
        <a className="recurring-tag" href={hrefFor('fixkosten')}>
          {t.recurringItemName}
        </a>
        <small className="muted block">
          {t.recurringSource === 'manual' ? 'von Hand · ' : ''}
          <button type="button" className="link" disabled={busy} onClick={() => onSet(null)} title="Diese Buchung gehört nicht dazu">
            gehört nicht dazu
          </button>
          {t.recurringSource === 'manual' && (
            <>
              {' · '}
              <button type="button" className="link" disabled={busy} onClick={onReset}>
                Automatik zulassen
              </button>
            </>
          )}
        </small>
      </div>
    );
  }

  return (
    <div className="transfer-cell">
      <button type="button" className="link" disabled={busy} onClick={() => setChoosing(true)} title="Als Fixkosten oder Abo markieren">
        wiederkehrend?
      </button>
      {t.recurringSource === 'manual' && (
        <small className="muted block">
          bewusst nicht ·{' '}
          <button type="button" className="link" disabled={busy} onClick={onReset}>
            Automatik zulassen
          </button>
        </small>
      )}
    </div>
  );
}
