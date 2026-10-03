-- 002_seed_categories.sql – Startkategorien mit 50/30/20-Bucket (CLAUDE.md § 8).
-- Danach gehören die Kategorien dem Nutzer: umbenennen, teilen, Bucket ändern
-- geschieht über die Oberfläche. NIE nachträglich ändern.

INSERT INTO categories (name, parent_id, bucket, inherit_bucket, created_at) VALUES
  -- need
  ('Wohnen & Nebenkosten',      NULL, 'need', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Lebensmittel',              NULL, 'need', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Mobilität',                 NULL, 'need', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Versicherungen',            NULL, 'need', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Gesundheit',                NULL, 'need', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- want
  ('Freizeit & Unterhaltung',   NULL, 'want', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Shopping & Kleidung',       NULL, 'want', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Restaurants & Cafés',       NULL, 'want', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Abos & Mitgliedschaften',   NULL, 'want', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Urlaub & Reisen',           NULL, 'want', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Bildung & Weiterbildung',   NULL, 'want', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Geschenke & Spenden',       NULL, 'want', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- save
  ('Sparen',                    NULL, 'save', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Investieren',               NULL, 'save', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Altersvorsorge',            NULL, 'save', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- ohne Bucket
  ('Einkommen',                 NULL, NULL,   0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Bargeldabhebungen',         NULL, NULL,   0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Sonstiges',                 NULL, NULL,   0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Umbuchung',                 NULL, NULL,   0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
