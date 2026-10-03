/**
 * Adapter-Interface (CLAUDE.md § 6): Ein Adapter liefert nur geparste
 * Rohbuchungen. Duplikaterkennung, Normalisierung, Regeln und
 * Umbuchungserkennung passieren zentral danach im Import-Service.
 *
 * Eine spätere Banking-API (FinTS/PSD2) oder CAMT.053 liefert dieselbe
 * Struktur.
 */
export interface RawTransaction {
  /** Zeile in der Datei (1-basiert), für Meldungen. */
  line: number;
  /**
   * YYYY-MM-DD – Datum für alle Auswertungen. Bei Kartenumsätzen das
   * Kaufdatum („Umsatz vom …“), sonst der Buchungstag der Bank.
   */
  bookingDate: string;
  /**
   * YYYY-MM-DD – Buchungstag laut Bank. Danach filtert die Bank ihren
   * Export; Grundlage für Exportzeitraum und Abdeckung.
   */
  bankBookingDate: string;
  /** YYYY-MM-DD */
  valueDate: string | null;
  /** Cent, < 0 = Abfluss. */
  amountCents: number;
  currency: string;
  counterparty: string;
  counterpartyIban: string | null;
  purpose: string;
  /** Vorgangsart der Bank (Volksbank „Buchungstext“, Comdirect „Vorgang“). */
  bookingText: string;
  creditorId: string | null;
  mandateReference: string | null;
  /** Saldo nach Buchung, falls die Bank ihn pro Zeile liefert. */
  balanceAfterCents: number | null;
  bankReference: string | null;
  /** Eigenes Konto laut Datei (IBAN Auftragskonto), normalisiert. */
  accountIban: string | null;
}

/** Zeile, die bewusst nicht als Buchung übernommen wird. */
export interface SkippedLine {
  line: number;
  reason: string;
}

export interface StatementBalance {
  /** null = Datei nennt kein Auftragskonto (gilt fürs gewählte Konto). */
  accountIban: string | null;
  cents: number;
  date: string | null;
}

export interface ParseResult {
  transactions: RawTransaction[];
  /** Vorgemerkte Umsätze (z. B. Buchungstag „offen“) – ändern sich noch. */
  pending: SkippedLine[];
  /** Fuß-, Summen- oder unlesbare Zeilen nach der Kopfzeile. */
  ignored: SkippedLine[];
  /**
   * Kontostand laut Datei je Auftragskonto (Volksbank: Saldo der jüngsten
   * Zeile; Comdirect: Kontostand aus den Metadaten). `date` null = Stichtag
   * unbekannt, dann gilt die jüngste Buchung der Datei.
   */
  statementBalances: StatementBalance[];
  /** Hinweise des Parsers, deutsch. */
  warnings: string[];
}

export interface BankAdapter {
  id: string;
  label: string;
  /** Erkennt die Kopfzeile des Formats (ohne zu parsen) – für Hinweise. */
  detect(bytes: Uint8Array): boolean;
  /** Wirft AdapterError, wenn die Datei nicht zum Format passt. */
  parse(bytes: Uint8Array): ParseResult;
}

/** Datei passt nicht zum Adapter. Die Meldung nennt den Adapter. */
export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}
