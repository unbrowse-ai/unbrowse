-- Aggregate questions the events answer. Each `-- name:` line names one; the worker answers only these, at
--   GET https://telemetry.unbrowse.ai/v1/stats/<name>   with   Authorization: Bearer <ADMIN_TOKEN>
-- (`node stats.mjs <name>` in this folder does that). GET /v1/stats/ lists the names.
-- Every question but `gate`, `ours` and `install` leaves our own installs out: the view `ours` in schema.sql (the
-- release train's gate, the admin's list at /v1/ours, source builds and internal source tags; UNB-303).

-- name: installs
-- Active installs a day (an install is active on a day it started or called a tool).
SELECT date(received_hour, 'unixepoch') AS day, COUNT(DISTINCT install_id) AS installs
FROM events WHERE install_id NOT IN (SELECT install_id FROM ours)
GROUP BY day ORDER BY day DESC LIMIT 30;

-- name: calls
-- Tool calls a day, by tool and outcome, for the last 30 days.
SELECT date(received_hour, 'unixepoch') AS day, tool, outcome, COUNT(*) AS calls
FROM events
WHERE event = 'tool_call' AND install_id NOT IN (SELECT install_id FROM ours)
  AND received_hour >= strftime('%s', 'now', '-30 days')
GROUP BY day, tool, outcome ORDER BY day DESC, calls DESC;

-- name: breaks
-- What breaks: failed and refused calls in the last week, by tool and class.
SELECT tool, outcome, error_class, COUNT(*) AS calls
FROM events
WHERE event = 'tool_call' AND outcome != 'ok' AND install_id NOT IN (SELECT install_id FROM ours)
  AND received_hour >= strftime('%s', 'now', '-7 days')
GROUP BY tool, outcome, error_class ORDER BY calls DESC;

-- name: times
-- Typical and slow call times, by tool, in the last week (the median and the 95th percentile by rank).
WITH c AS (
  SELECT tool, duration_ms,
         ROW_NUMBER() OVER (PARTITION BY tool ORDER BY duration_ms) AS n,
         COUNT(*) OVER (PARTITION BY tool) AS total
  FROM events
  WHERE event = 'tool_call' AND duration_ms IS NOT NULL AND install_id NOT IN (SELECT install_id FROM ours)
    AND received_hour >= strftime('%s', 'now', '-7 days')
)
SELECT tool, total,
       MIN(CASE WHEN n >= total * 0.5 THEN duration_ms END) AS p50_ms,
       MIN(CASE WHEN n >= total * 0.95 THEN duration_ms END) AS p95_ms
FROM c GROUP BY tool, total ORDER BY total DESC;

-- name: versions
-- Versions and systems in use in the last week, by install.
SELECT version, os, COUNT(DISTINCT install_id) AS installs
FROM events WHERE received_hour >= strftime('%s', 'now', '-7 days') AND install_id NOT IN (SELECT install_id FROM ours)
GROUP BY version, os ORDER BY installs DESC;

-- name: gate
-- The release train's own events this hour: how a gate sees that what it sent was kept.
SELECT COUNT(*) AS events FROM events
WHERE install_id = 'ffffffffffffffffffffffffffffffff' AND received_hour >= strftime('%s', 'now', '-1 hour');

-- name: funnel
-- The node's half of the funnel, by the week an install was first seen (weeks start Monday, UTC): how many installs
-- started, how many had an agent call a tool, how many got a first good call (an unbrowse_do or route call that
-- answered ok), how many got it within 7 days, and how many came back 7 days or more after they were first seen.
-- "First seen" is the worker's: installs from before the worker was deployed count as new in its first week.
WITH firsts AS (
  SELECT install_id,
         MIN(received_hour) AS first_hour,
         MIN(CASE WHEN event = 'tool_call' THEN received_hour END) AS called_hour,
         MIN(CASE WHEN event = 'tool_call' AND outcome = 'ok'
                   AND tool IN ('unbrowse_do', 'unbrowse_call', '/v1/do', '/v1/routes/{id}/call', '/v1/remote/call/{id}')
                  THEN received_hour END) AS good_hour,
         MAX(received_hour) AS last_hour
  FROM events WHERE install_id NOT IN (SELECT install_id FROM ours)
  GROUP BY install_id
)
SELECT date(first_hour - ((first_hour / 86400 + 3) % 7) * 86400, 'unixepoch') AS week,
       COUNT(*) AS installs,
       SUM(called_hour IS NOT NULL) AS called,
       SUM(good_hour IS NOT NULL) AS good_call,
       SUM(good_hour IS NOT NULL AND good_hour - first_hour <= 7 * 86400) AS good_call_7d,
       SUM(last_hour - first_hour >= 7 * 86400) AS back_after_7d
FROM firsts GROUP BY week ORDER BY week DESC LIMIT 12;

