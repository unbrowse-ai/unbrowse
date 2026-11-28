-- Aggregate questions the events answer. Each `-- name:` line names one; the worker answers only these, at
--   GET https://telemetry.unbrowse.ai/v1/stats/<name>   with   Authorization: Bearer <ADMIN_TOKEN>
-- (`node stats.mjs <name>` in this folder does that). GET /v1/stats/ lists the names.
-- Every question reads the view `labelled` in schema.sql, which says of each event whether it is a person's ('real') or
-- ours, per event: all of an install that is ours (the release train's gate, the admin's install list at /v1/ours, an
-- internal source tag), and otherwise the events whose own version is ours (the admin's version list, source builds,
-- prerelease builds the site never offered; UNB-303, UNB-315). Every question from `installs` to `arms` counts only
-- real events, `ours` counts the rest, and from `days` to `period` every row says `who`: real or ours. An install's
-- firsts (first seen, first call, first good call) are taken among its real events or among its own ones.
-- A window over buckets (days, weeks) starts at the start of a whole bucket, the same start for every count in the
-- question, so the oldest bucket's calls, new installs and first good calls are all of that bucket's.
--
-- Every question starts `WITH clock`: src/sql.js (`namedQueries`) writes the helper below out in its place. The worker
-- binds the Unix second it is asked at as the question's first value (`clocked`), so every question answers by the
-- worker's clock, never SQLite's own, and a test can pin it. Every window's start is a column of `clock`, so questions
-- over one span (the funnel and its source split; the weekly questions) start at the same hour and can't disagree on
-- how many weeks there are, and every question reads `seen`, the events before the clock, so it counts nothing after
-- it: each window is `>= start` and `< now`.

-- helper: clock
--   hour_1      the last hour (gate)                                     days_7, days_30   the last 7 or 30 days
--   day_30      30 whole days, today the last (installs, calls)          day_189           190 whole days (days,
--               releases, release_errors)
--   week_12     12 whole weeks, this one the last (funnel, funnel_by_from)
--   week_27     28 whole weeks, this one the last (weeks, cohorts, tool_weeks, error_weeks, arm_weeks)
--   settled_by  an install first seen at or before it has had its whole 7 days of follow-up: the 7 days, and the
--               hour bucket the last qualifying call is kept in (arms, arm_weeks)
clock AS (
  SELECT now,
         now - 3600 AS hour_1,
         now - 7 * 86400 AS days_7,
         now - 30 * 86400 AS days_30,
         now / 86400 * 86400 - 29 * 86400 AS day_30,
         now / 86400 * 86400 - 189 * 86400 AS day_189,
         (now / 86400 - (now / 86400 + 3) % 7) * 86400 - 11 * 604800 AS week_12,
         (now / 86400 - (now / 86400 + 3) % 7) * 86400 - 27 * 604800 AS week_27,
         now - 7 * 86400 - 3600 AS settled_by
  FROM (SELECT CAST(? AS INTEGER) AS now)
),
seen AS (SELECT * FROM labelled WHERE received_hour < (SELECT now FROM clock));

-- name: installs
-- Active installs a day, for the last 30 days (an install is active on a day it started or called a tool).
WITH clock
SELECT date(received_hour, 'unixepoch') AS day, COUNT(DISTINCT install_id) AS installs
FROM seen WHERE who = 'real' AND received_hour >= (SELECT day_30 FROM clock)
GROUP BY day ORDER BY day DESC;

-- name: calls
-- Tool calls a day, by tool and outcome, for the last 30 days.
WITH clock
SELECT date(received_hour, 'unixepoch') AS day, tool, outcome, COUNT(*) AS calls
FROM seen
WHERE event = 'tool_call' AND who = 'real'
  AND received_hour >= (SELECT day_30 FROM clock)
GROUP BY day, tool, outcome ORDER BY day DESC, calls DESC;

-- name: breaks
-- What breaks: failed and refused calls in the last week, by tool and class.
WITH clock
SELECT tool, outcome, error_class, COUNT(*) AS calls
FROM seen
WHERE event = 'tool_call' AND outcome != 'ok' AND who = 'real'
  AND received_hour >= (SELECT days_7 FROM clock)
GROUP BY tool, outcome, error_class ORDER BY calls DESC;

