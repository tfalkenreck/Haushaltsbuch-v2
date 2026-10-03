import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { fetchAccounts, type Account } from '../api/accounts';
import {
  confirmOwnIbanPairs,
  confirmTransfer,
  detectTransfers,
  dissolveTransfer,
  fetchOwnIbanPairCount,
  fetchTransfers,
  type Transfer,
  type TransferStatus,
} from '../api/transfers';
import { notifyDataChanged } from '../lib/events';
import { formatCents, formatDate } from '../lib/format';
import { TRANSFER_KIND_LABELS } from '../lib/labels';
import { hrefFor } from '../lib/route';

interface Props {
  params: URLSearchParams;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function statusFromParams(params: URLSearchParams): TransferStatus | undefined {
  const value = params.get('status');
  return value === 'suggested' || value === 'confirmed' ? value : undefined;
}

/** Was an einer Umbuchung auffällt: fehlende Seite, Abweichung der Kartenabrechnung. */
function Check({ transfer: t }: { transfer: Transfer }) {
  const hints: ReactNode[] = [];
  if (t.kind === 'one_sided') {
    hints.push(
      <span key="one" className="warnings block">
        Gegenbuchung nicht importiert{t.fromAccountName === null || t.toAccountName === null ? ' (Gegenkonto unbekannt)' : ''}
      </span>,
    );
  }
  if (t.kind === 'card_settlement') {
    const cardSide = t.transactions.some((x) => x.accountId === t.toAccountId);
    if (t.counterMissing) {
      hints.push(
        <span key="side" className="warnings block">
          {cardSide ? 'Abbuchung vom Girokonto nicht importiert' : 'Ausgleich auf dem Kartenkonto nicht importiert'}
        </span>,
      );
    }
    if (t.card) {
      const byBankDate = t.periodBasis === 'bank_booking_date';
      const link = hrefFor('buchungen', {
        accountId: t.toAccountId ?? undefined,
        from: t.periodStart ?? undefined,
        to: t.periodEnd ?? undefined,
        dateBasis: byBankDate ? 'bank' : undefined,
        transfers: 'exclude',
      });
      hints.push(
        <span key="card" className="block">
          <a href={link}>
            {t.card.purchaseCount} Kartenumsätze {formatDate(t.periodStart)} – {formatDate(t.periodEnd)}
          </a>
          : {formatCents(t.card.purchasesCents)}
          <span className="muted block">
            {byBankDate
              ? `nach Buchungstag der Bank, Abrechnung vom ${formatDate(t.periodEnd)}`
              : 'nach Kaufdatum (kein Abrechnungsdatum im Text)'}
          </span>
        </span>,
      );
      hints.push(
        t.card.differenceCents === 0 ? (
          <span key="ok" className="amount-in block">
            Summe stimmt mit der Abbuchung überein.
          </span>
        ) : (
          <span key="diff" className="warnings block">
            Abweichung {formatCents(t.card.differenceCents, { sign: true })} – fehlt ein Kartenimport oder ein Umsatz?
          </span>
        ),
      );
    }
  }
  return hints.length > 0 ? <>{hints}</> : <span className="muted">–</span>;
}

/**
 * Alle erkannten und von Hand gesetzten Umbuchungen (CLAUDE.md § 10, § 11).
 * Umbuchungen zählen nirgends als Einnahme oder Ausgabe – deshalb müssen
 * Fehlerkennungen hier auffallen, sonst verschwindet eine echte Ausgabe.
 */
export function TransfersPage({ params }: Props) {
  const status = statusFromParams(params);
  const accountId = Number(params.get('accountId')) || undefined;
  const [transfers, setTransfers] = useState<Transfer[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ownIbanPairs, setOwnIbanPairs] = useState(0);

  const reload = useCallback(() => {
    fetchTransfers({ status, accountId })
      .then(setTransfers)
      .catch((err: unknown) => setError(message(err)));
    fetchOwnIbanPairCount()
      .then((r) => setOwnIbanPairs(r.count))
      .catch((err: unknown) => setError(message(err)));
  }, [status, accountId]);

  useEffect(reload, [reload]);
  useEffect(() => {
    fetchAccounts()
      .then(setAccounts)
      .catch((err: unknown) => setError(message(err)));
  }, []);

  const navigate = (next: { status?: TransferStatus | undefined; accountId?: number | undefined }) => {
    window.location.hash = hrefFor('umbuchungen', { status, accountId, ...next });
  };

  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const text = await action();
      if (text) setInfo(text);
      reload();
      notifyDataChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  function handleDissolve(t: Transfer) {
    const ok = window.confirm(
      `Umbuchung über ${formatCents(t.amountCents)} aufheben?\n` +
        'Die Buchungen zählen dann wieder als Einnahme bzw. Ausgabe und werden nicht erneut als Umbuchung vorgeschlagen.',
    );
    if (!ok) return;
    void run(async () => {
      const result = await dissolveTransfer(t.id);
      return `Umbuchung aufgehoben, ${result.released} Buchung(en) zählen wieder.`;
    });
  }

  function handleConfirmOwnIban() {
    const ok = window.confirm(
      `${ownIbanPairs} vorgeschlagene(s) Paar(e) bestätigen?\n` +
        'Betroffen sind nur Paare, bei denen eine Seite die IBAN des anderen eigenen Kontos als Gegen-IBAN nennt.',
    );
    if (!ok) return;
    void run(async () => {
      const result = await confirmOwnIbanPairs();
      return `${result.confirmed} Paar(e) bestätigt.`;
    });
  }

  const suggested = transfers?.filter((t) => t.status === 'suggested').length ?? 0;
  const mismatches = transfers?.filter((t) => t.card !== null && t.card.differenceCents !== 0).length ?? 0;

  return (
    <section>
      <h2>Umbuchungen</h2>
      <p className="hint">
        Geld zwischen eigenen Konten ist weder Einnahme noch Ausgabe. Erkannt werden Paare (gleicher Betrag, umgekehrtes
        Vorzeichen, wenige Tage Abstand), vermutete Umbuchungen ohne importierte Gegenbuchung (eigene IBAN oder
        Verwendungszweck) und Kartenabrechnungen. Erkanntes ist <em>vorgeschlagen</em>: bitte prüfen, bestätigen oder
        aufheben. Kategorien werden dabei nie verändert.
      </p>

      <div className="panel filter-form">
        <label>
          Status
          <select
            value={status ?? ''}
            onChange={(e) => navigate({ status: (e.target.value || undefined) as TransferStatus | undefined })}
          >
            <option value="">alle</option>
            <option value="suggested">vorgeschlagen</option>
            <option value="confirmed">bestätigt</option>
          </select>
        </label>
        <label>
          Konto
          <select value={accountId ?? ''} onChange={(e) => navigate({ accountId: Number(e.target.value) || undefined })}>
            <option value="">alle Konten</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <div className="form-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await detectTransfers();
                return `${r.created} neue Umbuchung(en) erkannt, ${r.completed} um die Gegenbuchung ergänzt.`;
              })
            }
          >
            Erkennung jetzt ausführen
          </button>
          <button type="button" disabled={busy || ownIbanPairs === 0} onClick={handleConfirmOwnIban}>
            Alle Paare bestätigen, deren Gegen-IBAN ein eigenes Konto ist ({ownIbanPairs})
          </button>
        </div>
      </div>

      {error && <p className="error panel">{error}</p>}
      {info && <p className="panel notice">{info}</p>}

      {transfers && (suggested > 0 || mismatches > 0) && (
        <p className="panel notice warnings">
          {suggested > 0 && <>{suggested} Umbuchung(en) vorgeschlagen – bitte prüfen. </>}
          {mismatches > 0 && <>{mismatches} Kartenabrechnung(en) passen nicht zur Summe der Kartenumsätze.</>}
        </p>
      )}

      {transfers && transfers.length === 0 && <p>Keine Umbuchungen gefunden.</p>}

      {transfers && transfers.length > 0 && (
        <table className="data">
          <thead>
            <tr>
              <th>Datum</th>
              <th>Art</th>
              <th>Von → Nach</th>
              <th className="num">Betrag</th>
              <th>Buchungen</th>
              <th>Erkannt</th>
              <th>Prüfung</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {transfers.map((t) => (
              <tr key={t.id}>
                <td>{formatDate(t.date)}</td>
                <td>{TRANSFER_KIND_LABELS[t.kind]}</td>
                <td>
                  {t.fromAccountName ?? <span className="muted">unbekannt</span>} →{' '}
                  {t.toAccountName ?? <span className="muted">unbekannt</span>}
                </td>
                <td className="num">{formatCents(t.amountCents)}</td>
                <td>
                  {t.transactions.map((x) => (
                    <small key={x.id} className="block">
                      <a href={hrefFor('buchungen', { accountId: x.accountId, from: x.bookingDate, to: x.bookingDate })}>
                        {formatDate(x.bookingDate)} {x.accountName}
                      </a>{' '}
                      <span className={x.amountCents < 0 ? 'amount-out' : 'amount-in'}>{formatCents(x.amountCents, { sign: true })}</span>{' '}
                      <span className="muted">{x.counterparty || x.purpose}</span>
                    </small>
                  ))}
                </td>
                <td>
                  <small>
                    {t.origin === 'manual' ? 'von Hand' : 'automatisch'}
                    {t.reason && t.origin === 'auto' && <span className="muted block">{t.reason}</span>}
                  </small>
                </td>
                <td>
                  <small>
                    <Check transfer={t} />
                  </small>
                </td>
                <td>{t.status === 'suggested' ? <strong className="warnings">vorgeschlagen</strong> : 'bestätigt'}</td>
                <td className="row-actions">
                  {t.status === 'suggested' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await confirmTransfer(t.id);
                          return null;
                        })
                      }
                    >
                      Bestätigen
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={() => handleDissolve(t)}>
                    Aufheben
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
