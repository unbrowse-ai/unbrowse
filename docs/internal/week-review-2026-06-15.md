# Week in review — unbrowse, w/o 2026-06-15

> For @CaydenChik and @goheesheng. ~260 commits landed this week (`v9.0.0` → `v9.3.6`).
> This doc is the map: the one idea that ties them together, then the clusters, then the
> two fresh-install fixes shipped today, then how to verify any of it yourself.

## The throughline (read this first)

The week was **not** seven separate projects. It was **one architectural move plus the
plumbing to make it usable**: collapse unbrowse into a single agent-native primitive — the
typed **hole** — and route every capability through that one narrow waist.

A "hole" is a typed slot in a contract: the agent states *what it wants* (an intent) and the
runtime fills the hole — choosing search, a cached route, a live capture, the browser, auth,
or a write — while keeping private route/credential details behind the typed boundary. This
is the **narrow-waist / uniform-interface** pattern (the IP hourglass; REST's uniform
interface): many capabilities, one contract they all pass through.

Once the hole is the universal surface, everything else this week is either **(a) widening
what can pass through it** — reads, writes, payments, identity — or **(b) making the waist
hold up under real users on real machines** — Windows, onboarding, and two bugs that broke
egress and dispatch for fresh installs.

So the review splits into a **spine** (the hole becomes the universal surface) and a
**supporting ring** (what the spine needs to be real).

---

## Spine — the hole becomes the universal surface

### 1. The CLI collapsed to one intent tool
`feat(cli): make bare unbrowse the primary hole command`, `add get as the read hole`,
`make fill the natural-language hole command`, `feat(sdk): make hole contract the primary
agent surface`.

The agent no longer has to pick among a dozen verbs. Bare `unbrowse "<task>"`, `get`, and
`fill` all route through one typed-hole path; the runtime decides search vs direct-fetch vs
route-graph vs browser-capture vs cookies/HAR vs indexing. The gap we closed was
**ergonomics, not capability** — the capability already existed; the agent shouldn't have to
think about which tool.

### 2. Runtime DAG-recompute — holes connect to each other
`feat(orchestrator): walk the prerequisite chain at execute time (DAG-recompute)`,
`persist + replay composite routes`, `composites travel on the skill manifest`,
`feat(runtime): session yield store — the pipe between holes`,
`global cross-skill producer index`.

A single hole is useful; **holes wired together** are the product. Execute now walks the
prerequisite chain (a route that needs an auth token first runs the route that *yields* one),
persists the walked chain as a first-class **composite** for always-on replay, and pipes a
write's *provides* into a downstream hole's *requires* via a session yield store. When a hole
can't be filled, the runtime now surfaces cross-skill producers that could fill it.

### 3. Writes pass through the same contract
`feat(execute): ad-hoc agent-driven writes (POST/PUT/PATCH/DELETE) + ZK input-censoring`,
`write receipts (requires/provides DAG edges)`, `agent-native method-free writes`,
`carry input sha256 commitments through the publish boundary`.

The hole used to be read-only. Now the same typed contract does writes — the agent describes
the write in natural language, no method-picking — with sensitive inputs censored at the
publish boundary (sha256 commitments cross, raw values don't) and each write emitting
requires/provides edges so it becomes a node in the same DAG as reads.

---

## Supporting ring — what the spine needs to be real

### 4. One identity behind every hole
`account: surface the self-custody identity wallet (zero-step onboarding)`,
`feat(values): unified OS-agnostic keychain secret store`,
`feat(onboarding): clean, friction-free first-run`.

To act through holes the body needs one identity. New users get a self-custody wallet with
zero steps; secrets live in one OS-agnostic keychain store; first-run has no friction (a
wallet is optional, sponsored usage covers you out of the box).

### 5. Payment is just another typed capability
`feat(backend): POST /v1/unlock — the x402 web-unblocker reseller route`,
`Worker-side Base x402 pay client`, `expose lifetime brokerage revenue`,
`surface brokered revenue on the ops dashboard`.

When a hole hits a paywall or a block, paying to unblock is routed like any other capability —
and that became a reseller/brokerage surface with honest revenue reporting on the dashboard.

### 6. The browser organ works on every OS
`fix(windows): stage Kuri broker in releases`, the winsock CDP port,
`fix(kuri): attach by default without keychain prompts`,
`fix(install): restore +x on vendored kuri/utls binaries (Linux EACCES crash)`.

The Kuri browser broker now ships in releases for Windows (winsock CDP transport, kuri.exe),
attaches to an existing Chrome by default without macOS keychain prompts, and no longer
crashes on Linux from a lost executable bit.

### 7. The two fresh-install fixes shipped today
These are the reliability tail — the waist was silently broken for brand-new installs.

- **`v9.3.5` — removed a baked default egress proxy + fixed command misrouting.**
  `resolveEgressProxy()` routed *every* fresh user through a hardcoded `proxykingdom.cn2.ai`,
  passed to Chrome as `--proxy-server` with no graceful degrade. With no wallet wired that
  proxy is unreachable, so **every `go` navigation died with `ERR_TUNNEL_CONNECTION_FAILED`
  and `fetch` returned a cryptic "No matching skill found".** Egress is now direct by default;
  a proxy is opt-in only. Separately, `KNOWN_COMMANDS` had drifted behind the dispatch switch,
  so `fetch`/`search`/`skills`/`spec`/`settings`/`explain` were misrouted into the one-hole
  resolver instead of their own handlers — now derived from the help table so it can't drift.

- **`v9.3.6` — proper every-command autoupdate.**
  Self-update only fired on `unbrowse upgrade` or a Codex/Claude hook whose bin pointed at a
  dead `dist/cli.js` (ENOENT). Now a throttled, detached, non-blocking background self-update
  fires on every normal command (the update-notifier / gh-cli shape). Also fixed
  `getInstalledVersion` reading `unknown` past a version-less `runtime/package.json` stub,
  which had made the updater believe it was perpetually behind.

---

## How to verify (don't take the summary's word for it)

```bash
# fresh install of the latest
npm i -g unbrowse@9.3.6 && unbrowse --version            # 9.3.6
unbrowse upgrade                                          # "Already at latest version: 9.3.6"

# the hole surface (spine 1)
unbrowse "top stories with points" --url https://news.ycombinator.com
unbrowse fetch https://example.com                       # prints page markdown (was broken in 9.3.4)

# egress is direct, no baked proxy (fix 7 / v9.3.5)
unbrowse go https://example.com                          # loads; launched Chrome has no --proxy-server
```

The two fixes from today carry unit + live witnesses in the tree:
`tests/iproyal-proxy-wiring.test.ts`, `tests/auto-update-decision.test.ts`,
`tests/update-hints.test.ts`. The proxy change is `src/execution/proxy-fetch.ts` +
`src/env/kuri-proxy-bridge.ts`; the dispatch fix is `KNOWN_COMMANDS` in `src/cli.ts`; the
autoupdate wiring is `src/runtime/update-hints.ts` + `main()` in `src/cli.ts`.

## What to look at if you only have ten minutes

1. **The hole contract** (`src/cli.ts` dispatch + `dist-sdk/hole.*`) — is the one-surface
   abstraction the right boundary? This is the bet the whole week rests on.
2. **DAG-recompute at execute** (`src/orchestrator/index.ts`) — the prerequisite-chain walk
   and composite persist/replay. This is the part with the most moving pieces.
3. **ZK input-censoring on writes** (`src/execution/index.ts`, publish boundary) — confirm no
   raw sensitive value crosses where only a commitment should.
