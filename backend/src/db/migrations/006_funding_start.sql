-- 006_funding_start.sql – Startmonat der Deckungsprüfung von Hand festlegen.
-- NIE nachträglich ändern; Änderungen kommen als neue Migration.
--
-- Die Deckungsprüfung (CLAUDE.md § 12) wertet ab der letzten erkannten
-- Umstellung der Daueraufträge aus. Wer es besser weiß, legt den ersten
-- Monat der Auswertung hier fest; ohne Eintrag gilt die Erkennung.
CREATE TABLE funding_settings (
  account_id  INTEGER PRIMARY KEY REFERENCES accounts (id) ON DELETE RESTRICT,
  -- Erster ausgewerteter Monat `YYYY-MM`.
  start_month TEXT    NOT NULL CHECK (start_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  updated_at  TEXT    NOT NULL
) STRICT;
