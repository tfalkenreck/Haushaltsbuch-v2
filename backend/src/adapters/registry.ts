/**
 * Verfügbare Bank-Adapter. Ein Konto speichert nur die Kennung (`id`);
 * welcher Adapter zu einem Konto gehört, wählt der Nutzer – nie aus
 * Kontoname oder Bank abgeleitet.
 *
 * Die Parser selbst kommen in Phase 2 hinzu und werden hier eingetragen.
 */
export interface BankAdapterInfo {
  id: string;
  label: string;
}

export const BANK_ADAPTERS: readonly BankAdapterInfo[] = [
  { id: 'volksbank-owl', label: 'Volksbank OWL (Girokonto/Sparkonto)' },
  { id: 'volksbank-visa', label: 'Volksbank OWL Visa' },
  { id: 'comdirect', label: 'Comdirect' },
];

export function isBankAdapterId(id: string): boolean {
  return BANK_ADAPTERS.some((adapter) => adapter.id === id);
}
