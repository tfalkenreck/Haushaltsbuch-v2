import { useState, type FormEvent } from 'react';
import type { AccountInput, AccountRole, BankAdapter } from '../api/accounts';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '../lib/labels';

interface Props {
  roles: AccountRole[];
  adapters: BankAdapter[];
  initial?: AccountInput;
  submitLabel: string;
  onSubmit: (input: AccountInput) => Promise<void>;
  onCancel?: () => void;
}

/** Formular für Anlegen und Bearbeiten: Name, Rolle, Bank-Adapter, IBAN. */
export function AccountForm({ roles, adapters, initial, submitLabel, onSubmit, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [role, setRole] = useState<AccountRole | ''>(initial?.role ?? '');
  const [bankAdapter, setBankAdapter] = useState(initial?.bankAdapter ?? '');
  const [iban, setIban] = useState(initial?.iban ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (role === '' || bankAdapter === '') return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name, role, bankAdapter, iban: iban.trim() === '' ? null : iban });
      if (!initial) {
        setName('');
        setRole('');
        setBankAdapter('');
        setIban('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="account-form" onSubmit={handleSubmit}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
      </label>
      <label>
        Rolle
        <select value={role} onChange={(e) => setRole(e.target.value as AccountRole)} required>
          <option value="" disabled>
            bitte wählen
          </option>
          {roles.map((r) => (
            <option key={r} value={r} title={ROLE_DESCRIPTIONS[r]}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Bank-Adapter
        <select value={bankAdapter} onChange={(e) => setBankAdapter(e.target.value)} required>
          <option value="" disabled>
            bitte wählen
          </option>
          {adapters.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Eigene IBAN (optional)
        <input value={iban} onChange={(e) => setIban(e.target.value)} placeholder="DE…" maxLength={50} />
      </label>
      <div className="form-actions">
        <button type="submit" disabled={busy}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy}>
            Abbrechen
          </button>
        )}
      </div>
      {role !== '' && <p className="hint">{ROLE_DESCRIPTIONS[role]}</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
