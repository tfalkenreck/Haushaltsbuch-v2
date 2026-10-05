import { useEffect, useState, type FormEvent } from 'react';
import { fetchAccounts, type Account } from '../api/accounts';
import { fetchCategories, type Category } from '../api/categories';
import type { RuleSuggestion } from '../api/rules';
import {
  fetchTransactions,
  resetTransactionCategory,
  setTransactionCategory,
  type Transaction,
  type TransactionPage,
} from '../api/transactions';
import { markTransfer, resetTransfer, unmarkTransfer } from '../api/transfers';
import { fetchRecurring, resetTransactionRecurring, setTransactionRecurring, type RecurringItem } from '../api/recurring';
import { RuleSuggestionView } from '../components/RuleSuggestionView';
import { TransactionCategoryCell } from '../components/TransactionCategoryCell';
import { TransactionRecurringCell } from '../components/TransactionRecurringCell';
import { TransactionTransferCell } from '../components/TransactionTransferCell';
import { notifyDataChanged } from '../lib/events';
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
  const transfers = params.get('transfers');
  const transferFilter: 'only' | 'exclude' | undefined = transfers === 'only' || transfers === 'exclude' ? transfers : undefined;
  return {
    accountId: num('accountId'),
    importBatchId: num('importBatchId'),
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    dateBasis: params.get('dateBasis') === 'bank' || params.get('dateBasis') === 'value' ? (params.get('dateBasis') as 'bank' | 'value') : undefined,
    q: params.get('q') ?? undefined,
    categoryId: num('categoryId'),
    uncategorized: params.get('uncategorized') === '1' ? true : undefined,
    transfers: transferFilter,
    recurringItemId: num('recurringItemId'),
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
  const [categories, setCategories] = useState<Category[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [suggestion, setSuggestion] = useState<RuleSuggestion | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [recurringItems, setRecurringItems] = useState<RecurringItem[]>([]);

  useEffect(() => {
    Promise.all([fetchAccounts(), fetchCategories(), fetchRecurring()])
      .then(([a, c, r]) => {
        setAccounts(a);
        setCategories(c);
        setRecurringItems(r.items);
      })
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
      dateBasis: next.dateBasis,
      q: next.q,
      categoryId: next.categoryId,
      uncategorized: next.uncategorized ? 1 : undefined,
      transfers: next.transfers,
      recurringItemId: next.recurringItemId,
      offset: next.offset || undefined,
    });
  };

  const replaceItem = (updated: Transaction) =>
    setPage((current) =>
      current ? { ...current, items: current.items.map((t) => (t.id === updated.id ? updated : t)) } : current,
    );

  async function changeCategory(t: Transaction, categoryId: number | null) {
    setBusyId(t.id);
    setError(null);
    setInfo(null);
    setSuggestion(null);
    try {
      const change = await setTransactionCategory(t.id, categoryId);
      replaceItem(change.transaction);
      setSuggestion(change.suggestion);
      notifyDataChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusyId(null);
    }
  }

  async function resetCategory(t: Transaction) {
    setBusyId(t.id);
    setError(null);
    try {
      replaceItem(await resetTransactionCategory(t.id));
      notifyDataChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusyId(null);
    }
  }

  /** Umbuchung bzw. Fixkosten-Zuordnung setzen/aufheben – betrifft ggf. weitere Buchungen, daher neu laden. */
  async function changeTransfer(t: Transaction, action: () => Promise<unknown>) {
    setBusyId(t.id);
    setError(null);
    setInfo(null);
    try {
      await action();
      reload();
      notifyDataChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusyId(null);
    }
  }

  /** Nach angenommenem Regelvorschlag: Liste neu laden (die Regel hat ggf. weitere Buchungen eingeordnet). */
  function reload() {
    fetchTransactions({ ...filter, limit: PAGE_SIZE })
      .then(setPage)
      .catch((err: unknown) => setError(message(err)));
  }

  const categoryFilterValue = filter.uncategorized ? 'none' : filter.categoryId !== undefined ? String(filter.categoryId) : '';

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
        {filter.dateBasis !== undefined && (
          <p className="hint">
            Von/bis gelten nach {filter.dateBasis === 'bank' ? 'Buchungstag der Bank' : 'Valuta'} (Zeitraum einer
            Kartenabrechnung), nicht nach Kaufdatum.{' '}
            <button type="button" className="link" onClick={() => navigate({ dateBasis: undefined })}>
              nach Kaufdatum filtern
            </button>
          </p>
        )}
        <label>
          Kategorie
          <select
            value={categoryFilterValue}
            onChange={(e) => {
              const v = e.target.value;
              navigate({
                uncategorized: v === 'none' ? true : undefined,
                categoryId: v === '' || v === 'none' ? undefined : Number(v),
              });
            }}
          >
            <option value="">alle Kategorien</option>
            <option value="none">nur unkategorisierte</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.parentId === null ? c.name : `\u00a0\u00a0\u00a0${c.name}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Umbuchungen
          <select
            value={filter.transfers ?? ''}
            onChange={(e) => navigate({ transfers: (e.target.value || undefined) as 'only' | 'exclude' | undefined })}
          >
            <option value="">mit Umbuchungen</option>
            <option value="exclude">ohne Umbuchungen</option>
            <option value="only">nur Umbuchungen</option>
          </select>
        </label>
        <label>
          Suche (Gegenpartei, Verwendungszweck, Vorgang)
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div className="form-actions">
          <button type="submit">Suchen</button>
        </div>
        {filter.recurringItemId !== undefined && (
          <p className="hint">
            Nur Buchungen von „{recurringItems.find((i) => i.id === filter.recurringItemId)?.name ?? `Posten ${filter.recurringItemId}`}“
            (Fixkosten/Abo).{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); navigate({ recurringItemId: undefined }); }}>
              Filter entfernen
            </a>
          </p>
        )}
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
      {info && <p className="panel notice">{info}</p>}
      {suggestion && (
        <RuleSuggestionView
          key={`${suggestion.categoryId}-${suggestion.pattern}`}
          suggestion={suggestion}
          onDismiss={() => setSuggestion(null)}
          onDone={(text) => {
            setSuggestion(null);
            setInfo(text);
            reload();
          }}
        />
      )}

      {page && (
        <>
          <p className="summary">
            {page.total} Buchungen · Zuflüsse <span className="amount-in">{formatCents(page.inflowCents)}</span> ·
            Abflüsse <span className="amount-out">{formatCents(page.outflowCents)}</span>
            {page.transferCount > 0 && (
              <span className="muted">
                {' '}
                · {page.transferCount} Umbuchung(en) (
                {[page.transferInflowCents, page.transferOutflowCents]
                  .filter((c) => c !== 0)
                  .map((c) => formatCents(c, { sign: true }))
                  .join(' / ')}
                ) zählen nicht als Einnahme oder Ausgabe
              </span>
            )}
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
                  <th>Kategorie</th>
                  <th>Umbuchung</th>
                  <th>Fixkosten/Abo</th>
                  <th className="num">Betrag</th>
                  <th className="num">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((t) => (
                  <tr key={t.id} className={t.transferId !== null ? 'transfer' : undefined}>
                    <td title={t.valueDate ? `Valuta ${formatDate(t.valueDate)}` : undefined}>{formatDate(t.bookingDate)}</td>
                    <td>{t.accountName}</td>
                    <td>
                      {t.counterparty || <span className="muted">–</span>}
                      {t.bookingText && <small className="muted block">{t.bookingText}</small>}
                    </td>
                    <td className="purpose">{t.purpose}</td>
                    <td>
                      <TransactionCategoryCell
                        transaction={t}
                        categories={categories}
                        busy={busyId === t.id}
                        onSet={(categoryId) => void changeCategory(t, categoryId)}
                        onReset={() => void resetCategory(t)}
                      />
                    </td>
                    <td>
                      <TransactionTransferCell
                        transaction={t}
                        accounts={accounts}
                        busy={busyId === t.id}
                        onMark={(accountId) => void changeTransfer(t, () => markTransfer(t.id, accountId))}
                        onUnmark={() => void changeTransfer(t, () => unmarkTransfer(t.id))}
                        onReset={() => void changeTransfer(t, () => resetTransfer(t.id))}
                      />
                    </td>
                    <td>
                      <TransactionRecurringCell
                        transaction={t}
                        items={recurringItems}
                        busy={busyId === t.id}
                        onSet={(itemId) => void changeTransfer(t, () => setTransactionRecurring(t.id, itemId))}
                        onReset={() => void changeTransfer(t, () => resetTransactionRecurring(t.id))}
                      />
                    </td>
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
