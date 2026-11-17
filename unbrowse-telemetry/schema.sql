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
  error_class TEXT
);

CREATE INDEX IF NOT EXISTS events_by_hour ON events (received_hour, event);
CREATE INDEX IF NOT EXISTS events_by_install ON events (install_id, received_hour);

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
