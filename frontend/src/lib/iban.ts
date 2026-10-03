/** Zeigt eine IBAN in Vierergruppen: DE17 1234 5678 0000 0000 01. */
export function formatIban(iban: string): string {
  return iban.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ');
}
