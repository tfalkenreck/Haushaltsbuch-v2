import { comdirectAdapter } from './comdirect.js';
import type { BankAdapter } from './types.js';
import { volksbankOwlAdapter } from './volksbank-owl.js';

/**
 * Verfügbare Bank-Adapter. Ein Konto speichert nur die Kennung (`id`);
 * welcher Adapter zu einem Konto gehört, wählt der Nutzer – nie aus
 * Kontoname oder Bank abgeleitet.
 */
export interface BankAdapterInfo {
  id: string;
  label: string;
}

const ADAPTERS: readonly BankAdapter[] = [volksbankOwlAdapter, comdirectAdapter];

export const BANK_ADAPTERS: readonly BankAdapterInfo[] = ADAPTERS.map(({ id, label }) => ({ id, label }));

export function isBankAdapterId(id: string): boolean {
  return ADAPTERS.some((adapter) => adapter.id === id);
}

export function getBankAdapter(id: string): BankAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.id === id);
}

/** Kennungen aller Adapter außer `id` – für Fehlermeldungen. */
export function otherAdapterIds(id: string): string[] {
  return ADAPTERS.filter((adapter) => adapter.id !== id).map((adapter) => adapter.id);
}

/** Adapter (außer `id`), deren Kopfzeile in der Datei steckt. */
export function detectAdapters(bytes: Uint8Array, exceptId: string): string[] {
  return ADAPTERS.filter((adapter) => adapter.id !== exceptId && adapter.detect(bytes)).map((adapter) => adapter.id);
}
