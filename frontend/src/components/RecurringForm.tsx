import { useState, type FormEvent } from 'react';
import type { Account } from '../api/accounts';
import type { Category } from '../api/categories';
import type { Interval } from '../api/funding';
import type { NoticeUnit, RecurringItemInput, RecurringKind } from '../api/recurring';
import { INTERVAL_LABELS, NOTICE_UNIT_LABELS, RECURRING_KIND_LABELS } from '../lib/labels';
import { CategorySelect } from './CategorySelect';

interface Props {
  accounts: Account[];
  categories: Category[];
  initial?: Partial<RecurringItemInput>;
  /** Bearbeiten zeigt „aktiv“ an. */
  editing?: boolean;
  submitLabel: string;
  onSubmit: (input: RecurringItemInput) => Promise<void>;
  onCancel?: () => void;
}

/**
 * Fixkostenposition bzw. Abo von Hand anlegen oder bearbeiten (CLAUDE.md
 * § 14): Gegenpartei, Betrag, Intervall, nächster Termin, optional
 * Vertragsende und Kündigungsfrist.
 */
export function RecurringForm({ accounts, categories, initial, editing = false, submitLabel, onSubmit, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<RecurringKind>(initial?.kind ?? 'subscription');
  const [counterparty, setCounterparty] = useState(initial?.counterparty ?? '');
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [interval, setInterval] = useState<Interval>(initial?.interval ?? 'monthly');
  const [nextDueDate, setNextDueDate] = useState(initial?.nextDueDate ?? '');
  const [accountId, setAccountId] = useState<number | null>(initial?.accountId ?? null);
  const [categoryId, setCategoryId] = useState<number | null>(initial?.categoryId ?? null);
  const [contractEndDate, setContractEndDate] = useState(initial?.contractEndDate ?? '');
  const [noticeValue, setNoticeValue] = useState(initial?.noticePeriodValue ? String(initial.noticePeriodValue) : '');
  const [noticeUnit, setNoticeUnit] = useState<NoticeUnit>(initial?.noticePeriodUnit ?? 'months');
  const [creditorId, setCreditorId] = useState(initial?.creditorId ?? '');
  const [mandateReference, setMandateReference] = useState(initial?.mandateReference ?? '');
  const [counterpartyIban, setCounterpartyIban] = useState(initial?.counterpartyIban ?? '');
  const [active, setActive] = useState(initial?.active ?? true);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const notice = noticeValue.trim() === '' ? null : Number(noticeValue);
    if (notice !== null && (!Number.isInteger(notice) || notice < 1)) {
      setError('Die Kündigungsfrist muss eine ganze Zahl ab 1 sein.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        kind,
        accountId,
        counterparty,
        amount,
        interval,
        nextDueDate,
        contractEndDate: contractEndDate || null,
        noticePeriodValue: notice,
        noticePeriodUnit: notice === null ? null : noticeUnit,
        categoryId,
        creditorId: creditorId.trim() || null,
        mandateReference: mandateReference.trim() || null,
        counterpartyIban: counterpartyIban.trim() || null,
        active,
        notes: notes.trim() || null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel recurring-form" onSubmit={(e) => void handleSubmit(e)}>
      <label>
        Gegenpartei
        <input value={counterparty} maxLength={200} placeholder="z. B. Audible" onChange={(e) => setCounterparty(e.target.value)} />
        <small className="hint">
          Zuordnung der Buchungen: die Wörter müssen in der Gegenpartei vorkommen (bei Kartenumsätzen der Händler, bei
          PayPal der Händler hinter PayPal), der Betrag zwischen der Hälfte und dem Doppelten liegen.
        </small>
      </label>
      <label>
        Name (optional)
        <input value={name} maxLength={200} placeholder="wie Gegenpartei" onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Art
        <select value={kind} onChange={(e) => setKind(e.target.value as RecurringKind)}>
          {(Object.keys(RECURRING_KIND_LABELS) as RecurringKind[]).map((k) => (
            <option key={k} value={k}>
              {RECURRING_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Betrag (€)
        <input required inputMode="decimal" placeholder="9,99" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label>
        Intervall
        <select value={interval} onChange={(e) => setInterval(e.target.value as Interval)}>
          {(Object.keys(INTERVAL_LABELS) as Interval[]).map((i) => (
            <option key={i} value={i}>
              {INTERVAL_LABELS[i]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Nächster Termin
        <input type="date" required value={nextDueDate} onChange={(e) => setNextDueDate(e.target.value)} />
      </label>
      <label>
        Konto
        <select value={accountId ?? ''} onChange={(e) => setAccountId(Number(e.target.value) || null)}>
          <option value="">beliebiges Konto</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.active ? '' : ' (deaktiviert)'}
            </option>
          ))}
        </select>
      </label>
      <label>
        Kategorie
        <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} emptyLabel="keine" />
      </label>
      <label>
        Vertragsende (optional)
        <input type="date" value={contractEndDate} onChange={(e) => setContractEndDate(e.target.value)} />
      </label>
      <label>
        Kündigungsfrist (optional)
        <span className="inline-pair">
          <input inputMode="numeric" value={noticeValue} placeholder="3" onChange={(e) => setNoticeValue(e.target.value)} />
          <select value={noticeUnit} onChange={(e) => setNoticeUnit(e.target.value as NoticeUnit)}>
            {(Object.keys(NOTICE_UNIT_LABELS) as NoticeUnit[]).map((u) => (
              <option key={u} value={u}>
                {NOTICE_UNIT_LABELS[u]}
              </option>
            ))}
          </select>
        </span>
      </label>
      <details className="wide">
        <summary>Merkmale des Vertrags (optional)</summary>
        <p className="hint">
          Gläubiger-ID und Mandatsreferenz aus einer Lastschrift ordnen Buchungen unabhängig von der Schreibweise der
          Gegenpartei zu; die Mandatsreferenz trennt mehrere Verträge beim selben Anbieter. Die IBAN des Empfängers trennt
          Überweisungen an Empfänger gleichen Namens (z. B. an dich selbst: Gemeinschaftskonto, Strom-Dauerauftrag).
        </p>
        <label>
          Gläubiger-ID
          <input value={creditorId} maxLength={50} onChange={(e) => setCreditorId(e.target.value)} />
        </label>
        <label>
          Mandatsreferenz
          <input value={mandateReference} maxLength={50} onChange={(e) => setMandateReference(e.target.value)} />
        </label>
        <label>
          IBAN des Empfängers
          <input value={counterpartyIban} maxLength={50} onChange={(e) => setCounterpartyIban(e.target.value)} />
        </label>
      </details>
      <label className="wide">
        Notiz
        <input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {editing && (
        <label className="checkbox">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> läuft noch (aus = gekündigt
          bzw. beendet)
        </label>
      )}
      {error && <p className="error wide">{error}</p>}
      <div className="form-actions">
        <button type="submit" disabled={busy}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Abbrechen
          </button>
        )}
      </div>
    </form>
  );
}
