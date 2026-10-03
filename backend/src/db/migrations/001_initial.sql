-- 001_initial.sql – vollständiges Datenmodell (CLAUDE.md § 7).
-- NIE nachträglich ändern; Änderungen kommen als neue Migration.
--
-- Konventionen:
--   * STRICT-Tabellen: SQLite erzwingt die Spaltentypen. Ein Betrag als
--     REAL (z. B. 12.5) wird abgelehnt – Geld ist immer INTEGER in Cent.
--   * Datum als ISO-8601-Text YYYY-MM-DD, Zeitstempel als ISO-8601 mit Uhrzeit.
--   * Vorzeichen: amount_cents < 0 = Abfluss, > 0 = Zufluss.
--   * Konten werden deaktiviert, nicht gelöscht (ON DELETE RESTRICT).

-- ---------------------------------------------------------------------------
-- Konten
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  role          TEXT    NOT NULL
                CHECK (role IN ('einnahmen', 'ausgaben', 'sparen', 'kreditkarte')),
  -- Kennung des Bank-Adapters (z. B. 'volksbank-owl'). Gültige Werte prüft
  -- das Backend gegen die Adapter-Registry, damit neue Adapter keine
  -- Migration brauchen.
  bank_adapter  TEXT    NOT NULL CHECK (length(bank_adapter) > 0),
  -- Eigene IBAN, normalisiert (ohne Leerzeichen, Großbuchstaben).
  iban          TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
) STRICT;

