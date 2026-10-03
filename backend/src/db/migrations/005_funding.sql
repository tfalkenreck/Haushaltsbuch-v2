-- 005_funding.sql – Abrechnungsdatum der Karte, Kontostände von Hand,
-- Entscheidungen zu Ausgaben am Ausgabenkonto vorbei (Phase 5).
-- NIE nachträglich ändern; Änderungen kommen als neue Migration.

-- ---------------------------------------------------------------------------
-- Kartenabrechnung: nach welchem Datum der Zeitraum bemessen ist
-- ---------------------------------------------------------------------------
-- 'bank_booking_date' = Buchungstag der Bank bis einschließlich des
--                       Abrechnungsdatums aus „Abrechnung vom TT.MM.JJJJ“
-- 'booking_date'      = Kaufdatum (Verfahren ohne Abrechnungsdatum)
-- NULL                = vor Migration 005 bestimmt (Kaufdatum); wird bei der
--                       nächsten Erkennung einmalig neu berechnet.
ALTER TABLE transfers ADD COLUMN period_basis TEXT
  CHECK (period_basis IS NULL OR period_basis IN ('bank_booking_date', 'booking_date'));

-- ---------------------------------------------------------------------------
-- Kontostand von Hand (CLAUDE.md § 12.5)
-- ---------------------------------------------------------------------------
-- Für Konten, deren Export keinen Saldo liefert (Comdirect): Kontostand am
-- Ende des Tages `balance_date`, also nach allen Buchungen dieses Tages.
-- Der Verlauf wird daraus über die Buchungen vor- und zurückgerechnet.
CREATE TABLE balance_anchors (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  balance_date  TEXT    NOT NULL
                CHECK (balance_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  balance_cents INTEGER NOT NULL,
  notes         TEXT,
  created_at    TEXT    NOT NULL
) STRICT;

CREATE UNIQUE INDEX balance_anchors_account_date ON balance_anchors (account_id, balance_date);

-- ---------------------------------------------------------------------------
-- Ausgaben am Ausgabenkonto vorbei (CLAUDE.md § 13)
-- ---------------------------------------------------------------------------
-- Entscheidung pro wiederkehrendem Posten auf einem Einnahmenkonto, damit
-- die Liste nicht jeden Monat dieselben Fälle zeigt.
--   move = soll aufs Ausgabenkonto umgestellt werden
--   keep = bleibt bewusst hier
-- `item_key` ist der Gruppierungsschlüssel des Postens (normalisierte
-- Gegenpartei bzw. Gläubiger-ID), siehe services/bypass.ts.
CREATE TABLE bypass_decisions (
  id                INTEGER PRIMARY KEY,
  source_account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  item_key          TEXT    NOT NULL CHECK (length(item_key) > 0),
  decision          TEXT    NOT NULL CHECK (decision IN ('move', 'keep')),
  -- Ziel der Umstellung (Ausgabenkonto); NULL = noch nicht festgelegt.
  target_account_id INTEGER REFERENCES accounts (id) ON DELETE RESTRICT,
  notes             TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
) STRICT;

CREATE UNIQUE INDEX bypass_decisions_item ON bypass_decisions (source_account_id, item_key);
