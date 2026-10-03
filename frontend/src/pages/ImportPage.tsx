import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { fetchAccounts, fetchBankAdapters, type Account, type BankAdapter } from '../api/accounts';
import {
  fetchCoverage,
  fetchImports,
  undoImport,
  uploadImport,
  type AccountCoverage,
  type ImportBatch,
  type ImportResult,
} from '../api/imports';
import { CoverageView } from '../components/CoverageView';
import { ImportResultView } from '../components/ImportResultView';
import { notifyDataChanged } from '../lib/events';
import { formatCents, formatDate, formatTimestamp } from '../lib/format';
import { hrefFor } from '../lib/route';

interface Props {
  params: URLSearchParams;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function ImportPage({ params }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [adapters, setAdapters] = useState<BankAdapter[]>([]);
  const [accountId, setAccountId] = useState<number | null>(() => Number(params.get('accountId')) || null);
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [undoMessages, setUndoMessages] = useState<string[]>([]);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [coverage, setCoverage] = useState<AccountCoverage | null>(null);

  useEffect(() => {
    Promise.all([fetchAccounts(), fetchBankAdapters()])
      .then(([a, b]) => {
        const active = a.filter((x) => x.active);
        setAccounts(active);
        setAdapters(b);
        setAccountId((current) => current ?? active[0]?.id ?? null);
      })
      .catch((err: unknown) => setError(message(err)));
  }, []);

  const reloadAccountData = useCallback(() => {
    if (accountId === null) return;
    Promise.all([fetchImports(accountId), fetchCoverage(accountId)])
      .then(([b, c]) => {
        setBatches(b);
        setCoverage(c);
      })
      .catch((err: unknown) => setError(message(err)));
  }, [accountId]);

  useEffect(() => {
    setBatches([]);
    setCoverage(null);
    reloadAccountData();
  }, [reloadAccountData]);

  const account = accounts.find((a) => a.id === accountId);
  const adapterLabel = (id: string) => adapters.find((a) => a.id === id)?.label ?? id;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (accountId === null || file === null) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setUndoMessages([]);
    try {
      setResult(await uploadImport(accountId, file, periodStart, periodEnd));
      setFile(null);
      setFileKey((k) => k + 1);
      setPeriodStart('');
      setPeriodEnd('');
      reloadAccountData();
      notifyDataChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleUndo(batch: ImportBatch) {
    const ok = window.confirm(
      `Import „${batch.fileName}“ vom ${formatTimestamp(batch.importedAt)} rückgängig machen?\n` +
        `${batch.transactionCount} Buchungen werden entfernt.`,
    );
    if (!ok) return;
    setError(null);
    setResult(null);
    try {
      const undo = await undoImport(batch.id);
      setUndoMessages([`${undo.deletedTransactions} Buchungen entfernt.`, ...undo.warnings]);
      reloadAccountData();
      notifyDataChanged();
    } catch (err) {
      setError(message(err));
    }
  }

  if (accounts.length === 0 && !error) {
    return (
      <section>
        <h2>Import</h2>
        <p>
          Noch kein aktives Konto. <a href={hrefFor('konten')}>Zuerst ein Konto anlegen.</a>
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2>Import</h2>

      <form className="panel import-form" onSubmit={handleSubmit}>
        <label>
          Konto
          <select value={accountId ?? ''} onChange={(e) => setAccountId(Number(e.target.value))} required>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kontoauszug (CSV)
          <input
            key={fileKey}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
        </label>
        <label>
          Exportzeitraum von (optional)
          <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
        </label>
        <label>
          bis (optional)
          <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </label>
        <div className="form-actions">
          <button type="submit" disabled={busy || file === null || accountId === null}>
            {busy ? 'Importiere…' : 'Importieren'}
          </button>
        </div>
        {account && (
          <p className="hint">
            Adapter: {adapterLabel(account.bankAdapter)}.
            {account.iban ? '' : ' Ohne hinterlegte IBAN kann nicht geprüft werden, ob die Datei zum Konto passt.'} Ohne
            Exportzeitraum gilt erste bis letzte Buchung der Datei.
          </p>
        )}
      </form>

      {error && <p className="error panel">{error}</p>}
      {result && <ImportResultView result={result} />}
      {undoMessages.length > 0 && (
        <div className="panel notice">
          {undoMessages.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </div>
      )}

      {batches.some((b) => b.needsReimport) && (
        <div className="panel notice warnings">
          <p>
            <strong>Bitte neu importieren:</strong> Die markierten Importe stammen aus einer Version, die bei
            Kartenumsätzen nur das Kaufdatum gespeichert hat, nicht den Buchungstag der Bank. Exportzeitraum und
            Abdeckung können dadurch falsch sein (z. B. ein Monat „teilweise“, der nie exportiert wurde).
          </p>
          <p>Jeden markierten Import einmal rückgängig machen und dieselbe Datei erneut importieren.</p>
        </div>
      )}

      {coverage && account && (
        <>
          <h3>Abdeckung – {account.name}</h3>
          <CoverageView coverage={coverage} />
        </>
      )}

      {account && (
        <>
          <h3>Importvorgänge – {account.name}</h3>
          {batches.length === 0 ? (
            <p>Noch keine Importe.</p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Importiert</th>
                  <th>Datei</th>
                  <th>Zeitraum</th>
                  <th className="num">Neu</th>
                  <th className="num">Duplikate</th>
                  <th className="num">Übersprungen</th>
                  <th className="num">Saldo laut Datei</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td>{formatTimestamp(b.importedAt)}</td>
                    <td>
                      <a href={hrefFor('buchungen', { accountId: b.accountId, importBatchId: b.id })}>{b.fileName}</a>
                      {b.needsReimport && <small className="warnings block">bitte neu importieren</small>}
                    </td>
                    <td>
                      {formatDate(b.periodStart)} – {formatDate(b.periodEnd)}
                    </td>
                    <td className="num">{b.transactionCount}</td>
                    <td className="num">{b.rowsDuplicate}</td>
                    <td className="num">{b.rowsSkipped}</td>
                    <td className="num">
                      {b.balanceCents === null ? '–' : `${formatCents(b.balanceCents)} (${formatDate(b.balanceDate)})`}
                    </td>
                    <td className="row-actions">
                      <button type="button" onClick={() => void handleUndo(b)}>
                        Rückgängig
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
