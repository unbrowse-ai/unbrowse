# Unbrowse: April to May 2026

A month of shipped releases, one north star: the agent should never have to think about the browser. If you build or use AI agents that browse the web, this month Unbrowse got faster, quieter (no popup browser windows), and now lets you sign in once and optionally earn when others reuse the routes your agent discovered.

## TL;DR

- `unbrowse fetch <url>` is the single verb. Returns markdown by default, agents stop writing five-step scripts.
- **Autonomous discovery**: every browser session anywhere on your machine becomes a reusable skill. No `close`, no `sync`, no explicit publish.
- **Magic-link accounts**: `unbrowse account --register --email you@x.com` binds a key to a user, dashboard pairs to your CLI, anonymous keys keep working.
- **Probe-first execution**: every endpoint runs a probe ladder before falling back to capture.
- **Latency budget**: `--budget <ms>` races marketplace, cache, and capture in parallel. Repeat domain lookups within 5 minutes hit an in-process cache.
- **Privacy by default**: `unbrowse config set telemetry false` keeps fetches local. Emergency domain takedown for anyone who asks.

Upgrade: `npm i -g unbrowse@latest` (or `npx unbrowse setup`).

---

## For agents calling Unbrowse

### `unbrowse fetch <url>` is the verb you wanted

Resolve, execute, return. Markdown post-processing is on by default (pass `--raw` for the original body). GET endpoints auto-execute on resolve, so information-seeking flows return rows directly instead of a shortlist to pick from. Pass `--no-execute` for metadata only.

```bash
unbrowse fetch https://example.com/feed
```

### `decision_trace` is now a top-level field

Every `ExecutionResult` carries the full ladder as an array of step objects: `recipe_replay`, `probe`, `decision`, then one of `server_fetch`, `trigger_intercept`, `browser`, or `return_error`. Each step records `strategy` and a human-readable `reason`. The CLI prints it, the JSON envelope exposes it.

### Probe-first ladder + proven_recipe replay

Endpoints captured from real traffic now stamp a `proven_recipe`, the exact request shape that worked. On the next call, the executor replays the recipe before touching probe heuristics. Ladder order:

1. Recipe replay (if `proven_recipe` exists)
2. `probeUrl` + `decideFromProbe` (cheap HEAD/GET check)
3. Live capture

Subsequent calls to the same endpoint skip steps 2-3 as long as `proven_recipe` keeps returning 2xx.

### In-flight resolve + streaming publish

Resolve consults the in-flight session buffer before falling back to live capture. Routes captured in the last 10s appear in the next resolve without calling `close` or `sync`. A per-session watcher light-flushes the buffer every 10s and queues a marketplace publish when the endpoint count grows, so cross-agent reuse is available without waiting on session close.

Tunable via `UNBROWSE_STREAMING_INTERVAL_MS` and `UNBROWSE_STREAMING_PUBLISH=0`.

### CDP attach is now default

When Chrome is already running on a known debug port, Unbrowse attaches to it instead of launching a managed instance. Captures from chrome-devtools MCP, Playwright, or a developer's logged-in Chrome flow through the same pipeline. Unbrowse also advertises its own CDP port via `CHROME_DEBUG_URL`, `PUPPETEER_BROWSER_WS_ENDPOINT`, and `PLAYWRIGHT_CHROMIUM_REMOTE_DEBUGGING_URL`, so child agents attach upward instead of spawning their own browsers.

Opt-out: `KURI_DISABLE_CDP_ATTACH=1` or `UNBROWSE_LOCAL_ONLY=1`.

### Latency budget + race primitive

```bash
unbrowse resolve "search a forum for X" --budget 1500
```

Budget is in milliseconds. Budget races marketplace lookup, in-process cache, and live capture with per-racer abort. On timeout, partial results return with the budget step recorded in `decision_trace`. Repeat lookups against the same domain within 5 minutes are served from the in-process TTL cache.

### Browse-session UX cleanup

`unbrowse go <url>`, `unbrowse fill <ref> <value>`, `unbrowse inspect`. Verbs match the agent's mental model. `inspect` exposes live capture evidence, candidate endpoints, marketplace publish policy, and next actions. Eval JS quoting and log/JSON separation are tightened so harnesses parse stdout cleanly.

---

## For humans setting it up

### Magic-link accounts

```bash
unbrowse account --register --email you@example.com
```

Click the link, key is bound to a user. Anonymous keys keep working: bearer auth only resolves a `user_id` for account-bound keys, so existing flows are untouched. The web dashboard pairs to your local CLI through a short-lived localhost token, so signing in once links your installs. Sender is `auth@unbrowse.ai` (verified domain).

`unbrowse mode` and the new contribution prompt during `unbrowse setup` make the contribution choice (private / share / share + earn) a single-screen decision instead of a config-file hunt.

### Browser cookies are pulled into the sandbox

```bash
unbrowse fetch https://gated.example.com
```

