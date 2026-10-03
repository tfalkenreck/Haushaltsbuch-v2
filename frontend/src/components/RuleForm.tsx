import { useEffect, useState, type FormEvent } from 'react';
import type { Category } from '../api/categories';
import { previewPattern, type PatternPreview, type PatternType, type RuleField, type RuleInput } from '../api/rules';
import { PATTERN_TYPE_HINTS, PATTERN_TYPE_LABELS, RULE_FIELD_LABELS } from '../lib/labels';
import { CategorySelect } from './CategorySelect';

interface Props {
  categories: Category[];
  initial?: RuleInput;
  submitLabel: string;
  onSubmit: (input: RuleInput) => Promise<void>;
  onCancel?: () => void;
}

/** Regel anlegen/bearbeiten – mit Vorschau, welche Buchungen das Muster träfe. */
export function RuleForm({ categories, initial, submitLabel, onSubmit, onCancel }: Props) {
  const [field, setField] = useState<RuleField>(initial?.field ?? 'counterparty');
  const [patternType, setPatternType] = useState<PatternType>(initial?.patternType ?? 'contains');
  const [pattern, setPattern] = useState(initial?.pattern ?? '');
  const [categoryId, setCategoryId] = useState<number | null>(initial?.categoryId ?? null);
  const [priority, setPriority] = useState(String(initial?.priority ?? 0));
  const [preview, setPreview] = useState<PatternPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (pattern.trim() === '') return;
    const timer = window.setTimeout(() => {
      previewPattern({ field, patternType, pattern })
        .then(setPreview)
        .catch((err: unknown) => setPreviewError(err instanceof Error ? err.message : String(err)));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [field, patternType, pattern]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (categoryId === null) return;
    const prio = Number(priority);
    if (!Number.isInteger(prio)) {
      setError('Die Priorität muss eine ganze Zahl sein.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ field, patternType, pattern, categoryId, priority: prio });
      if (!initial) {
        setPattern('');
        setPriority('0');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel rule-form" onSubmit={handleSubmit}>
      <label>
        Feld
        <select value={field} onChange={(e) => setField(e.target.value as RuleField)}>
          {(Object.keys(RULE_FIELD_LABELS) as RuleField[]).map((f) => (
            <option key={f} value={f}>
              {RULE_FIELD_LABELS[f]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Mustertyp
        <select value={patternType} onChange={(e) => setPatternType(e.target.value as PatternType)}>
          {(Object.keys(PATTERN_TYPE_LABELS) as PatternType[]).map((t) => (
            <option key={t} value={t}>
              {PATTERN_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Muster
        <input value={pattern} onChange={(e) => setPattern(e.target.value)} required maxLength={200} />
      </label>
      <label>
        Kategorie
        <CategorySelect
          categories={categories}
          value={categoryId}
          onChange={setCategoryId}
          emptyLabel="bitte wählen"
          allowEmpty={false}
        />
      </label>
      <label>
        Priorität (höher gewinnt)
        <input type="number" step={1} value={priority} onChange={(e) => setPriority(e.target.value)} required />
      </label>
      <div className="form-actions">
        <button type="submit" disabled={busy || categoryId === null}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy}>
            Abbrechen
          </button>
        )}
      </div>
      <p className="hint">{PATTERN_TYPE_HINTS[patternType]}</p>
      {previewError && <p className="error">{previewError}</p>}
      {preview && (
        <div className="hint preview">
          Trifft aktuell <strong>{preview.matchCount}</strong> Buchung(en), davon {preview.uncategorizedCount} ohne Kategorie.
          {preview.samples.length > 0 && (
            <ul>
              {preview.samples.map((s) => (
                <li key={s.id}>
                  {s.counterparty || <span className="muted">–</span>} <span className="muted">{s.purpose.slice(0, 80)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
