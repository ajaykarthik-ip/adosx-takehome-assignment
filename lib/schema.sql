-- Schema for the ADOSX reconciliation exercise.
--
-- Three ideas drive the shape of these tables:
--
-- 1. Money is stored as INTEGER minor units (paise), never REAL. SQLite's REAL
--    is an IEEE double and would reintroduce the float error we parse around.
--
-- 2. Every column that arrived dirty is stored twice: the cleaned value, and
--    the raw text exactly as it appeared in the CSV. If a value could not be
--    parsed the cleaned column is NULL and the raw column still holds the
--    original, so no input is ever lost. `import_issues` says why.
--
-- 3. The fact tables carry no foreign key to `locations`. An export that
--    references an unknown location must still import; rejecting the row would
--    be exactly the silent drop the brief warns about. Unknown locations are
--    flagged at import time and resolved by LEFT JOIN at query time.

DROP TABLE IF EXISTS system_b_entries;
DROP TABLE IF EXISTS system_a_records;
DROP TABLE IF EXISTS locations;

-- locations.csv is the only place the location -> org (tenant) mapping exists.
CREATE TABLE locations (
  location_id   TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  location_name TEXT
);

CREATE INDEX idx_locations_org ON locations (org_id);

-- One row per event, as System A recorded it.
CREATE TABLE system_a_records (
  record_id         TEXT PRIMARY KEY,
  location_id       TEXT,
  event_date        TEXT,          -- ISO yyyy-mm-dd; TEXT sorts correctly in SQLite
  category_code     TEXT,
  actor_id          TEXT,          -- nullable: one row in this dataset has no actor

  -- Money, as exact integer minor units. NULL means "could not be parsed".
  base_value_minor  INTEGER,
  adjustment_minor  INTEGER,
  total_value_minor INTEGER,

  -- The original text for every money column, kept verbatim.
  raw_base_value    TEXT,
  raw_adjustment    TEXT,
  raw_total_value   TEXT,

  state             TEXT,          -- CONFIRMED / VOIDED

  source_line       INTEGER,       -- line number in system_a.csv, for tracing
  import_issues     TEXT           -- JSON array of strings; '[]' when clean
);

CREATE INDEX idx_a_location ON system_a_records (location_id);

-- One row per entry, as System B recorded it. There may be more than one
-- entry per System A record.
CREATE TABLE system_b_entries (
  entry_id        TEXT PRIMARY KEY,

  -- record_ref as it literally appeared in the file, e.g. " REC - 1070 ".
  record_ref_raw  TEXT,
  -- The same reference reduced to canonical form, e.g. "REC-1070".
  -- NULL when the reference could not be recognised at all.
  record_ref_key  TEXT,

  location_id     TEXT,
  recorded_on     TEXT,

  value_minor     INTEGER,         -- NULL means "could not be parsed"
  raw_value       TEXT,

  label           TEXT,
  -- Parsed from a label like "Entry part 2 of 2". Both NULL for a normal entry.
  -- These mark an entry as one piece of a deliberately split record, which is
  -- not the same thing as a duplicate.
  split_part_number INTEGER,
  split_part_total  INTEGER,

  source_line     INTEGER,
  import_issues   TEXT
);

CREATE INDEX idx_b_ref_key ON system_b_entries (record_ref_key);
CREATE INDEX idx_b_location ON system_b_entries (location_id);

-- A row the importer could not place in its table at all - in practice, a row
-- whose natural primary key collided with one already inserted. It is written
-- here verbatim instead of being thrown away, so "nothing is silently dropped"
-- holds literally: every input line ends up either in its table or in here.
CREATE TABLE import_rejects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  source_line INTEGER,
  raw_row     TEXT NOT NULL,   -- the original row as JSON
  reason      TEXT NOT NULL
);