CREATE UNIQUE INDEX accounts_iban_unique ON accounts (iban) WHERE iban IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Importvorgänge – Einheit für „Rückgängig“
-- ---------------------------------------------------------------------------
CREATE TABLE import_batches (
  id                 INTEGER PRIMARY KEY,
  account_id         INTEGER NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  bank_adapter       TEXT    NOT NULL,
  file_name          TEXT    NOT NULL,
  -- SHA-256 des Dateiinhalts, um erneutes Einlesen derselben Datei zu erkennen.
  file_sha256        TEXT    NOT NULL,
  imported_at        TEXT    NOT NULL,
  -- Von der Datei abgedeckter Zeitraum (Buchungsdatum), für die Abdeckung.
  period_start       TEXT,
  period_end         TEXT,
  rows_total         INTEGER NOT NULL DEFAULT 0 CHECK (rows_total >= 0),
  rows_imported      INTEGER NOT NULL DEFAULT 0 CHECK (rows_imported >= 0),
  rows_duplicate     INTEGER NOT NULL DEFAULT 0 CHECK (rows_duplicate >= 0),
  CHECK (period_start IS NULL OR period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (period_end   IS NULL OR period_end   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
) STRICT;

CREATE INDEX import_batches_account ON import_batches (account_id);

-- ---------------------------------------------------------------------------
-- Kategorien (zweistufig: Wurzel + optionale Unterkategorien)
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id             INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  parent_id      INTEGER REFERENCES categories (id) ON DELETE RESTRICT,
  -- Bucket für 50/30/20; NULL = fließt nicht in die Rechnung ein.
  bucket         TEXT    CHECK (bucket IN ('need', 'want', 'save')),
  -- Nur für Unterkategorien: 1 = Bucket der Elternkategorie übernehmen
  -- (bucket wird dann ignoriert), 0 = eigener Bucket (auch „keiner“).
  inherit_bucket INTEGER NOT NULL DEFAULT 0 CHECK (inherit_bucket IN (0, 1)),
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at     TEXT    NOT NULL,
  CHECK (parent_id IS NOT NULL OR inherit_bucket = 0),
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;

CREATE UNIQUE INDEX categories_name_unique
  ON categories (coalesce(parent_id, 0), name COLLATE NOCASE);
CREATE INDEX categories_parent ON categories (parent_id);

-- ---------------------------------------------------------------------------
-- Regeln für die automatische Kategorisierung
-- ---------------------------------------------------------------------------
CREATE TABLE rules (
  id            INTEGER PRIMARY KEY,
  -- Worauf das Muster angewendet wird.
  field         TEXT    NOT NULL CHECK (field IN ('counterparty', 'purpose')),
  -- 'contains' = einfacher Suchtext (case-insensitive, keine Sonderzeichen),
  -- 'wildcard' = Ausdruck mit Platzhaltern. Explizit, nie geraten.
  pattern_type  TEXT    NOT NULL CHECK (pattern_type IN ('contains', 'wildcard')),
  pattern       TEXT    NOT NULL CHECK (length(pattern) > 0),
  category_id   INTEGER NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  -- Höher gewinnt.
  priority      INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
) STRICT;

CREATE INDEX rules_category ON rules (category_id);

-- ---------------------------------------------------------------------------
-- Fixkosten und Abos (manuell angelegt oder automatisch vorgeschlagen)
-- ---------------------------------------------------------------------------
CREATE TABLE recurring_items (
  id                      INTEGER PRIMARY KEY,
  name                    TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  kind                    TEXT    NOT NULL DEFAULT 'fixed_cost'
                          CHECK (kind IN ('fixed_cost', 'subscription')),
  account_id              INTEGER REFERENCES accounts (id) ON DELETE RESTRICT,
  counterparty            TEXT    NOT NULL DEFAULT '',
  counterparty_normalized TEXT    NOT NULL DEFAULT '',
  -- Soll-Betrag mit Vorzeichen wie in transactions (Abbuchung < 0).
  amount_cents            INTEGER NOT NULL,
  interval                TEXT    NOT NULL
                          CHECK (interval IN ('biweekly', 'monthly', 'quarterly', 'semiannual', 'annual')),
  next_due_date           TEXT
                          CHECK (next_due_date IS NULL OR next_due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  contract_end_date       TEXT
                          CHECK (contract_end_date IS NULL OR contract_end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  category_id             INTEGER REFERENCES categories (id) ON DELETE RESTRICT,
  origin                  TEXT    NOT NULL CHECK (origin IN ('manual', 'auto')),
  -- suggested = von der Erkennung vorgeschlagen, confirmed = vom Menschen
  -- übernommen bzw. angelegt, dismissed = als Fehlerkennung verworfen
  -- (damit die Erkennung sie nicht erneut vorschlägt).
  status                  TEXT    NOT NULL CHECK (status IN ('suggested', 'confirmed', 'dismissed')),
  -- 1 = nur vermutet (z. B. jährlicher Posten ohne mehrjährige Daten).
  is_suspected            INTEGER NOT NULL DEFAULT 0 CHECK (is_suspected IN (0, 1)),
  active                  INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notes                   TEXT,
  created_at              TEXT    NOT NULL,
  updated_at              TEXT    NOT NULL
) STRICT;

CREATE INDEX recurring_items_counterparty ON recurring_items (counterparty_normalized);

-- ---------------------------------------------------------------------------
-- Umbuchungen zwischen eigenen Konten
--   pair            1:1, beide Seiten importiert (2 Buchungen mit transfer_id)
--   one_sided       vermutet, Gegenkonto nicht importiert (1 Buchung)
--   card_settlement 1:n Kartenabrechnung: die Sammelabbuchung (und ggf. die
--                   Gutschrift auf dem Kartenkonto) tragen transfer_id; die
--                   Kartenumsätze des Abrechnungszeitraums bleiben echte
--                   Ausgaben und werden über to_account_id + Zeitraum
--                   zugeordnet.
-- ---------------------------------------------------------------------------
CREATE TABLE transfers (
  id               INTEGER PRIMARY KEY,
  kind             TEXT    NOT NULL CHECK (kind IN ('pair', 'one_sided', 'card_settlement')),
  origin           TEXT    NOT NULL CHECK (origin IN ('auto', 'manual')),
  status           TEXT    NOT NULL CHECK (status IN ('suggested', 'confirmed')),
  -- Belastetes bzw. gutgeschriebenes Konto; NULL, wenn nicht angelegt/bekannt.
  from_account_id  INTEGER REFERENCES accounts (id) ON DELETE RESTRICT,
  to_account_id    INTEGER REFERENCES accounts (id) ON DELETE RESTRICT,
  -- Betrag der Umbuchung, immer positiv.
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  -- Abrechnungszeitraum (nur card_settlement).
  period_start     TEXT
                   CHECK (period_start IS NULL OR period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  period_end       TEXT
                   CHECK (period_end IS NULL OR period_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Woran die Erkennung festgemacht wurde (Betrag/Datum, IBAN, Verwendungszweck …).
  detection_reason TEXT,
  notes            TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  CHECK (kind <> 'card_settlement' OR (period_start IS NOT NULL AND period_end IS NOT NULL))
) STRICT;

-- ---------------------------------------------------------------------------
-- Sparziele
-- ---------------------------------------------------------------------------
CREATE TABLE savings_goals (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  target_cents  INTEGER NOT NULL CHECK (target_cents > 0),
  target_date   TEXT
                CHECK (target_date IS NULL OR target_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Kleinere Zahl = wichtiger; Ziele werden in dieser Reihenfolge bespart.
  priority      INTEGER NOT NULL DEFAULT 0,
  -- Konto, aus dessen Saldo sich der aktuelle Stand ergibt.
  account_id    INTEGER REFERENCES accounts (id) ON DELETE RESTRICT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- Buchungen
-- ---------------------------------------------------------------------------
CREATE TABLE transactions (
  id                      INTEGER PRIMARY KEY,
  account_id              INTEGER NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  booking_date            TEXT    NOT NULL
                          CHECK (booking_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  value_date              TEXT
                          CHECK (value_date IS NULL OR value_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount_cents            INTEGER NOT NULL,
  currency                TEXT    NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3),
  counterparty            TEXT    NOT NULL DEFAULT '',
  -- Basis für Regeln, Abo- und Umbuchungserkennung; jederzeit neu berechenbar.
  counterparty_normalized TEXT    NOT NULL DEFAULT '',
  -- IBAN der Gegenpartei, falls die Bank sie liefert (Umbuchungserkennung).
  counterparty_iban       TEXT,
  purpose                 TEXT    NOT NULL DEFAULT '',

  category_id             INTEGER REFERENCES categories (id) ON DELETE RESTRICT,
  -- Herkunft der Kategorie. 'manual' wird von Automatik nie überschrieben;
  -- 'manual' mit category_id NULL = bewusst unkategorisiert gelassen.
  category_source         TEXT    CHECK (category_source IN ('manual', 'rule', 'auto')),
  -- Regel, die die Kategorie gesetzt hat (nur bei category_source = 'rule').
  category_rule_id        INTEGER REFERENCES rules (id) ON DELETE SET NULL,

  recurring_item_id       INTEGER REFERENCES recurring_items (id) ON DELETE SET NULL,

  transfer_id             INTEGER REFERENCES transfers (id) ON DELETE SET NULL,
  -- Herkunft der Umbuchungszuordnung. 'manual' mit transfer_id NULL =
  -- bewusst als „keine Umbuchung“ markiert; die Erkennung lässt sie dann in Ruhe.
  transfer_source         TEXT    CHECK (transfer_source IN ('manual', 'auto')),

  import_batch_id         INTEGER REFERENCES import_batches (id) ON DELETE RESTRICT,
  -- SHA-256 über account_id, Buchungsdatum, Betrag, Verwendungszweck.
  import_hash             TEXT    NOT NULL UNIQUE,
  imported_at             TEXT    NOT NULL,
  notes                   TEXT,

  CHECK (category_id IS NULL OR category_source IS NOT NULL),
  CHECK (transfer_id IS NULL OR transfer_source IS NOT NULL)
) STRICT;

CREATE INDEX transactions_account_date   ON transactions (account_id, booking_date);
CREATE INDEX transactions_booking_date   ON transactions (booking_date);
CREATE INDEX transactions_category       ON transactions (category_id);
CREATE INDEX transactions_transfer       ON transactions (transfer_id);
CREATE INDEX transactions_recurring_item ON transactions (recurring_item_id);
CREATE INDEX transactions_import_batch   ON transactions (import_batch_id);
CREATE INDEX transactions_counterparty   ON transactions (counterparty_normalized);
