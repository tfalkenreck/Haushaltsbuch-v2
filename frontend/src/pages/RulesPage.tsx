import { useCallback, useEffect, useState } from 'react';
import { fetchCategories, type Category } from '../api/categories';
import { applyAllRules, createRule, deleteRule, fetchRules, updateRule, type Rule, type RuleInput } from '../api/rules';
import { RuleForm } from '../components/RuleForm';
import { notifyDataChanged } from '../lib/events';
import { PATTERN_TYPE_LABELS, RULE_FIELD_LABELS } from '../lib/labels';
import { hrefFor } from '../lib/route';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function RulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    Promise.all([fetchRules(), fetchCategories()])
      .then(([r, c]) => {
        setRules(r);
        setCategories(c);
      })
      .catch((err: unknown) => setError(message(err)));
  }, []);

  useEffect(reload, [reload]);

  async function run(action: () => Promise<string | null>) {
    setError(null);
    setInfo(null);
    try {
      const text = await action();
      if (text) setInfo(text);
      reload();
      notifyDataChanged();
    } catch (err) {
      setError(message(err));
    }
  }

  async function handleCreate(input: RuleInput) {
    await createRule(input);
    setInfo('Regel angelegt. Sie läuft bei jedem Import; für den Bestand „Regeln anwenden“.');
    reload();
  }

  async function handleUpdate(id: number, input: RuleInput) {
    await updateRule(id, input);
    setEditingId(null);
    reload();
  }

  async function handleApply() {
    setBusy(true);
    await run(async () => {
      const result = await applyAllRules();
      return `${result.categorized} unkategorisierte Buchung(en) kategorisiert. Von Hand gesetzte Kategorien bleiben unberührt.`;
    });
    setBusy(false);
  }

  function handleDelete(rule: Rule) {
    const ok = window.confirm(`Regel „${rule.pattern}“ → ${rule.categoryPath} löschen?`);
    if (!ok) return;
    const unassign =
      rule.assignedCount > 0 &&
      window.confirm(
        `${rule.assignedCount} Buchung(en) hat diese Regel kategorisiert.\n` +
          'OK = deren Kategorie ebenfalls entfernen\nAbbrechen = Kategorie behalten',
      );
    void run(async () => {
      const result = await deleteRule(rule.id, unassign);
      return unassign ? `Regel gelöscht, ${result.unassigned} Buchung(en) wieder unkategorisiert.` : 'Regel gelöscht.';
    });
  }

  return (
    <section>
      <h2>Regeln</h2>
      <p className="hint">
        Regeln ordnen Buchungen beim Import automatisch einer Kategorie zu. Bei mehreren passenden Regeln gewinnt die höhere
        Priorität, bei Gleichstand das längere Muster. Von Hand gesetzte Kategorien werden nie überschrieben.
      </p>

      <div className="toolbar">
        <button type="button" onClick={() => void handleApply()} disabled={busy || rules.length === 0}>
          Regeln auf unkategorisierte Buchungen anwenden
        </button>
      </div>

      {error && <p className="error panel">{error}</p>}
      {info && <p className="panel notice">{info}</p>}

      {rules.length === 0 ? (
        <p>Noch keine Regeln. Regeln entstehen hier oder als Vorschlag, wenn du in der Buchungsliste eine Kategorie setzt.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th className="num">Priorität</th>
              <th>Feld</th>
              <th>Mustertyp</th>
              <th>Muster</th>
              <th>Kategorie</th>
              <th className="num" title="Buchungen, auf die das Muster aktuell passt">Treffer</th>
              <th className="num" title="Buchungen, deren Kategorie diese Regel gesetzt hat">zugeordnet</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) =>
              editingId === rule.id ? (
                <tr key={rule.id}>
                  <td colSpan={9}>
                    <RuleForm
                      categories={categories}
                      initial={rule}
                      submitLabel="Speichern"
                      onSubmit={(input) => handleUpdate(rule.id, input)}
                      onCancel={() => setEditingId(null)}
                    />
                  </td>
                </tr>
              ) : (
                <tr key={rule.id} className={rule.active ? undefined : 'inactive'}>
                  <td className="num">{rule.priority}</td>
                  <td>{RULE_FIELD_LABELS[rule.field]}</td>
                  <td>{PATTERN_TYPE_LABELS[rule.patternType]}</td>
                  <td className="pattern">{rule.pattern}</td>
                  <td>
                    {rule.categoryPath}
                    {!rule.categoryActive && <small className="warnings block">Kategorie deaktiviert – Regel greift nicht</small>}
                  </td>
                  <td className="num">{rule.matchCount}</td>
                  <td className="num">
                    {rule.assignedCount > 0 ? (
                      <a href={hrefFor('buchungen', { categoryId: rule.categoryId })}>{rule.assignedCount}</a>
                    ) : (
                      0
                    )}
                  </td>
                  <td>{rule.active ? 'aktiv' : 'inaktiv'}</td>
                  <td className="row-actions">
                    <button type="button" onClick={() => setEditingId(rule.id)}>
                      Bearbeiten
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void run(async () => {
                          await updateRule(rule.id, { active: !rule.active });
                          return null;
                        })
                      }
                    >
                      {rule.active ? 'Deaktivieren' : 'Aktivieren'}
                    </button>
                    <button type="button" onClick={() => handleDelete(rule)}>
                      Löschen
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}

      <h3>Neue Regel</h3>
      <RuleForm categories={categories} submitLabel="Regel anlegen" onSubmit={handleCreate} />
    </section>
  );
}
