import { useEffect, useState, type FormEvent } from 'react';
import { fetchAccounts, type Account } from '../api/accounts';
import { fetchTransactions, type TransactionPage } from '../api/transactions';
import { formatCents, formatDate } from '../lib/format';
import { hrefFor } from '../lib/route';

interface Props {
  params: URLSearchParams;
}

const PAGE_SIZE = 100;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Filter steckt im URL-Fragment – Links aus anderen Seiten springen direkt in eine gefilterte Liste. */
function filterFromParams(params: URLSearchParams) {
  const num = (key: string) => {
    const value = Number(params.get(key));
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };
  return {
    accountId: num('accountId'),
    importBatchId: num('importBatchId'),
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    q: params.get('q') ?? undefined,
    offset: num('offset') ?? 0,
  };
}

export function TransactionsPage({ params }: Props) {
  const filter = filterFromParams(params);
  const filterKey = params.toString();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [page, setPage] = useState<TransactionPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(filter.q ?? '');

  useEffect(() => {
    fetchAccounts()
      .then(setAccounts)
      .catch((err: unknown) => setError(message(err)));
  }, []);

  useEffect(() => {
    setError(null);
    fetchTransactions({ ...filter, limit: PAGE_SIZE })
      .then(setPage)
      .catch((err: unknown) => setError(message(err)));
    // filterKey bildet den kompletten Filter ab
  }, [filterKey]);

  const navigate = (changes: Partial<ReturnType<typeof filterFromParams>>) => {
    const next = { ...filter, offset: 0, ...changes };
    window.location.hash = hrefFor('buchungen', {
      accountId: next.accountId,
      importBatchId: next.importBatchId,
      from: next.from,
      to: next.to,
      q: next.q,
      offset: next.offset || undefined,
    });
  };

  function handleSearch(event: FormEvent) {
    event.preventDefault();
    navigate({ q: search.trim() || undefined });
  }

  return (
    <section>
      <h2>Buchungen</h2>

      <form className="panel filter-form" onSubmit={handleSearch}>
        <label>
          Konto
          <select
            value={filter.accountId ?? ''}
            onChange={(e) => navigate({ accountId: Number(e.target.value) || undefined, importBatchId: undefined })}
          >
            <option value="">alle Konten</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.active ? '' : ' (deaktiviert)'}
              </option>
            ))}
          </select>
        </label>
        <label>
          von
          <input type="date" value={filter.from ?? ''} onChange={(e) => navigate({ from: e.target.value || undefined })} />
        </label>
        <label>
          bis
          <input type="date" value={filter.to ?? ''} onChange={(e) => navigate({ to: e.target.value || undefined })} />
        </label>
        <label>
          Suche (Gegenpartei, Verwendungszweck, Vorgang)
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div className="form-actions">
          <button type="submit">Suchen</button>
        </div>
        {filter.importBatchId !== undefined && (
          <p className="hint">
            Nur Buchungen aus Importvorgang {filter.importBatchId}.{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); navigate({ importBatchId: undefined }); }}>
              Filter entfernen
            </a>
          </p>
        )}
      </form>

      {error && <p className="error">{error}</p>}

      {page && (
        <>
          <p className="summary">
            {page.total} Buchungen · Zuflüsse <span className="amount-in">{formatCents(page.inflowCents)}</span> ·
            Abflüsse <span className="amount-out">{formatCents(page.outflowCents)}</span>
          </p>

          {page.items.length === 0 ? (
            <p>
              Keine Buchungen gefunden. <a href={hrefFor('import')}>Kontoauszug importieren</a>
            </p>
          ) : (
            <table className="data transactions">
              <thead>
                <tr>
                  <th>Datum</th>
                  <th>Konto</th>
                  <th>Gegenpartei</th>
                  <th>Verwendungszweck</th>
                  <th className="num">Betrag</th>
                  <th className="num">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((t) => (
                  <tr key={t.id}>
                    <td title={t.valueDate ? `Valuta ${formatDate(t.valueDate)}` : undefined}>{formatDate(t.bookingDate)}</td>
                    <td>{t.accountName}</td>
                    <td>
                      {t.counterparty || <span className="muted">–</span>}
                      {t.bookingText && <small className="muted block">{t.bookingText}</small>}
                    </td>
                    <td className="purpose">{t.purpose}</td>
                    <td className={`num ${t.amountCents < 0 ? 'amount-out' : 'amount-in'}`}>
                      {formatCents(t.amountCents, { sign: true })}
                    </td>
                    <td className="num muted">{t.balanceAfterCents === null ? '' : formatCents(t.balanceAfterCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {page.total > PAGE_SIZE && (
            <div className="pager">
              <button type="button" disabled={page.offset === 0} onClick={() => navigate({ ...filter, offset: Math.max(page.offset - PAGE_SIZE, 0) })}>
                ← Neuere
              </button>
              <span>
                {page.offset + 1}–{Math.min(page.offset + PAGE_SIZE, page.total)} von {page.total}
              </span>
              <button
                type="button"
                disabled={page.offset + PAGE_SIZE >= page.total}
                onClick={() => navigate({ ...filter, offset: page.offset + PAGE_SIZE })}
              >
                Ältere →
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