-- name: times
-- Typical and slow call times, by tool, in the last week (the median and the 95th percentile by rank).
WITH clock,
c AS (
  SELECT tool, duration_ms,
         ROW_NUMBER() OVER (PARTITION BY tool ORDER BY duration_ms) AS n,
         COUNT(*) OVER (PARTITION BY tool) AS total
  FROM seen
  WHERE event = 'tool_call' AND duration_ms IS NOT NULL AND who = 'real'
    AND received_hour >= (SELECT days_7 FROM clock)
)
SELECT tool, total,
       MIN(CASE WHEN n >= total * 0.5 THEN duration_ms END) AS p50_ms,
       MIN(CASE WHEN n >= total * 0.95 THEN duration_ms END) AS p95_ms
FROM c GROUP BY tool, total ORDER BY total DESC;

-- name: versions
-- Versions and systems in use in the last week, by install.
WITH clock
SELECT version, os, COUNT(DISTINCT install_id) AS installs
FROM seen WHERE received_hour >= (SELECT days_7 FROM clock) AND who = 'real'
GROUP BY version, os ORDER BY installs DESC;

-- name: gate
-- The release train's own events this hour: how a gate sees that what it sent was kept.
WITH clock
SELECT COUNT(*) AS events FROM seen
WHERE install_id = 'ffffffffffffffffffffffffffffffff' AND received_hour >= (SELECT hour_1 FROM clock);

-- name: funnel
-- The node's half of the funnel, by the week an install was first seen (weeks start Monday, UTC): how many installs
-- started, how many had an agent call a tool, how many got a first good call (an unbrowse_do or route call that
-- answered ok), how many got it within 7 days, and how many came back 7 days or more after they were first seen.
-- "First seen" is the worker's: installs from before the worker was deployed count as new in its first week. The last
-- 12 weeks, this one the last (`week_12`, as funnel_by_from).
WITH clock,
firsts AS (
  SELECT install_id,
         MIN(received_hour) AS first_hour,
         MIN(CASE WHEN event = 'tool_call' THEN received_hour END) AS called_hour,
         MIN(CASE WHEN event = 'tool_call' AND outcome = 'ok'
                   AND tool IN ('unbrowse_do', 'unbrowse_call', '/v1/do', '/v1/routes/{id}/call', '/v1/remote/call/{id}')
                  THEN received_hour END) AS good_hour,
         MAX(received_hour) AS last_hour
  FROM seen WHERE who = 'real'
  GROUP BY install_id
)
SELECT date(first_hour - ((first_hour / 86400 + 3) % 7) * 86400, 'unixepoch') AS week,
       COUNT(*) AS installs,
       SUM(called_hour IS NOT NULL) AS called,
       SUM(good_hour IS NOT NULL) AS good_call,
       SUM(good_hour IS NOT NULL AND good_hour - first_hour <= 7 * 86400) AS good_call_7d,
       SUM(last_hour - first_hour >= 7 * 86400) AS back_after_7d
FROM firsts WHERE first_hour >= (SELECT week_12 FROM clock)
GROUP BY week ORDER BY week DESC;

-- name: funnel_by_from
-- The funnel question, split by where each install came from: its source tag (`from`, sent on node_start), or
-- 'direct' for an install that never sent one. An install's tag is the first one it sent (a node keeps one tag). The
-- funnel's 12 weeks (`week_12`).
WITH clock,
firsts AS (
  SELECT install_id,
         MIN(received_hour) AS first_hour,
         MIN(CASE WHEN event = 'tool_call' THEN received_hour END) AS called_hour,
         MIN(CASE WHEN event = 'tool_call' AND outcome = 'ok'
                   AND tool IN ('unbrowse_do', 'unbrowse_call', '/v1/do', '/v1/routes/{id}/call', '/v1/remote/call/{id}')
                  THEN received_hour END) AS good_hour,
         MAX(received_hour) AS last_hour,
         MIN(install_from) AS tag
  FROM seen WHERE who = 'real'
  GROUP BY install_id
)
SELECT date(first_hour - ((first_hour / 86400 + 3) % 7) * 86400, 'unixepoch') AS week,
       COALESCE(tag, 'direct') AS from_tag,
       COUNT(*) AS installs,
       SUM(called_hour IS NOT NULL) AS called,
       SUM(good_hour IS NOT NULL) AS good_call,
       SUM(good_hour IS NOT NULL AND good_hour - first_hour <= 7 * 86400) AS good_call_7d,
       SUM(last_hour - first_hour >= 7 * 86400) AS back_after_7d
