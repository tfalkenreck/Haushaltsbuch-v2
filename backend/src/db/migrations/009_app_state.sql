-- 009_app_state.sql – Betrieb (Phase 8). NIE nachträglich ändern; Änderungen
-- kommen als neue Migration.
--
-- Einzelne Zustandswerte der App, z. B. Zeitpunkt des letzten Exports
-- (`last_export_at`, ISO-8601 mit Uhrzeit) für den Hinweis auf der
-- Übersicht. Gehört nicht zu den exportierten Daten.
CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