Browser cookies are extracted by default. Pass `--no-browser-cookies` to opt out. When Chrome has no cookies for the domain, the auth resolver falls through to Dia, Arc, and Brave, ranked by recent-visit and bookmark counts so the actively-used profile is preferred.

### Privacy by default

- `unbrowse config set telemetry false` disables sharing and checkpoint auto-publish. `fetch` stays local unless you pass `--publish`.
- Contribution is **private by default**. The `unbrowse setup` prompt presents a numeric choice: `[1] Private (default)`, `[2] Share`, `[3] Share + earn`. Re-run the same prompt later with `unbrowse mode` (interactive, no subcommand args).
- Marketplace publish gates on explicit `share_pointers`.
- Admin domain removal plus runtime marketplace suppression for any domain owner who asks. Reach out at [unbrowse.ai/privacy](https://unbrowse.ai/privacy) or open an issue on the public repo.

## Reach: harder sites, fewer dead ends

- **Anti-bot auto-fallback**: when capture hits a Cloudflare, Datadome, or Fastly Bot Management wall, Unbrowse auto-falls back to a visible browser session and emits a `bundle_snapshot`. Detector now classifies Fastly Bot Management as `browser-block` instead of `fail`.
- **Doc-only hints**: when capture only yields HTML (lazy-loading SPA), the envelope tells the agent so it knows whether to drive or to scrape.
- **Sandbox replay merged into fetch**: `unbrowse fetch <url> --bundle-source <js|->` runs custom JS in the Kuri sandbox (inline or piped via stdin). The earlier `sandbox-replay` verb is now an alias of this form.
- **Extraction primitives**: a generic array-branch extractor with per-domain LLM notes (Slice 2). Picks story links over upvote and login links on aggregator-style cards. Admits parameterized nested-path SSR widget endpoints.

---

## Marketplace flywheel

- `unbrowse fetch` publishes observed routes on success when share-pointers is enabled (see Privacy section above). Private-mode users contribute nothing unless they pass `--publish` explicitly.
- `unbrowse capture --url <url> --intent "<intent>"` is a first-class verb backed by a `POST /v1/capture` route on the local Unbrowse server. Capture is an explicit publish action.
- Skills export to `SKILL.md` in [agentskills.io](https://agentskills.io) format.
- Per-domain `SKILL.md` is served as a public llms.txt-style export at `https://beta-api.unbrowse.ai/v1/skills/by-domain/<domain>/skill.md`. Agents discover Unbrowse skills the same way they discover any other site's agent guide.
- `routes_observed` is surfaced in `fetch` and bundle replay so you can see what each call contributed.
- New `/v1/stats/traction` endpoint exposes local key metrics for agent dashboards.

---

## Under the hood

- **Neon Postgres**: backend storage shifted to Neon via Drizzle. KV, graph edges, endpoint embeddings live in a real database. Companion change: client-side skill caches were removed, so the backend marketplace is the single source of truth.
- **Per-host registry deleted**: `deriveStructuredDataReplay` had 16 site-specific arms. Probe-first plus `proven_recipe` made it redundant, so we deleted it (Phase 8.3) along with `EndpointDescriptor.exec_strategy`. The runtime is now generic across every site we've tested. An audit grep stays in `CLAUDE.md` to prevent regressions.
- **Ranker hardening**: BM25 floor plus schema cross-check on parameter *name* not value. URL-encoded template slots, session-bound URLs, and whitepaper paths handled. Captured-page-artifact endpoints sink when a real API sibling exists.
- **Stale endpoint recovery**: marketplace retries refreshed credentials once and returns browser-fallback guidance instead of dropping the endpoint.
- **Local runtime restart**: stale local servers auto-restart when health version or hash drifts after an update.
- **Vault performance**: key and file reads cached, deterministic key derivation. Auth extraction emits traces.
- **Kuri vendor binaries**: Zig 0.16 port, macOS GH-hosted runner for darwin builds, linux-arm64 multiarch. Windows plan landed.

---

## Frontend

Landing, dashboard, miners, blog, and paper pages now share one design system. Hero shows an inline `decision_trace` terminal. Audience toggle (devs / everyone) with non-developer copy structured PEEL-style. The paper page is synced to arXiv:2604.00694 with the canonical flipped to `/internal-apis-are-all-you-need`.

---

## Upgrade

```bash
npm i -g unbrowse@latest
unbrowse setup
```

If you're on a stale install, `unbrowse setup` repairs the Codex update hook and re-pairs your dashboard.

## Links

- Paper: [arxiv.org/abs/2604.00694](https://arxiv.org/abs/2604.00694)
- Skill format: [agentskills.io](https://agentskills.io)
- Dashboard: [unbrowse.ai](https://unbrowse.ai)
- Source: [github.com/unbrowse-ai/unbrowse](https://github.com/unbrowse-ai/unbrowse)
