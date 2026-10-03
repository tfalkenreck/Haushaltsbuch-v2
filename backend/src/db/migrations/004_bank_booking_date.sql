-- 004_bank_booking_date.sql – Buchungstag der Bank zusätzlich speichern.
-- NIE nachträglich ändern; Änderungen kommen als neue Migration.
--
-- Bei Kartenumsätzen ist booking_date das Kaufdatum („Umsatz vom …“,
-- CLAUDE.md § 19). Die Bank filtert ihren Export aber nach ihrem
-- Buchungstag. Zeitraum-Prüfung und Abdeckung brauchen deshalb den
-- Buchungstag der Bank; alle Auswertungen bleiben beim Kaufdatum.

ALTER TABLE transactions ADD COLUMN bank_booking_date TEXT
  CHECK (bank_booking_date IS NULL OR bank_booking_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');

-- Bestand: ohne „Umsatz vom“ im Verwendungszweck hat der Adapter den
-- Buchungstag der Bank übernommen. Kartenumsätze bleiben NULL – ihr
-- Buchungstag ist nicht mehr bekannt; die Oberfläche bittet darum, diese
-- Importe einmal rückgängig zu machen und neu zu importieren.
UPDATE transactions SET bank_booking_date = booking_date WHERE purpose NOT LIKE '%Umsatz vom%';

CREATE INDEX transactions_account_bank_date ON transactions (account_id, bank_booking_date);