FROM firsts
WHERE first_hour >= (SELECT week_12 FROM clock)
GROUP BY week, COALESCE(tag, 'direct') ORDER BY week DESC, installs DESC;

-- name: arms
-- The hero test judged on the first good call: for each arm, the installs whose source tag ends in -<arm> (one
-- letter, as the site's arms are: `hn-e` is source hn, arm e), and how many got a first good call within 7 days of
-- being first seen. `settled` counts only installs whose 7 days of follow-up are over by the clock (`settled_by`: the 7
-- days and the hour bucket the last qualifying call is kept in): judge on those.
WITH clock,
firsts AS (
  SELECT install_id,
         MIN(received_hour) AS first_hour,
         MIN(CASE WHEN event = 'tool_call' AND outcome = 'ok'
                   AND tool IN ('unbrowse_do', 'unbrowse_call', '/v1/do', '/v1/routes/{id}/call', '/v1/remote/call/{id}')
                  THEN received_hour END) AS good_hour,
         MIN(install_arm) AS arm
  FROM seen WHERE who = 'real'
  GROUP BY install_id
),
armed AS (
  SELECT arm, first_hour,
         good_hour IS NOT NULL AND good_hour - first_hour <= 7 * 86400 AS good_7d,
         first_hour <= (SELECT settled_by FROM clock) AS settled
  FROM firsts WHERE arm IS NOT NULL
)
SELECT arm,
       COUNT(*) AS installs,
       SUM(good_7d) AS good_call_7d,
       SUM(settled) AS settled,
       SUM(settled AND good_7d) AS settled_good_call_7d
FROM armed GROUP BY arm ORDER BY arm;

-- name: ours
-- What the other questions leave out, in the last 30 days: our own events, by the reason each is ours (src: the view
-- `labelled` in schema.sql), with the installs that sent them and their calls. Real or ours is per event, so an install
-- that ran a test build and a release is counted under the test build for those events only.
WITH clock
SELECT why, COUNT(DISTINCT install_id) AS installs, SUM(event = 'tool_call') AS calls
FROM seen
WHERE who = 'ours' AND received_hour >= (SELECT days_30 FROM clock)
GROUP BY why ORDER BY installs DESC, why;

-- The questions below label every row `who`: 'real' for a person's events, 'ours' for our own testing (the view
-- `labelled`), so the site's /admin can show people by default and our testing beside them (UNB-315). An install that
-- ran both is counted on each side for its own events. Weeks start Monday, UTC; each goes back to the start of the day
-- or the Monday on or before 189 days ago, enough for a 90-day range and the 90 days before it.

-- name: days
-- Each day, real and ours: installs active, installs first seen, installs that called a tool, installs whose first good
-- call was that day, tool calls, and the calls that answered ok.
WITH clock,
f AS (
  SELECT install_id, who, MIN(received_hour) AS first_hour,
         MIN(CASE WHEN event = 'tool_call' AND outcome = 'ok' AND tool IN ('unbrowse_do', 'unbrowse_call', '/v1/do', '/v1/routes/{id}/call', '/v1/remote/call/{id}') THEN received_hour END) AS good_hour
  FROM seen GROUP BY install_id, who
),
e AS (
  SELECT install_id, event, outcome, received_hour / 86400 * 86400 AS d, who
  FROM seen WHERE received_hour >= (SELECT day_189 FROM clock)
)
SELECT date(e.d, 'unixepoch') AS day, e.who,
       COUNT(DISTINCT e.install_id) AS active,
       COUNT(DISTINCT CASE WHEN f.first_hour >= e.d AND f.first_hour < e.d + 86400 THEN e.install_id END) AS new_installs,
       COUNT(DISTINCT CASE WHEN e.event = 'tool_call' THEN e.install_id END) AS calling,
       COUNT(DISTINCT CASE WHEN f.good_hour >= e.d AND f.good_hour < e.d + 86400 THEN e.install_id END) AS first_good,
       SUM(e.event = 'tool_call') AS calls,
       SUM(e.event = 'tool_call' AND e.outcome = 'ok') AS ok_calls
