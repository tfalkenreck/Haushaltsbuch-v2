import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Liest eine Fixture-Datei als rohe Bytes (Encoding bleibt erhalten). */
export function fixture(path: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url))));
}

// IBANs der synthetischen Fixtures (Dokumentations-Beispiel-IBANs bzw.
// erfundene BLZ 12345678, alle mit gültiger Prüfziffer).
export const IBAN = {
  volksbankGiro: 'DE89370400440532013000',
  volksbankVisa: 'DE12500105170648489890',
  volksbankSpar: 'DE60123456780000000003',
  comdirectGiro: 'DE33123456780000000004',
} as const;
