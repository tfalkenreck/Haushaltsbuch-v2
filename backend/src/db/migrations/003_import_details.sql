-- 003_import_details.sql – Zusatzfelder für den Import (Phase 2).
-- NIE nachträglich ändern; Änderungen kommen als neue Migration.
--
-- Quelle: docs/bankformate.md § 1.1, § 2.2 und § 3.

-- ---------------------------------------------------------------------------
-- Buchungen: Merkmale, die die Banken mitliefern
-- ---------------------------------------------------------------------------

-- Vorgangsart der Bank (Volksbank „Buchungstext“, Comdirect „Vorgang“),
-- z. B. „Kartenzahlung girocard“, „Lastschrift / Belastung“.
ALTER TABLE transactions ADD COLUMN booking_text TEXT NOT NULL DEFAULT '';

-- SEPA-Lastschrift-Merkmale – starke Schlüssel für die Abo-Erkennung (Phase 6).
ALTER TABLE transactions ADD COLUMN creditor_id TEXT;
ALTER TABLE transactions ADD COLUMN mandate_reference TEXT;

-- Saldo nach der Buchung in Cent, falls die Bank ihn pro Zeile liefert
-- (Volksbank). Grundlage für die Saldoentwicklung (§ 12.5).
ALTER TABLE transactions ADD COLUMN balance_after_cents INTEGER;

-- Referenz der Bank (Comdirect „Ref. …“). Bewusst nicht im
-- Verwendungszweck und nicht im import_hash.
ALTER TABLE transactions ADD COLUMN bank_reference TEXT;

-- ---------------------------------------------------------------------------
-- Importvorgänge: Saldo laut Datei und übersprungene Zeilen
-- ---------------------------------------------------------------------------

-- Kontostand laut Datei (Volksbank: Saldo der jüngsten Zeile; Comdirect:
-- Kontostand aus den Metadaten, falls vorhanden) und sein Stichtag.
ALTER TABLE import_batches ADD COLUMN balance_cents INTEGER;
ALTER TABLE import_batches ADD COLUMN balance_date TEXT
  CHECK (balance_date IS NULL OR balance_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');

-- Zeilen, die bewusst nicht importiert wurden: anderes Auftragskonto,
-- vorgemerkte („offen“) Umsätze, unlesbare Zeilen.
ALTER TABLE import_batches ADD COLUMN rows_skipped INTEGER NOT NULL DEFAULT 0 CHECK (rows_skipped >= 0);

-- ---------------------------------------------------------------------------
-- Ein Adapter für Volksbank Giro, Sparkonto und Visa
-- ---------------------------------------------------------------------------

-- Girokonto und Visa exportieren dasselbe Format; die Kartenbesonderheiten
-- erkennt der Parser am Inhalt der Zeile. Der frühere Eintrag
-- 'volksbank-visa' entfällt, bestehende Konten wechseln auf 'volksbank-owl'.
UPDATE accounts SET bank_adapter = 'volksbank-owl' WHERE bank_adapter = 'volksbank-visa';
UPDATE import_batches SET bank_adapter = 'volksbank-owl' WHERE bank_adapter = 'volksbank-visa';