FROM e JOIN f ON f.install_id = e.install_id AND f.who = e.who
GROUP BY e.d, e.who ORDER BY e.d DESC, e.who;

-- name: weeks
-- The same by week: an install active on three days of a week is one active install that week.
WITH clock,
f AS (
  SELECT install_id, who, MIN(received_hour) AS first_hour,
         MIN(CASE WHEN event = 'tool_call' AND outcome = 'ok' AND tool IN ('unbrowse_do', 'unbrowse_call', '/v1/do', '/v1/routes/{id}/call', '/v1/remote/call/{id}') THEN received_hour END) AS good_hour
  FROM seen GROUP BY install_id, who
),
e AS (
  SELECT install_id, event, outcome, (received_hour / 86400 - (received_hour / 86400 + 3) % 7) * 86400 AS w, who
  FROM seen WHERE received_hour >= (SELECT week_27 FROM clock)
)
SELECT date(e.w, 'unixepoch') AS week, e.who,
       COUNT(DISTINCT e.install_id) AS active,
       COUNT(DISTINCT CASE WHEN f.first_hour >= e.w AND f.first_hour < e.w + 604800 THEN e.install_id END) AS new_installs,
       COUNT(DISTINCT CASE WHEN e.event = 'tool_call' THEN e.install_id END) AS calling,
       COUNT(DISTINCT CASE WHEN f.good_hour >= e.w AND f.good_hour < e.w + 604800 THEN e.install_id END) AS first_good,
       SUM(e.event = 'tool_call') AS calls,
       SUM(e.event = 'tool_call' AND e.outcome = 'ok') AS ok_calls
FROM e JOIN f ON f.install_id = e.install_id AND f.who = e.who
GROUP BY e.w, e.who ORDER BY e.w DESC, e.who;

-- name: cohorts
-- Coming back: installs by the week they were first seen, how many called a tool, got a first good call within 7 days,
-- and called a tool again in the 1st, 2nd and 4th week after that week: again means a call in that week by an install
-- that had called one before it, so a first call ever is never a return. `weeks_old` is how many whole weeks have
-- passed since the cohort's week began: week N after it is over once weeks_old is N + 1 or more.
WITH clock,
f AS (
  SELECT install_id, who, MIN(received_hour) AS first_hour,
         MIN(CASE WHEN event = 'tool_call' THEN received_hour END) AS call_hour,
         MIN(CASE WHEN event = 'tool_call' AND outcome = 'ok' AND tool IN ('unbrowse_do', 'unbrowse_call', '/v1/do', '/v1/routes/{id}/call', '/v1/remote/call/{id}') THEN received_hour END) AS good_hour
  FROM seen GROUP BY install_id, who
),
c AS (
  SELECT install_id, first_hour, call_hour, good_hour, (first_hour / 86400 - (first_hour / 86400 + 3) % 7) * 86400 AS w, who
  FROM f
),
b AS (
  SELECT c.install_id, c.w, c.who, c.first_hour, c.good_hour,
         MAX(e.event = 'tool_call') AS called,
         MAX(e.event = 'tool_call' AND e.received_hour >= c.w + 1 * 604800 AND e.received_hour < c.w + 2 * 604800 AND c.call_hour < c.w + 1 * 604800) AS w1,
         MAX(e.event = 'tool_call' AND e.received_hour >= c.w + 2 * 604800 AND e.received_hour < c.w + 3 * 604800 AND c.call_hour < c.w + 2 * 604800) AS w2,
         MAX(e.event = 'tool_call' AND e.received_hour >= c.w + 4 * 604800 AND e.received_hour < c.w + 5 * 604800 AND c.call_hour < c.w + 4 * 604800) AS w4
  FROM c JOIN seen e ON e.install_id = c.install_id AND e.who = c.who
  WHERE c.w >= (SELECT week_27 FROM clock)
  GROUP BY c.install_id, c.who
)
SELECT date(w, 'unixepoch') AS week, who, COUNT(*) AS installs, SUM(called) AS called,
       SUM(good_hour IS NOT NULL AND good_hour - first_hour <= 7 * 86400) AS good_call_7d,
       SUM(w1) AS week_1, SUM(w2) AS week_2, SUM(w4) AS week_4,
       ((SELECT now FROM clock) - w) / 604800 AS weeks_old
