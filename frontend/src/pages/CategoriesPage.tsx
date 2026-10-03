import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  createCategory,
  deleteCategory,
  fetchCategories,
  updateCategory,
  type Category,
  type CategoryPatch,
} from '../api/categories';
import { BucketSelect, bucketChoiceOf, bucketFields, type BucketChoice } from '../components/BucketSelect';
import { notifyDataChanged } from '../lib/events';
import { hrefFor } from '../lib/route';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function CategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);

  const reload = useCallback(() => {
    fetchCategories()
      .then(setCategories)
      .catch((err: unknown) => setError(message(err)));
  }, []);

  useEffect(reload, [reload]);

  const roots = categories.filter((c) => c.parentId === null);
  const byId = new Map(categories.map((c) => [c.id, c]));

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setError(null);
    try {
      await action();
      reload();
      notifyDataChanged();
      return true;
    } catch (err) {
      setError(message(err));
      return false;
    }
  }

  const patch = (id: number, changes: CategoryPatch) => run(() => updateCategory(id, changes));

  function handleDelete(category: Category) {
    if (!window.confirm(`Kategorie „${category.path}“ löschen?`)) return;
    void run(() => deleteCategory(category.id));
  }

  return (
    <section>
      <h2>Kategorien</h2>
      <p className="hint">
        Der Bucket bestimmt die 50/30/20-Auswertung. Unterkategorien erben ihn von der Elternkategorie, können aber
        abweichen. Umbenennen und Aufteilen in Unterkategorien lässt bestehende Zuordnungen unverändert.
      </p>
      {error && <p className="error panel">{error}</p>}

      <table className="data categories">
        <thead>
          <tr>
            <th>Kategorie</th>
            <th>Bucket</th>
            <th className="num">Buchungen</th>
            <th className="num">Regeln</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {categories.map((c) => {
            const parent = c.parentId === null ? undefined : byId.get(c.parentId);
            return editingId === c.id ? (
              <tr key={c.id}>
                <td colSpan={6}>
                  <CategoryEditForm
                    category={c}
                    roots={roots}
                    onSave={async (changes) => {
                      if (await patch(c.id, changes)) setEditingId(null);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                </td>
              </tr>
            ) : (
              <tr key={c.id} className={c.active ? undefined : 'inactive'}>
                <td className={c.parentId === null ? 'category-root' : 'category-child'}>{c.name}</td>
                <td>
                  <BucketSelect
                    value={bucketChoiceOf(c)}
                    parentBucket={parent ? parent.effectiveBucket : undefined}
                    onChange={(choice) => void patch(c.id, bucketFields(choice))}
                  />
                </td>
                <td className="num">
                  {c.transactionCount > 0 ? (
                    <a href={hrefFor('buchungen', { categoryId: c.id })}>{c.transactionCount}</a>
                  ) : (
                    0
                  )}
                </td>
                <td className="num">{c.ruleCount > 0 ? <a href={hrefFor('regeln')}>{c.ruleCount}</a> : 0}</td>
                <td>{c.active ? 'aktiv' : 'deaktiviert'}</td>
                <td className="row-actions">
                  <button type="button" onClick={() => setEditingId(c.id)}>
                    Bearbeiten
                  </button>
                  <button type="button" onClick={() => void patch(c.id, { active: !c.active })}>
                    {c.active ? 'Deaktivieren' : 'Aktivieren'}
                  </button>
                  {c.transactionCount === 0 && c.ruleCount === 0 && c.childCount === 0 && (
                    <button type="button" onClick={() => handleDelete(c)}>
                      Löschen
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3>Neue Kategorie</h3>
      <NewCategoryForm roots={roots.filter((r) => r.active)} onCreate={(input) => run(() => createCategory(input))} />
    </section>
  );
}

function CategoryEditForm({
  category,
  roots,
  onSave,
  onCancel,
}: {
  category: Category;
  roots: Category[];
  onSave: (changes: CategoryPatch) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [parentId, setParentId] = useState<number | null>(category.parentId);
  const parents = roots.filter((r) => r.id !== category.id);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const changes: CategoryPatch = { name };
    if (parentId !== category.parentId) changes.parentId = parentId;
    void onSave(changes);
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
      </label>
      <label>
        Elternkategorie
        <select
          value={parentId ?? ''}
          onChange={(e) => setParentId(e.target.value === '' ? null : Number(e.target.value))}
          disabled={category.childCount > 0}
          title={category.childCount > 0 ? 'Hat selbst Unterkategorien' : undefined}
        >
          <option value="">– keine (Wurzelkategorie) –</option>
          {parents.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <div className="form-actions">
        <button type="submit">Speichern</button>
        <button type="button" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}

function NewCategoryForm({
  roots,
  onCreate,
}: {
  roots: Category[];
  onCreate: (input: { name: string; parentId: number | null; bucket?: Category['bucket']; inheritBucket: boolean }) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<number | null>(null);
  const [bucket, setBucket] = useState<BucketChoice>('none');
  const parent = roots.find((r) => r.id === parentId);

  function changeParent(id: number | null) {
    setParentId(id);
    // Unterkategorien erben standardmäßig.
    setBucket(id === null ? 'none' : 'inherit');
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (await onCreate({ name, parentId, ...bucketFields(bucket) })) {
      setName('');
    }
  }

  return (
    <form className="panel inline-form" onSubmit={(e) => void handleSubmit(e)}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
      </label>
      <label>
        Unterkategorie von
        <select value={parentId ?? ''} onChange={(e) => changeParent(e.target.value === '' ? null : Number(e.target.value))}>
          <option value="">– keine (Wurzelkategorie) –</option>
          {roots.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Bucket
        <BucketSelect value={bucket} onChange={setBucket} parentBucket={parent ? parent.effectiveBucket : undefined} />
      </label>
      <div className="form-actions">
        <button type="submit">Kategorie anlegen</button>
      </div>
    </form>
  );
}
