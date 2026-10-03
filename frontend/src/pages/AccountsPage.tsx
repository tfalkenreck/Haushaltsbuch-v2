import { useCallback, useEffect, useState } from 'react';
import {
  createAccount,
  fetchAccountRoles,
  fetchAccounts,
  fetchBankAdapters,
  updateAccount,
  type Account,
  type AccountInput,
  type AccountRole,
  type BankAdapter,
} from '../api/accounts';
import { AccountForm } from '../components/AccountForm';
import { formatIban } from '../lib/iban';
import { ROLE_LABELS } from '../lib/labels';

export function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [roles, setRoles] = useState<AccountRole[]>([]);
  const [adapters, setAdapters] = useState<BankAdapter[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Neu laden ohne zu warten: das Formular leert sich so, bevor die neue
  // Zeile erscheint, und überschreibt keine bereits begonnene Eingabe.
  const reload = useCallback(() => {
    fetchAccounts()
      .then(setAccounts)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    Promise.all([fetchAccounts(), fetchAccountRoles(), fetchBankAdapters()])
      .then(([a, r, b]) => {
        setAccounts(a);
        setRoles(r);
        setAdapters(b);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  const adapterLabel = (id: string) => adapters.find((a) => a.id === id)?.label ?? id;

  async function handleCreate(input: AccountInput) {
    await createAccount(input);
    reload();
  }

  async function handleUpdate(id: number, input: AccountInput) {
    await updateAccount(id, input);
    setEditingId(null);
    reload();
  }

  async function toggleActive(account: Account) {
    setError(null);
    try {
      await updateAccount(account.id, { active: !account.active });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (loading) return <p>Lade Konten…</p>;

  return (
    <section>
      <h2>Konten</h2>
      {error && <p className="error">{error}</p>}

      {accounts.length === 0 ? (
        <p>Noch keine Konten angelegt.</p>
      ) : (
        <table className="accounts">
          <thead>
            <tr>
              <th>Name</th>
              <th>Rolle</th>
              <th>Bank-Adapter</th>
              <th>IBAN</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) =>
              editingId === account.id ? (
                <tr key={account.id}>
                  <td colSpan={6}>
                    <AccountForm
                      roles={roles}
                      adapters={adapters}
                      initial={{
                        name: account.name,
                        role: account.role,
                        bankAdapter: account.bankAdapter,
                        iban: account.iban,
                      }}
                      submitLabel="Speichern"
                      onSubmit={(input) => handleUpdate(account.id, input)}
                      onCancel={() => setEditingId(null)}
                    />
                  </td>
                </tr>
              ) : (
                <tr key={account.id} className={account.active ? undefined : 'inactive'}>
                  <td>{account.name}</td>
                  <td>{ROLE_LABELS[account.role]}</td>
                  <td>{adapterLabel(account.bankAdapter)}</td>
                  <td className="iban">{account.iban ? formatIban(account.iban) : '–'}</td>
                  <td>{account.active ? 'aktiv' : 'deaktiviert'}</td>
                  <td className="row-actions">
                    <button type="button" onClick={() => setEditingId(account.id)}>
                      Bearbeiten
                    </button>
                    <button type="button" onClick={() => void toggleActive(account)}>
                      {account.active ? 'Deaktivieren' : 'Reaktivieren'}
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}

      <h3>Neues Konto</h3>
      <AccountForm roles={roles} adapters={adapters} submitLabel="Konto anlegen" onSubmit={handleCreate} />
      <p className="hint">
        Konten werden nicht gelöscht, sondern deaktiviert – so behalten importierte Buchungen ihren Bezug.
      </p>
    </section>
  );
}