FROM b GROUP BY w, who ORDER BY w DESC, who;

-- name: releases
-- Release against release, over the last 189 days: per version, real and ours, the hour it was first seen, installs
-- that ran it, tool calls, the ones that answered ok, and the median and 95th percentile call time (by rank).
WITH clock,
e AS (
  SELECT version, install_id, event, outcome, duration_ms, received_hour, who
  FROM seen WHERE received_hour >= (SELECT day_189 FROM clock)
),
t AS (
  SELECT version, who, duration_ms,
         ROW_NUMBER() OVER (PARTITION BY version, who ORDER BY duration_ms) AS n,
         COUNT(*) OVER (PARTITION BY version, who) AS total
  FROM e WHERE event = 'tool_call' AND duration_ms IS NOT NULL
),
p AS (
  SELECT version, who,
         MIN(CASE WHEN n >= total * 0.5 THEN duration_ms END) AS p50_ms,
         MIN(CASE WHEN n >= total * 0.95 THEN duration_ms END) AS p95_ms
  FROM t GROUP BY version, who
)
SELECT e.version, e.who, MIN(e.received_hour) AS first_hour, COUNT(DISTINCT e.install_id) AS installs,
       SUM(e.event = 'tool_call') AS calls, SUM(e.event = 'tool_call' AND e.outcome = 'ok') AS ok_calls,
       p.p50_ms, p.p95_ms
FROM e LEFT JOIN p ON p.version = e.version AND p.who = e.who
GROUP BY e.version, e.who ORDER BY first_hour DESC, e.who;

-- name: release_errors
-- What broke in each version over the last 189 days: calls that did not answer ok, by class (the outcome when a call
-- carried no class), real and ours. Grouped by the expression itself: `GROUP BY error_class` would name the column,
-- and every call with no class would share one row whatever its outcome.
WITH clock
SELECT version, who, COALESCE(error_class, outcome) AS error_class, COUNT(*) AS calls
FROM seen
WHERE event = 'tool_call' AND outcome != 'ok' AND received_hour >= (SELECT day_189 FROM clock)
GROUP BY version, who, COALESCE(error_class, outcome) ORDER BY version, who, calls DESC;

-- name: tool_weeks
-- Each tool by week: its calls and the ones that answered ok, real and ours.
WITH clock
SELECT date((received_hour / 86400 - (received_hour / 86400 + 3) % 7) * 86400, 'unixepoch') AS week, who, tool, COUNT(*) AS calls, SUM(outcome = 'ok') AS ok_calls
FROM seen
WHERE event = 'tool_call' AND received_hour >= (SELECT week_27 FROM clock)
GROUP BY week, who, tool ORDER BY week DESC, who, calls DESC;

-- name: error_weeks
-- Error classes by week: calls that did not answer ok, by class (the outcome when a call carried none), real and ours.
WITH clock
SELECT date((received_hour / 86400 - (received_hour / 86400 + 3) % 7) * 86400, 'unixepoch') AS week, who, COALESCE(error_class, outcome) AS error_class, COUNT(*) AS calls
FROM seen
WHERE event = 'tool_call' AND outcome != 'ok' AND received_hour >= (SELECT week_27 FROM clock)
GROUP BY week, who, COALESCE(error_class, outcome) ORDER BY week DESC, who, calls DESC;

-- name: arm_weeks
-- The hero test by week: per arm (as `arms`), installs by the week they were first seen, real and ours, how many got a
-- first good call within 7 days, and how many are settled (as `arms`: their 7 days of follow-up are over, `settled_by`).
WITH clock,
firsts AS (
  SELECT install_id, who, MIN(received_hour) AS first_hour,
         MIN(CASE WHEN event = 'tool_call' AND outcome = 'ok' AND tool IN ('unbrowse_do', 'unbrowse_call', '/v1/do', '/v1/routes/{id}/call', '/v1/remote/call/{id}') THEN received_hour END) AS good_hour,
         MIN(install_arm) AS arm
  FROM seen GROUP BY install_id, who
),
armed AS (
  SELECT install_id, who, arm, first_hour,
         good_hour IS NOT NULL AND good_hour - first_hour <= 7 * 86400 AS good_7d,
         first_hour <= (SELECT settled_by FROM clock) AS settled
  FROM firsts
  WHERE arm IS NOT NULL AND first_hour >= (SELECT week_27 FROM clock)
)
SELECT date((first_hour / 86400 - (first_hour / 86400 + 3) % 7) * 86400, 'unixepoch') AS week, who, arm,
       COUNT(*) AS installs, SUM(good_7d) AS good_call_7d, SUM(settled) AS settled, SUM(settled AND good_7d) AS settled_good_call_7d