-- name: funnel_by_from
-- The funnel question, split by where each install came from: its source tag (`from`, sent on node_start), or
-- 'direct' for an install that never sent one. An install's tag is the first one it sent (a node keeps one tag).
WITH firsts AS (
  SELECT install_id,
         MIN(received_hour) AS first_hour,
         MIN(CASE WHEN event = 'tool_call' THEN received_hour END) AS called_hour,
         MIN(CASE WHEN event = 'tool_call' AND outcome = 'ok'
                   AND tool IN ('unbrowse_do', 'unbrowse_call', '/v1/do', '/v1/routes/{id}/call', '/v1/remote/call/{id}')
                  THEN received_hour END) AS good_hour,
         MAX(received_hour) AS last_hour,
         MIN(CASE WHEN from_tag IS NOT NULL THEN printf('%012d|%s', received_hour, from_tag) END) AS first_from
  FROM events WHERE install_id NOT IN (SELECT install_id FROM ours)
  GROUP BY install_id
)
SELECT date(first_hour - ((first_hour / 86400 + 3) % 7) * 86400, 'unixepoch') AS week,
       COALESCE(substr(first_from, 14), 'direct') AS from_tag,
       COUNT(*) AS installs,
       SUM(called_hour IS NOT NULL) AS called,
       SUM(good_hour IS NOT NULL) AS good_call,
       SUM(good_hour IS NOT NULL AND good_hour - first_hour <= 7 * 86400) AS good_call_7d,
       SUM(last_hour - first_hour >= 7 * 86400) AS back_after_7d
FROM firsts
WHERE first_hour >= CAST(strftime('%s', 'now', '-84 days') AS INTEGER)
GROUP BY week, from_tag ORDER BY week DESC, installs DESC;

-- name: arms
-- The hero test judged on the first good call: for each arm, the installs whose source tag ends in -<arm> (one
-- letter, as the site's arms are: `hn-e` is source hn, arm e), and how many got a first good call within 7 days of
-- being first seen. `settled` counts only installs first seen 7 days ago or more, whose 7 days are over: judge on those.
WITH firsts AS (
  SELECT install_id,
         MIN(received_hour) AS first_hour,
         MIN(CASE WHEN event = 'tool_call' AND outcome = 'ok'
                   AND tool IN ('unbrowse_do', 'unbrowse_call', '/v1/do', '/v1/routes/{id}/call', '/v1/remote/call/{id}')
                  THEN received_hour END) AS good_hour,
         MIN(CASE WHEN from_tag IS NOT NULL THEN printf('%012d|%s', received_hour, from_tag) END) AS first_from
  FROM events WHERE install_id NOT IN (SELECT install_id FROM ours)
  GROUP BY install_id
),
tagged AS (
  SELECT substr(first_from, 14) AS tag, first_hour, good_hour FROM firsts WHERE first_from IS NOT NULL
),
armed AS (
  SELECT substr(tag, -1) AS arm, first_hour,
         good_hour IS NOT NULL AND good_hour - first_hour <= 7 * 86400 AS good_7d,
         first_hour <= CAST(strftime('%s', 'now', '-7 days') AS INTEGER) AS settled
  FROM tagged
  WHERE length(tag) >= 3 AND substr(tag, -2, 1) = '-' AND substr(tag, -1) BETWEEN 'a' AND 'z'
)
SELECT arm,
       COUNT(*) AS installs,
       SUM(good_7d) AS good_call_7d,
       SUM(settled) AS settled,
       SUM(settled AND good_7d) AS settled_good_call_7d
FROM armed GROUP BY arm ORDER BY arm;

-- name: ours
-- What the other questions leave out, in the last 30 days: our own installs and their calls, by the first reason each
-- is ours (an install is counted once).
WITH why AS (SELECT install_id, MIN(why) AS why FROM ours GROUP BY install_id)
SELECT why.why, COUNT(DISTINCT e.install_id) AS installs, SUM(e.event = 'tool_call') AS calls
FROM events e JOIN why ON why.install_id = e.install_id
WHERE e.received_hour >= strftime('%s', 'now', '-30 days')
GROUP BY why.why ORDER BY installs DESC;

-- name: install
-- One install, by its install id: GET /v1/stats/install?id=<32 hex>. The id is checked against its shape and bound as
-- a value (src/sql.js PARAMS), never written into the SQL. When it was first and last seen, its first source tag, its
-- first tool call and its first good call (Unix seconds, the hour each arrived), and how many calls and good calls it
-- made. No row for an install with no events. The site's /admin Journey reads it for a signed-in node (UNB-179).
SELECT install_id,
       MIN(received_hour) AS first_seen,
       substr(MIN(CASE WHEN from_tag IS NOT NULL THEN printf('%012d|%s', received_hour, from_tag) END), 14) AS from_tag,
       MIN(CASE WHEN event = 'tool_call' THEN received_hour END) AS first_call,
       MIN(CASE WHEN event = 'tool_call' AND outcome = 'ok'
                 AND tool IN ('unbrowse_do', 'unbrowse_call', '/v1/do', '/v1/routes/{id}/call', '/v1/remote/call/{id}')
                THEN received_hour END) AS first_good_call,
       MAX(received_hour) AS last_seen,
       SUM(event = 'tool_call') AS calls,
       SUM(event = 'tool_call' AND outcome = 'ok'
           AND tool IN ('unbrowse_do', 'unbrowse_call', '/v1/do', '/v1/routes/{id}/call', '/v1/remote/call/{id}')) AS good_calls
FROM events WHERE install_id = ?
GROUP BY install_id;
