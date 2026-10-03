-- 007_recurring.sql – Fixkosten und Abos (Phase 6, CLAUDE.md § 14).
-- NIE nachträglich ändern; Änderungen kommen als neue Migration.

-- ---------------------------------------------------------------------------
-- Fixkosten/Abos: Merkmale für den Soll/Ist-Abgleich und die Erkennung
-- ---------------------------------------------------------------------------
-- SEPA-Merkmale: starke Schlüssel für die Zuordnung von Buchungen, unabhängig
-- von der Schreibweise der Gegenpartei.
ALTER TABLE recurring_items ADD COLUMN creditor_id TEXT;
ALTER TABLE recurring_items ADD COLUMN mandate_reference TEXT;

-- Schlüssel der automatischen Erkennung (siehe services/recurring.ts). Ein
-- übernommener oder verworfener Vorschlag wird darüber wiedererkannt und
-- nicht erneut vorgeschlagen.
ALTER TABLE recurring_items ADD COLUMN detection_key TEXT;
CREATE UNIQUE INDEX recurring_items_detection_key ON recurring_items (detection_key) WHERE detection_key IS NOT NULL;

-- Kündigungsfrist zum Vertragsende (contract_end_date), z. B. 3 Monate.
ALTER TABLE recurring_items ADD COLUMN notice_period_value INTEGER
  CHECK (notice_period_value IS NULL OR notice_period_value > 0);
ALTER TABLE recurring_items ADD COLUMN notice_period_unit TEXT
  CHECK (notice_period_unit IS NULL OR notice_period_unit IN ('days', 'weeks', 'months'));

-- ---------------------------------------------------------------------------
-- Buchungen: Zuordnung zu Fixkosten/Abos von Hand
-- ---------------------------------------------------------------------------
-- 'manual' mit recurring_item_id = von Hand als dieser Posten markiert;
-- 'manual' ohne recurring_item_id = bewusst „nicht wiederkehrend“ (eine
-- Fehlerkennung entfernt). NULL = die Zuordnung ergibt sich automatisch aus
-- den Merkmalen des Postens (wird bei jeder Anzeige berechnet, nicht gespeichert).
ALTER TABLE transactions ADD COLUMN recurring_source TEXT
  CHECK (recurring_source IS NULL OR recurring_source = 'manual');
