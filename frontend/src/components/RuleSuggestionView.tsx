import { useEffect, useState } from 'react';
import {
  applyRule,
  createRule,
  previewPattern,
  previewReassign,
  reassignToRule,
  updateRule,
  type ReassignCandidate,
  type RuleSuggestion,
} from '../api/rules';
import { notifyDataChanged } from '../lib/events';
import { formatCents, formatDate } from '../lib/format';
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
  // „Auch diese umstellen“: per Regel anders einsortierte Buchungen, die die neue Regel bekäme.
  const [otherRule, setOtherRule] = useState<number | null>(suggestion.otherRuleMatches);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignList, setReassignList] = useState<ReassignCandidate[] | null>(null);
  const [reassignSelected, setReassignSelected] = useState<Set<number>>(new Set());

  const isExistingPattern = pattern.trim().toLowerCase() === suggestion.pattern.toLowerCase();
  const ruleId = suggestion.existingRuleId !== null && isExistingPattern ? suggestion.existingRuleId : null;

  // Liste der umzustellenden Buchungen erst auf Knopfdruck laden – und neu, wenn sich das Muster ändert.
  useEffect(() => {
    if (!reassignOpen) return;
    setReassignList(null);
    const timer = window.setTimeout(() => {
      previewReassign({
        field: suggestion.field,
        patternType: suggestion.patternType,
        pattern,
        categoryId: suggestion.categoryId,
        priority: suggestion.priority,
        ruleId,
      })
        .then((list) => {
          setReassignList(list);
          setReassignSelected(new Set(list.map((c) => c.id)));
          setOtherRule(list.length);
        })
        .catch((err: unknown) => setError(message(err)));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [reassignOpen, pattern, suggestion, ruleId]);

  // Bei geändertem Muster die Trefferzahl neu ermitteln.
  useEffect(() => {
    if (pattern === suggestion.pattern) {
      setUncategorized(suggestion.uncategorizedMatches);
      setOtherRule(suggestion.otherRuleMatches);
      return;
    }
    setUncategorized(null);
    const timer = window.setTimeout(() => {
      previewPattern({ field: suggestion.field, patternType: suggestion.patternType, pattern })
        .then((p) => setUncategorized(p.uncategorizedCount))
        .catch(() => setUncategorized(null));
      previewReassign({
        field: suggestion.field,
        patternType: suggestion.patternType,
        pattern,
        categoryId: suggestion.categoryId,
        priority: suggestion.priority,
        ruleId: null,
      })
        .then((list) => setOtherRule(list.length))
        .catch(() => setOtherRule(null));
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
      const rule = ruleId !== null ? await updateRule(ruleId, input) : await createRule(input);
      let text = `Regel „${rule.pattern}“ → ${rule.categoryPath} ${ruleId !== null ? 'geändert' : 'angelegt'}.`;
      if (applyNow) {
        const result = await applyRule(rule.id);
        text += ` ${result.categorized} weitere Buchung(en) kategorisiert.`;
      }
      if (reassignOpen && reassignSelected.size > 0) {
        const result = await reassignToRule(rule.id, [...reassignSelected]);
        text += ` ${result.reassigned} per Regel einsortierte Buchung(en) umgestellt.`;
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
      {otherRule !== null && otherRule > 0 && !reassignOpen && (
        <p className="hint">
          {otherRule} Buchung(en) mit diesem Suchtext hat eine andere Regel bereits anders kategorisiert – sie bleiben
          unverändert.{' '}
          <button type="button" onClick={() => setReassignOpen(true)} disabled={busy}>
            auch diese umstellen …
          </button>
        </p>
      )}
      {reassignOpen && (
        <div className="hint">
          {reassignList === null ? (
            <p>Lade betroffene Buchungen …</p>
          ) : reassignList.length === 0 ? (
            <p>Keine per Regel einsortierte Buchung wäre betroffen.</p>
          ) : (
            <>
              <p>
                Diese Buchungen werden beim Speichern auf <strong>{suggestion.categoryPath}</strong> umgestellt. Nur per Regel
                gesetzte Kategorien – von Hand gesetzte sind nie dabei.
              </p>
              <ul className="reassign-list">
                {reassignList.map((c) => (
                  <li key={c.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={reassignSelected.has(c.id)}
                        onChange={(e) => {
                          const next = new Set(reassignSelected);
                          if (e.target.checked) next.add(c.id);
                          else next.delete(c.id);
                          setReassignSelected(next);
                        }}
                      />{' '}
                      {formatDate(c.bookingDate)} · {c.accountName} · {c.counterparty || c.purpose} ·{' '}
                      {formatCents(c.amountCents, { sign: true })} · bisher {c.categoryPath}
                      {c.rulePattern && ` (Regel „${c.rulePattern}“)`}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button type="button" className="link" onClick={() => setReassignOpen(false)} disabled={busy}>
            nicht umstellen
          </button>
        </div>
      )}
      <label className="inline">
        <input type="checkbox" checked={applyNow} onChange={(e) => setApplyNow(e.target.checked)} /> gleich auf{' '}
        {uncategorized === null ? '…' : uncategorized} unkategorisierte Buchung(en) anwenden
      </label>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="button" onClick={() => void accept()} disabled={busy || pattern.trim() === ''}>
          {ruleId !== null ? 'Regel ändern' : 'Regel anlegen'}
          {reassignOpen && reassignSelected.size > 0 ? ` und ${reassignSelected.size} umstellen` : ''}
        </button>
        <button type="button" onClick={onDismiss} disabled={busy}>
          Nein, danke
        </button>
      </div>
    </div>
  );
}
