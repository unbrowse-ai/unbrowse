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

-- Our own installs and versions, kept out of every real count (UNB-303). An entry is an install id (every event of that
-- install is ours), or a version that was never offered to anyone (a device test build: every event that sent it is
-- ours, and the same install's other versions still count). Added and removed by an admin at /v1/ours.
CREATE TABLE IF NOT EXISTS ours_list (
  kind TEXT NOT NULL CHECK (kind IN ('install', 'version')),
  value TEXT NOT NULL,
  why TEXT NOT NULL,
  added_hour INTEGER NOT NULL,
  PRIMARY KEY (kind, value)
);

-- The prerelease builds the site's Download buttons offered to people (unbrowse-landing src/downloads.ts): every other
-- prerelease (13.21.0-installers.6, 13.21.0-staging.2) was only ever a device test or a staging build, so its installs
-- are ours. Added by an admin at /v1/ours with kind "offered" when the buttons move to a new prerelease (UNB-315).
-- A release candidate (X.Y.P-rc.N) needs no entry: the ours view below counts it as people's by its shape.
CREATE TABLE IF NOT EXISTS offered_list (
  version TEXT PRIMARY KEY,
  why TEXT NOT NULL,
  added_hour INTEGER NOT NULL
);
-- The seeds go in once per store, not on every start: this file runs each time the store starts, and an entry an admin
-- removed must stay removed. `seeded` names each seed that has gone in.
CREATE TABLE IF NOT EXISTS seeded (name TEXT PRIMARY KEY);
INSERT OR IGNORE INTO offered_list (version, why, added_hour)
  SELECT '13.21.0-installers.3', 'site Download buttons 21-22 Nov 2026', 1795219200 WHERE NOT EXISTS (SELECT 1 FROM seeded WHERE name = 'offered_list');
INSERT OR IGNORE INTO offered_list (version, why, added_hour)
  SELECT '13.21.0-installers.4', 'site Download buttons from 22 Nov 2026', 1795305600 WHERE NOT EXISTS (SELECT 1 FROM seeded WHERE name = 'offered_list');
INSERT OR IGNORE INTO seeded (name) VALUES ('offered_list');

-- Real or ours, and what an install is (UNB-303, UNB-315; PR #1002 review). Every question in queries.sql reads the
-- one view `labelled`: each event, with what its install is, read once over all of that install's events, and then
-- whether the event is a person's ('real') or ours.
--
-- What an install is, over all its events, before any event is split: its first source tag (`install_from`, as a
-- node sends `from` on a start only) and the hero test's arm that tag names (`install_arm`: a tag ending in "-" and
-- one letter, `hn-e` is arm e), and whether all of it is ours: the release train's gate, an install on the list, a
-- node ever started with an internal source tag, or one that ever ran a source build (0.x, which no release carries:
-- a node built from a checkout). Then, for an install that isn't, each event by its own version: a version on the
-- list, or a prerelease build the site never offered (a version with a "-", not on offered_list, and not a release
-- candidate, which a release branch publishes to npm's public `next` tag and to canary,
-- .github/scripts/release-version.sh). So a person who tried a staging build counts as a person on stable, and the
-- tag their staging start sent still attributes them. `why` is the reason an event is ours (NULL for a person's).
-- Made again on every start, so a change here reaches a store that already has the view. A question never reads the
-- events table itself, so none can split events before what their install is has been read.
DROP VIEW IF EXISTS ours;
DROP VIEW IF EXISTS ours_installs;
DROP VIEW IF EXISTS labelled;
CREATE VIEW labelled AS
  SELECT *, CASE WHEN why IS NULL THEN 'real' ELSE 'ours' END AS who FROM (
    SELECT e.*, i.install_from, i.install_arm, COALESCE(i.why, CASE
        WHEN e.version IN (SELECT value FROM ours_list WHERE kind = 'version') THEN 'listed version'
        WHEN instr(e.version, '-') > 0 AND e.version NOT IN (SELECT version FROM offered_list)
          AND NOT (substr(e.version, instr(e.version, '-') + 1) GLOB 'rc.[0-9]*' AND substr(e.version, instr(e.version, '-') + 4) NOT GLOB '*[^0-9]*')
          THEN 'test build' END) AS why
    FROM events e JOIN (
      SELECT install_id, install_from,
             CASE WHEN length(install_from) >= 3 AND substr(install_from, -2, 1) = '-' AND substr(install_from, -1) BETWEEN 'a' AND 'z'
               THEN substr(install_from, -1) END AS install_arm,
             CASE WHEN install_id = 'ffffffffffffffffffffffffffffffff' THEN 'gate'
               WHEN install_id IN (SELECT value FROM ours_list WHERE kind = 'install') THEN 'listed'
               WHEN internal_tag THEN 'internal tag'
               WHEN source_build THEN 'source build' END AS why
      FROM (
        SELECT install_id,
               substr(MIN(CASE WHEN from_tag IS NOT NULL THEN printf('%012d|%s', received_hour, from_tag) END), 14) AS install_from,
               MAX(from_tag IN ('internal', 'dev', 'ci', 'test')) AS internal_tag,
               MAX(version LIKE '0.%') AS source_build
        FROM events GROUP BY install_id
      )
    ) i ON i.install_id = e.install_id
  );

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
