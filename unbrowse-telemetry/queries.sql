-- Aggregate questions the events answer. Each `-- name:` line names one; the worker answers only these, at
--   GET https://telemetry.unbrowse.ai/v1/stats/<name>   with   Authorization: Bearer <ADMIN_TOKEN>
-- (`node stats.mjs <name>` in this folder does that). GET /v1/stats/ lists the names.
-- The install id of 32 f's is the release train's gate (.deploy/manifest.json), so every question leaves it out.

-- name: installs
-- Active installs a day (an install is active on a day it started or called a tool).
SELECT date(received_hour, 'unixepoch') AS day, COUNT(DISTINCT install_id) AS installs
FROM events WHERE install_id != 'ffffffffffffffffffffffffffffffff'
GROUP BY day ORDER BY day DESC LIMIT 30;

-- name: calls
-- Tool calls a day, by tool and outcome, for the last 30 days.
SELECT date(received_hour, 'unixepoch') AS day, tool, outcome, COUNT(*) AS calls
FROM events
WHERE event = 'tool_call' AND install_id != 'ffffffffffffffffffffffffffffffff'
  AND received_hour >= strftime('%s', 'now', '-30 days')
GROUP BY day, tool, outcome ORDER BY day DESC, calls DESC;

-- name: breaks
-- What breaks: failed and refused calls in the last week, by tool and class.
SELECT tool, outcome, error_class, COUNT(*) AS calls
FROM events
WHERE event = 'tool_call' AND outcome != 'ok' AND install_id != 'ffffffffffffffffffffffffffffffff'
  AND received_hour >= strftime('%s', 'now', '-7 days')
GROUP BY tool, outcome, error_class ORDER BY calls DESC;

-- name: times
-- Typical and slow call times, by tool, in the last week (the median and the 95th percentile by rank).
WITH c AS (
  SELECT tool, duration_ms,
         ROW_NUMBER() OVER (PARTITION BY tool ORDER BY duration_ms) AS n,
         COUNT(*) OVER (PARTITION BY tool) AS total
  FROM events
  WHERE event = 'tool_call' AND duration_ms IS NOT NULL AND install_id != 'ffffffffffffffffffffffffffffffff'
    AND received_hour >= strftime('%s', 'now', '-7 days')
)
SELECT tool, total,
       MIN(CASE WHEN n >= total * 0.5 THEN duration_ms END) AS p50_ms,
       MIN(CASE WHEN n >= total * 0.95 THEN duration_ms END) AS p95_ms
FROM c GROUP BY tool, total ORDER BY total DESC;

-- name: versions
-- Versions and systems in use in the last week, by install.
SELECT version, os, COUNT(DISTINCT install_id) AS installs
FROM events WHERE received_hour >= strftime('%s', 'now', '-7 days') AND install_id != 'ffffffffffffffffffffffffffffffff'
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
  FROM events WHERE install_id != 'ffffffffffffffffffffffffffffffff'
  GROUP BY install_id
)
SELECT date(first_hour - ((first_hour / 86400 + 3) % 7) * 86400, 'unixepoch') AS week,
       COUNT(*) AS installs,
       SUM(called_hour IS NOT NULL) AS called,
       SUM(good_hour IS NOT NULL) AS good_call,
       SUM(good_hour IS NOT NULL AND good_hour - first_hour <= 7 * 86400) AS good_call_7d,
       SUM(last_hour - first_hour >= 7 * 86400) AS back_after_7d
FROM firsts GROUP BY week ORDER BY week DESC LIMIT 12;
