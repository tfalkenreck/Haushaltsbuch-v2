import type { Category } from '../api/categories';

interface Props {
  categories: Category[];
  value: number | null;
  onChange: (categoryId: number | null) => void;
  /** Beschriftung der leeren Auswahl, z. B. „alle Kategorien“. */
  emptyLabel: string;
  /** Leere Auswahl wählbar (sonst nur Platzhalter). */
  allowEmpty?: boolean;
  disabled?: boolean;
}

/**
 * Auswahl aus aktiven Kategorien; Unterkategorien eingerückt unter ihrer
 * Wurzel. Eine bereits gewählte deaktivierte Kategorie bleibt sichtbar.
 */
export function CategorySelect({ categories, value, onChange, emptyLabel, allowEmpty = true, disabled }: Props) {
  const options = categories.filter((c) => c.active || c.id === value);
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    >
      <option value="" disabled={!allowEmpty}>
        {emptyLabel}
      </option>
      {options.map((c) => (
        <option key={c.id} value={c.id}>
          {c.parentId === null ? c.name : `   ${c.name}`}
          {c.active ? '' : ' (deaktiviert)'}
        </option>
      ))}
    </select>
  );
}
