-- The telemetry worker's D1 database. One row per event: its own fields, and the hour it arrived. No IP address,
-- header, country or exact time is kept.
--
--   npx wrangler d1 execute unbrowse-telemetry --remote --file schema.sql

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  received_hour INTEGER NOT NULL,  -- Unix seconds, the start of the hour
  event TEXT NOT NULL,
  version TEXT NOT NULL,
  os TEXT NOT NULL,
  install_id TEXT NOT NULL,
  tool TEXT,
  outcome TEXT NOT NULL,
  duration_ms INTEGER,
  error_class TEXT,
  from_tag TEXT                    -- the event's `from`: the node's source tag, on node_start only
);

CREATE INDEX IF NOT EXISTS events_by_hour ON events (received_hour, event);
CREATE INDEX IF NOT EXISTS events_by_install ON events (install_id, received_hour);
-- A store made before from_tag gets it from src/sql.js's `migrate` (CREATE TABLE IF NOT EXISTS leaves a table as it is).

-- Our own installs, kept out of every count but `gate` and `ours` (UNB-303). An entry is an install id, or a version
-- that was never offered to anyone (a device test build): every install that sent it is ours. Added and removed by an
-- admin at /v1/ours.
CREATE TABLE IF NOT EXISTS ours_list (
  kind TEXT NOT NULL CHECK (kind IN ('install', 'version')),
  value TEXT NOT NULL,
  why TEXT NOT NULL,
  added_hour INTEGER NOT NULL,
  PRIMARY KEY (kind, value)
);

-- Every install that is ours, with the reason that makes it so: the release train's gate, an install on the list, one
-- that sent a version on the list, a source build (0.x: no release carries it), or a node started with an internal
-- source tag. Made again on every start, so a change here reaches a store that already has the view.
DROP VIEW IF EXISTS ours;
CREATE VIEW ours AS
  SELECT 'ffffffffffffffffffffffffffffffff' AS install_id, 'gate' AS why
  UNION SELECT value, 'listed' FROM ours_list WHERE kind = 'install'
  UNION SELECT DISTINCT e.install_id, 'listed version' FROM events e JOIN ours_list l ON l.kind = 'version' AND l.value = e.version
  UNION SELECT DISTINCT install_id, 'source build' FROM events WHERE version LIKE '0.%'
  UNION SELECT DISTINCT install_id, 'internal tag' FROM events WHERE from_tag IN ('internal', 'dev', 'ci', 'test');

-- Bug reports (POST /v1/reports). A report's text is never kept here: it goes into the public GitHub issue. What is
-- kept is which issue each problem (fingerprint) has and how often it was reported, and today's count of reports per
-- install, under a hash of the install id and the day, so a count can't be followed from one day to the next.

CREATE TABLE IF NOT EXISTS report_issues (
  fingerprint TEXT PRIMARY KEY,      -- 16 hex: kind, tool, route shape and error, hashed
  kind TEXT NOT NULL,
  issue_number INTEGER NOT NULL,     -- 0 while the issue is being opened, or when its number was lost
  issue_url TEXT NOT NULL,
  reports INTEGER NOT NULL,
  first_day INTEGER NOT NULL,        -- days since the epoch, UTC
  last_day INTEGER NOT NULL,
  last_comment_day INTEGER NOT NULL  -- the last day the issue got a "seen again" comment
);

CREATE TABLE IF NOT EXISTS report_limits (
  key TEXT PRIMARY KEY,              -- sha256(install_id:day), or issues:<day> / comments:<day> for the relay's own
  day INTEGER NOT NULL,
  count INTEGER NOT NULL
);

-- Each report deletes the days before today's: by this index, not by reading the table.
CREATE INDEX IF NOT EXISTS report_limits_by_day ON report_limits (day);
