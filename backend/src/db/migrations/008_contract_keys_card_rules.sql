-- 008_contract_keys_card_rules.sql – Korrekturen nach dem Echtdaten-Test
-- von Phase 6/7. NIE nachträglich ändern; Änderungen kommen als neue Migration.

-- ---------------------------------------------------------------------------
-- Fixkosten/Abos: Gegen-IBAN als Merkmal eines Vertrags
-- ---------------------------------------------------------------------------
-- Schlüssel eines Vertrags (CLAUDE.md § 19): Mandatsreferenz vor
-- Gläubiger-ID vor Gegen-IBAN vor normalisierter Gegenpartei. Überweisungen
-- an verschiedene Empfänger mit demselben Namen (z. B. der Kontoinhaber
-- selbst: Gemeinschaftskonto, Strom-Dauerauftrag) unterscheiden sich nur
-- an der IBAN. Normalisiert wie accounts.iban (ohne Leerzeichen, groß).
ALTER TABLE recurring_items ADD COLUMN counterparty_iban TEXT;

-- ---------------------------------------------------------------------------
-- Kartenabrechnung: Datum, nach dem der Zeitraum bemessen ist
-- ---------------------------------------------------------------------------
-- Die Zuordnungsregel wird je Kartenkonto aus allen Abrechnungen bestimmt
-- (Kaufdatum, Buchungstag der Bank oder Valuta; Stichtag einschließlich
-- oder ausschließlich). period_start/period_end gelten einschließlich nach
-- diesem Datum. Ersetzt period_basis aus 005 (kennt keine Valuta);
-- period_basis wird nicht mehr gelesen.
ALTER TABLE transfers ADD COLUMN period_date TEXT
  CHECK (period_date IS NULL OR period_date IN ('booking_date', 'bank_booking_date', 'value_date'));

UPDATE transfers SET period_date = period_basis WHERE kind = 'card_settlement';
