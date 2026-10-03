import { useEffect, useState } from 'react';
import { applyRule, createRule, previewPattern, updateRule, type RuleSuggestion } from '../api/rules';
import { notifyDataChanged } from '../lib/events';
import { RULE_FIELD_LABELS } from '../lib/labels';

interface Props {
  suggestion: RuleSuggestion;
  onDone: (message: string) => void;
  onDismiss: () => void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Angebot nach einer manuellen Korrektur (CLAUDE.md § 9): daraus eine
 * Regel machen. Wird nur auf Knopfdruck angelegt; das Muster ist vorher
 * anpassbar.
 */
export function RuleSuggestionView({ suggestion, onDone, onDismiss }: Props) {
  const [pattern, setPattern] = useState(suggestion.pattern);
  const [applyNow, setApplyNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncategorized, setUncategorized] = useState<number | null>(suggestion.uncategorizedMatches);

  // Bei geändertem Muster die Trefferzahl neu ermitteln.
  useEffect(() => {
    if (pattern === suggestion.pattern) {
      setUncategorized(suggestion.uncategorizedMatches);
      return;
    }
    setUncategorized(null);
    const timer = window.setTimeout(() => {
      previewPattern({ field: suggestion.field, patternType: suggestion.patternType, pattern })
        .then((p) => setUncategorized(p.uncategorizedCount))
        .catch(() => setUncategorized(null));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [pattern, suggestion]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const input = {
        field: suggestion.field,
        patternType: suggestion.patternType,
        pattern,
        categoryId: suggestion.categoryId,
        priority: suggestion.priority,
        active: true,
      };
      const changed = pattern.trim().toLowerCase() !== suggestion.pattern.toLowerCase();
      const rule =
        suggestion.existingRuleId !== null && !changed
          ? await updateRule(suggestion.existingRuleId, input)
          : await createRule(input);
      let text = `Regel „${rule.pattern}“ → ${rule.categoryPath} ${suggestion.existingRuleId !== null && !changed ? 'geändert' : 'angelegt'}.`;
      if (applyNow) {
        const result = await applyRule(rule.id);
        text += ` ${result.categorized} weitere Buchung(en) kategorisiert.`;
      }
      notifyDataChanged();
      onDone(text);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel notice suggestion">
      <p>
        <strong>Daraus eine Regel machen?</strong> {RULE_FIELD_LABELS[suggestion.field]} enthält{' '}
        <input value={pattern} onChange={(e) => setPattern(e.target.value)} maxLength={200} aria-label="Suchtext" /> →{' '}
        <strong>{suggestion.categoryPath}</strong>, Priorität {suggestion.priority}.
      </p>
      {suggestion.existingRuleId !== null && (
        <p className="hint">Eine Regel mit diesem Suchtext gibt es schon – sie wird auf diese Kategorie geändert.</p>
      )}
      {suggestion.outranks.length > 0 && (
        <p className="hint">
          Gewinnt gegen:{' '}
          {suggestion.outranks.map((r) => `„${r.pattern}“ → ${r.categoryPath} (Priorität ${r.priority})`).join(', ')}.
        </p>
      )}
      {suggestion.otherRuleMatches > 0 && (
        <p className="hint">
          {suggestion.otherRuleMatches} Buchung(en) mit diesem Suchtext hat eine andere Regel bereits anders
          kategorisiert – sie bleiben unverändert.
        </p>
      )}
      <label className="inline">
        <input type="checkbox" checked={applyNow} onChange={(e) => setApplyNow(e.target.checked)} /> gleich auf{' '}
        {uncategorized === null ? '…' : uncategorized} unkategorisierte Buchung(en) anwenden
      </label>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="button" onClick={() => void accept()} disabled={busy || pattern.trim() === ''}>
          {suggestion.existingRuleId !== null && pattern.trim().toLowerCase() === suggestion.pattern.toLowerCase()
            ? 'Regel ändern'
            : 'Regel anlegen'}
        </button>
        <button type="button" onClick={onDismiss} disabled={busy}>
          Nein, danke
        </button>
      </div>
    </div>
  );
}
