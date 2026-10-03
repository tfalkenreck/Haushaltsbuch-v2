import { useState } from 'react';
import type { Account } from '../api/accounts';
import type { Transaction } from '../api/transactions';
import { TRANSFER_KIND_LABELS } from '../lib/labels';
import { hrefFor } from '../lib/route';

interface Props {
  transaction: Transaction;
  accounts: Account[];
  busy: boolean;
  /** Von Hand als Umbuchung markieren; Gegenkonto optional. */
  onMark: (accountId: number | null) => void;
  /** „Keine Umbuchung“. */
  onUnmark: () => void;
  /** Handarbeit aufheben, die Erkennung darf wieder entscheiden. */
  onReset: () => void;
}

const NONE = 'none';

/**
 * Umbuchungs-Kennzeichen einer Buchung (CLAUDE.md § 10): sichtbar,
 * von Hand setzbar und aufhebbar.
 */
export function TransactionTransferCell({ transaction: t, accounts, busy, onMark, onUnmark, onReset }: Props) {
  const [choosing, setChoosing] = useState(false);
  const [target, setTarget] = useState<string>(NONE);
  const others = accounts.filter((a) => a.id !== t.accountId && a.active);

  if (t.transferId !== null && t.transferKind !== null) {
    return (
      <div className="transfer-cell">
        <a href={hrefFor('umbuchungen', { accountId: t.accountId })} className="transfer-tag">
          {t.transferKind === 'card_settlement' ? 'Kartenabrechnung' : 'Umbuchung'}
          {t.transferAccountName ? ` ${t.amountCents < 0 ? '→' : '←'} ${t.transferAccountName}` : ''}
        </a>
        <small className="muted block">
          {t.transferKind === 'one_sided' ? `${TRANSFER_KIND_LABELS.one_sided} · ` : ''}
          {t.transferStatus === 'suggested' ? 'vorgeschlagen' : t.transferSource === 'manual' ? 'von Hand' : 'bestätigt'}
          {' · '}
          <button type="button" className="link" disabled={busy} onClick={onUnmark} title="Zählt wieder als Einnahme bzw. Ausgabe">
            keine Umbuchung
          </button>
          {t.transferSource === 'manual' && (
            <>
              {' · '}
              <button type="button" className="link" disabled={busy} onClick={onReset} title="Die Erkennung darf diese Buchung wieder einordnen">
                Automatik zulassen
              </button>
            </>
          )}
        </small>
      </div>
    );
  }

  if (choosing) {
    return (
      <div className="transfer-cell">
        <select value={target} disabled={busy} onChange={(e) => setTarget(e.target.value)} aria-label="Gegenkonto">
          <option value={NONE}>Gegenkonto unbekannt</option>
          {others.map((a) => (
            <option key={a.id} value={a.id}>
              {t.amountCents < 0 ? 'nach' : 'von'} {a.name}
            </option>
          ))}
        </select>
        <small className="block">
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => {
              setChoosing(false);
              onMark(target === NONE ? null : Number(target));
            }}
          >
            als Umbuchung markieren
          </button>{' '}
          ·{' '}
          <button type="button" className="link" disabled={busy} onClick={() => setChoosing(false)}>
            abbrechen
          </button>
        </small>
      </div>
    );
  }

  return (
    <div className="transfer-cell">
      <button type="button" className="link" disabled={busy} onClick={() => setChoosing(true)} title="Geld zwischen eigenen Konten">
        Umbuchung?
      </button>
      {t.transferSource === 'manual' && (
        <small className="muted block">
          bewusst keine ·{' '}
          <button type="button" className="link" disabled={busy} onClick={onReset} title="Die Erkennung darf diese Buchung wieder einordnen">
            Automatik zulassen
          </button>
        </small>
      )}
    </div>
  );
}
