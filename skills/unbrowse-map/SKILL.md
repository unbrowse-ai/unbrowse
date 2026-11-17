---
name: unbrowse-map
description: Learn a website's API route by browsing it, then replay it browserless. Use when the user asks to "learn this site", "find the API behind this page", "turn this flow into an API call", "map while browsing", or to test whether a site's flow can run without a browser. Works on anti-bot-protected sites by seeding the session from the node's own browsing.
---

# unbrowse-map

Browse a site twice while the Unbrowse browser sidecar passively captures every
request and typed value; the learner then builds the dependency graph of the flow
and replays the route over plain HTTP. No recording commands, no HAR exports —
the capture log appears as a side effect of browsing.

The client meets a site's defences head-on, and Unbrowse is open about that:
the session comes from the node's own browsing, calls carry the browser's own
shape, and a challenge is a problem to solve. Routes replay browserless once
the front door is behind them, and the browser only re-runs a step when the
site's front door demands it.

## Setup

- Browser sidecar (the fork): `~/unbrowse/unbrowse-browser/cli/target/debug/agent-browser`
- Probe: `cd ~/unbrowse/unbrowse-node && cargo run -q -p unbrowse-learn --bin route_probe`

## Workflow

1. **Capture two sightings.** The daemon reads `UNBROWSE_CAPTURE_DIR` at
   start-up, so recycle it first:

   ```sh
   agent-browser close --all
   export UNBROWSE_CAPTURE_DIR=/tmp/<name>-capture && mkdir -p $UNBROWSE_CAPTURE_DIR
   agent-browser --session s1 open <start-url> --headed
   ```

   Do the flow once by hand (navigate, fill, click). Nothing else is needed:
   every finished request — headers, cookies, bodies — and every typed value
   is logged as it happens. Close with `agent-browser --session s1 close`.
   Then repeat as `--session s2` with **different inputs** (a different search
   query, city, or item): the second sighting is what tells constants apart
   from values the page computes.

2. **Learn and test the route:**

   ```sh
   route_probe /tmp/<name>-capture/s1.jsonl /tmp/<name>-capture/s2.jsonl --target <url-substring>
   ```

   `--target` picks the last captured API call (Fetch/XHR) whose URL contains
   the substring. Inputs default to the values typed while browsing; override
   with `--input name=value` (positional names like `path[2]`, or the field's
   selector for typed inputs).

3. **Read the verdict:**
   - `direct call works` — the route replayed browserless; inputs changed, all
     derived values re-fetched from fresh responses.
   - `needs a browser for <value>` — the page computes it; another sighting may
     settle it, or the step must run in a browser (`--browser-step N --browser
     <agent-browser-path>`).
   - `browser-minted <cookie>` — a session value the node's own browsing
     created; plain HTTP reuses it, and a stale front door is re-run in the
     browser automatically (`replay_reseeded`).

## Notes

- Sessions, cookies and captures never leave the machine.
- Values typed into password, one-time-code and card fields are marked secret
  in the log and stay out of published graphs.
- Watch the printed dependency graph: `from step N (…)` lines show where each
  value comes from; anything `computed by the page` is the honest limit of a
  browserless replay.