FROM armed GROUP BY week, who, arm ORDER BY week DESC, who, arm;

-- name: period
-- The last ?days= days (7, 30 or 90) against the same number of days before them, real and ours: installs active,
-- first seen, that called a tool, whose first good call fell in the period, tool calls and ok calls. A distinct count
-- over a period can't be added up from days, so the site's /admin asks this for its range. An install's first hour and
-- first good call are placed in a period by the same rule that places its events (`since`), so one in the hour `now`
-- falls on is new in the current period, not left between the two. It reads `seen`, so the current period ends at the
-- clock: an event in a later hour is in neither.
WITH clock,
p AS (SELECT CAST(? AS INTEGER) * 86400 AS span, (SELECT now FROM clock) AS now),
f AS (
  SELECT install_id, who, MIN(received_hour) AS first_hour,
         MIN(CASE WHEN event = 'tool_call' AND outcome = 'ok' AND tool IN ('unbrowse_do', 'unbrowse_call', '/v1/do', '/v1/routes/{id}/call', '/v1/remote/call/{id}') THEN received_hour END) AS good_hour
  FROM seen GROUP BY install_id, who
),
e AS (
  SELECT install_id, event, outcome, who,
         CASE WHEN received_hour >= p.now - p.span THEN p.now - p.span ELSE p.now - 2 * p.span END AS since
  FROM seen, p WHERE received_hour >= p.now - 2 * p.span
)
SELECT CASE WHEN e.since = (SELECT now - span FROM p) THEN 'current' ELSE 'previous' END AS period, e.who,
       COUNT(DISTINCT e.install_id) AS active,
       COUNT(DISTINCT CASE WHEN f.first_hour >= p.now - 2 * p.span AND CASE WHEN f.first_hour >= p.now - p.span THEN p.now - p.span ELSE p.now - 2 * p.span END = e.since THEN e.install_id END) AS new_installs,
       COUNT(DISTINCT CASE WHEN e.event = 'tool_call' THEN e.install_id END) AS calling,
       COUNT(DISTINCT CASE WHEN f.good_hour >= p.now - 2 * p.span AND CASE WHEN f.good_hour >= p.now - p.span THEN p.now - p.span ELSE p.now - 2 * p.span END = e.since THEN e.install_id END) AS first_good,
       SUM(e.event = 'tool_call') AS calls,
       SUM(e.event = 'tool_call' AND e.outcome = 'ok') AS ok_calls
FROM e JOIN f ON f.install_id = e.install_id AND f.who = e.who, p
GROUP BY e.since, e.who ORDER BY period, e.who;

-- name: install
-- One install, by its install id: GET /v1/stats/install?id=<32 hex>. The id is checked against its shape and bound as
-- a value (src/sql.js PARAMS), never written into the SQL. When it was first and last seen, its first source tag, its
-- first tool call and its first good call (Unix seconds, the hour each arrived), and how many calls and good calls it
-- made, up to the clock. No row for an install with no events. The site's /admin Journey reads it for a signed-in
-- node (UNB-179).
WITH clock
SELECT install_id,
       MIN(received_hour) AS first_seen,
       MIN(install_from) AS from_tag,
       MIN(CASE WHEN event = 'tool_call' THEN received_hour END) AS first_call,
       MIN(CASE WHEN event = 'tool_call' AND outcome = 'ok'
                 AND tool IN ('unbrowse_do', 'unbrowse_call', '/v1/do', '/v1/routes/{id}/call', '/v1/remote/call/{id}')
                THEN received_hour END) AS first_good_call,
       MAX(received_hour) AS last_seen,
       SUM(event = 'tool_call') AS calls,
       SUM(event = 'tool_call' AND outcome = 'ok'
           AND tool IN ('unbrowse_do', 'unbrowse_call', '/v1/do', '/v1/routes/{id}/call', '/v1/remote/call/{id}')) AS good_calls
FROM seen WHERE install_id = ?
GROUP BY install_id;
