import type { Category } from '../api/categories';
import type { Transaction } from '../api/transactions';

interface Props {
  transaction: Transaction;
  categories: Category[];
  busy: boolean;
  /** Kategorie von Hand setzen; null = bewusst keine Kategorie. */
  onSet: (categoryId: number | null) => void;
  /** Handarbeit aufheben, Regeln dürfen wieder entscheiden. */
  onReset: () => void;
}

const UNTOUCHED = '';
const NONE = 'none';

/** Kategorie einer Buchung: Auswahl plus Herkunft (Regel / von Hand). */
export function TransactionCategoryCell({ transaction: t, categories, busy, onSet, onReset }: Props) {
  const deliberateNone = t.categorySource === 'manual' && t.categoryId === null;
  const value = t.categoryId !== null ? String(t.categoryId) : deliberateNone ? NONE : UNTOUCHED;
  const options = categories.filter((c) => c.active || c.id === t.categoryId);

  return (
    <div className="category-cell">
      <select
        value={value}
        disabled={busy}
        className={t.categoryId === null && !deliberateNone && t.transferId === null ? 'uncategorized' : undefined}
        title={t.transferId !== null ? 'Umbuchung – braucht keine Kategorie und zählt in keiner Auswertung' : undefined}
        onChange={(e) => onSet(e.target.value === NONE ? null : Number(e.target.value))}
      >
        <option value={UNTOUCHED} disabled>
          – unkategorisiert –
        </option>
        <option value={NONE}>bewusst keine Kategorie</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.parentId === null ? c.name : `   ${c.name}`}
            {c.active ? '' : ' (deaktiviert)'}
          </option>
        ))}
      </select>
      {t.categorySource === 'rule' && <small className="muted block">per Regel</small>}
      {t.categorySource === 'manual' && (
        <small className="muted block">
          von Hand ·{' '}
          <button type="button" className="link" disabled={busy} onClick={onReset} title="Regeln dürfen diese Buchung wieder einordnen">
            Automatik zulassen
          </button>
        </small>
      )}
    </div>
  );
}
