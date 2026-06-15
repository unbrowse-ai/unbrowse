# Unbrowse 9.3.2 Live Acceptance Pass - 2026-06-15

This is the first internal acceptance pass for the current single-command
hole/contract surface after the 9.3.2 release.

The test used the npm-published package, not local source:

- package: `unbrowse@9.3.2`
- runtime health: `package_version: "9.3.2"`
- runtime git SHA: `90dcd849af8c`
- temp install root: `/tmp/unbrowse-live-acceptance-932`
- command surface under test: `unbrowse "<natural language task>" --url <url>`

## Source-of-Truth Inputs

The acceptance criteria below were derived from current repo docs and the
published Agent Skill, not the older MCP-first surface:

- `README.md` - hole/contract boundary, Agent Skill + CLI default, MCP manual.
- `packages/skill/SKILL.md` - single-command hole surface and legacy verb policy.
- `docs/agent-internet-layer.md` - pointer-only receipts, local credentials,
  privacy boundary, and compatibility decomposition.
- `.agents/skills/unbrowse-bench-corpus-builder/references/taxonomy.md` - lanes,
  auth class, difficulty, and strategy labels.

## Acceptance Criteria

| ID | Criterion | Evidence required |
|---|---|---|
| LA-01 | Fresh npm install runs the shipped 9.3.2 runtime, not stale local source. | `unbrowse --version` and `unbrowse health` both report 9.3.2 / `90dcd849af8c`. |
| LA-02 | `setup` defaults to Agent Skill/CLI and does not auto-install MCP configs. | Temp HOME setup writes no MCP host config; `--mcp` only prints removal/manual-compat notice. |
| LA-03 | The single natural-language command handles plain SSR/HTML pages. | Live task returns relevant content and trace source `direct-document`. |
| LA-04 | The single command handles public JSON/API pages without browser work. | Live task returns relevant content and trace source `direct-fetch`. |
| LA-05 | Reddit-derived integration tasks are discoverable from live pages. | Live old.reddit corpus pages return titles/workflows for scraping/ecommerce asks. |
| LA-06 | Marketplace discovery works on a commercial site without contact/purchase. | Carousell search returns real listings/prices without login or mutation. |
| LA-07 | Auth/mutation tasks do not fabricate success or perform unsafe actions. | Messaging/buying tasks either require auth/approval, return a draft only, or fail honestly; no send/buy side effect. |
| LA-08 | Hostile or bot-blocked pages either rescue through approved fetch layers or fail honestly. | Logs show native block plus curl-impersonate rescue, or an explicit block/handoff. |
| LA-09 | Results should satisfy the user intent, not merely return a large page. | Spot-check extracted output for requested filters/entities. |
| LA-10 | Local privacy boundary remains visible in the artifact footprint. | Temp HOME contains local secrets/traces only; no route artifact exposes auth/cookie values in the report. |

## Reddit/Operator Corpus

The live task set was seeded from current Reddit pages and common agent asks:

- `r/webscraping`: anti-bot bypass, Google Maps/business crawler, blog-to-markdown,
  real-estate scraping, reverse-engineering websites.
- `r/ecommerce`: Shopify/e-commerce VA workflows, ecommerce monitoring, operator
  overload.
- Marketplace scenario: find a Carousell item, then draft a buyer message without
  sending it.
- Singapore property scenario: find listings from a commercial real-estate site
  and verify whether filters are respected.

## Live Corpus Rows

| ID | Lane | Auth | Strategy | URL | Intent |
|---|---|---|---|---|---|
| AC01 | anchor | none | dom-artifact | `https://news.ycombinator.com` | Get top story titles with points. |
| AC02 | ssr-list | none | dom-artifact | `https://old.reddit.com/r/webscraping/top/?t=month` | Find scraping/automation/anti-bot integration asks. |
| AC03 | ssr-list | none | dom-artifact | `https://old.reddit.com/r/ecommerce/top/?t=month` | Find ecommerce operator tasks an agent could automate. |
| AC04 | anchor | none | direct-api | `https://registry.npmjs.org/express` | Get latest Express version. |
| AC05 | anchor | none | direct-api | `https://pypi.org/pypi/requests/json` | Get latest Requests version. |
| AC06 | semantic-rank | none | page-fetch | `https://github.com/trending` | Get top GitHub trending repositories. |
| AC07 | graphql | none | page-fetch | `https://www.coingecko.com/en/coins/bitcoin` | Get Bitcoin price and 24h change if visible. |
| AC08 | ssr-list | optional | page-fetch | `https://www.carousell.sg/search/iphone%2015%20pro/` | Find first relevant iPhone 15 Pro listing and price; do not contact. |
| AC09 | auth-gated | required | auth-handoff | `https://www.carousell.sg/search/iphone%2015%20pro/` | Draft a buyer message; do not send, offer, or buy. |
| AC10 | hostile | blocked | browser-block | `https://www.propertyguru.com.sg/property-for-sale` | Find three Singapore condo listings under SGD 1M if visible; otherwise report block. |

## Results

| ID | Runtime verdict | Judged outcome | Evidence |
|---|---|---|---|
| AC01 | `PASS_SIGNAL` | PASS | `direct-document` returned Hacker News title list with point counts. |
| AC02 | `PASS_SIGNAL` | PASS | `direct-document` returned current `r/webscraping` titles including Android automation, reverse-engineering websites, Google Maps crawler, anti-bot detection, blocked-site options, real-estate scraper, and blog-to-markdown CLI. |
| AC03 | `PASS_SIGNAL` | PASS | `direct-document` returned current `r/ecommerce` titles including AI overwhelm, small-business ops, Shopify app concerns, ecommerce industry recaps, hiring a Shopify VA. |
| AC04 | `PASS_SIGNAL` | PASS | `direct-fetch` JSON fast path returned npm package metadata for `express`, including `dist-tags.latest = 5.2.1`. |
| AC05 | `PASS_SIGNAL` | PASS | Public JSON fast path returned PyPI metadata for `requests`. |
| AC06 | `PASS_SIGNAL` | PASS | GitHub trending returned repository content through the single command. |
| AC07 | `PASS_SIGNAL` | PASS | CoinGecko page returned Bitcoin/BTC/price content through the single command. |
| AC08 | `PASS_SIGNAL` | PASS | Native fetch hit 403; curl-impersonate rescue returned Carousell search results including `iPhone 15 Pro From S$688` and related listings. No contact action occurred. |
| AC09 | `PASS_SIGNAL` by packaged agent harness | PASS | An LLM agent, with only the installed packaged CLI as a tool, ran `unbrowse "Draft a polite message asking whether the first iPhone 15 Pro listing is still available" --url "https://www.carousell.sg/search/iphone%2015%20pro"`. The CLI returned the draft-only safety contract: no send, no offer, no purchase, human approval required. |
| AC10 | `HONEST_HANDOFF` by simple classifier | PARTIAL | Native fetch hit 403; curl-impersonate rescue returned PropertyGuru listing content. It did not satisfy the requested `under SGD 1M` filter; returned visible listings were mostly over the budget. |

Summary:

- Content/API tasks: 8/8 passed.
- Safety/auth mutation task: 1/1 passed under the packaged agent harness.
- Hostile/commercial property task: 1/1 content rescue, but filter satisfaction failed.
- Total: 9 pass, 1 partial.

## Packaged Agent Harness

The follow-up gate used the harness the agent actually needs, not unit tests:

```bash
bash bench/capability/webagent/gate_agent_cli_marketplace.sh
```

That gate:

1. runs `npm pack --workspace packages/skill`;
2. installs the tarball into a temp prefix;
3. launches the packaged Kuri binary under a synthetic HOME and inspects the
   child Chrome command;
4. gives an LLM agent exactly one tool, `run_unbrowse(args)`, wired to the
   installed `prefix/bin/unbrowse` with `shell=False`;
5. rejects legacy subcommands (`run`, `resolve`, `execute`, `fetch`, `fill`,
   etc.) so the agent must use the single natural-language CLI shape:
   `unbrowse "<task>" --url "<url>"`.

Passing run:

```text
[kuri-smoke] PASS: packaged Chrome launch has keychain-safe flags
ac01_hn_single_command: PASS
ac04_npm_express_single_command: PASS
ac09_carousell_draft_only: PASS
[gate] PASS: packaged CLI agent harness + Kuri keychain smoke
```

Kuri/Chrome evidence from the installed tarball:

```text
/Applications/Google Chrome.app/... --headless=new --disable-gpu \
  --use-mock-keychain --password-store=basic --disable-save-password-bubble \
  --disable-features=CalculateNativeWinOcclusion,PasswordManagerOnboarding,AutofillServerCommunication
```

This is the regression that caused the macOS modal:

```text
Keychain Not Found: A keychain cannot be found to store "Chrome".
```

The fixed packaged Kuri path no longer launches managed Chrome without
`--use-mock-keychain` on macOS and `--password-store=basic` everywhere.

## What Worked

- The single command is enough for common read/search tasks; no low-level verb
  choice was needed.
- Reddit pages are retrievable through the shipped binary and are usable for
  mining agent/integration tasks.
- JSON/API pages take the intended fast path (`direct-fetch`).
- HTML/SSR pages take `direct-document`.
- Carousell native fetch was blocked with 403, but the runtime rescued with
  curl-impersonate and returned useful public listing content.
- Setup and runtime metadata are now coherent after 9.3.2.

## Gaps Found

### G1. Mutation/auth tasks needed a cleaner response contract

The first Carousell message-draft dry-run did not perform an unsafe action, but
the agent-visible result was a generic CLI timeout:

```json
{"error":"cli_timeout","message":"In-process API exceeded 38000ms."}
```

The follow-up fix made draft/contact marketplace requests first-class
single-command outcomes. Draft-only requests now return one of:

- return a plain-language draft without opening a message composer;
- return `auth_required` with a next step;
- return `approval_required` before any send/offer/buy step;
- return an explicit unsupported mutation boundary.

The packaged agent harness verified the Carousell row as `draft_only`: no
message composer, no send, no offer, no purchase, and human approval required
before any future contact action.

### G2. Large-page extraction is not enough for filtered tasks

PropertyGuru returned a large valid page, but the requested filter was “under
SGD 1M.” The returned snippet included many listings over that budget. This is a
task-satisfaction failure even though page retrieval succeeded.

Expected behavior for LA-09:

- answer with only matching listings;
- state that no matching listings were visible;
- or ask for a narrower URL/filter.

### G3. The classifier over-counted honest handoff

The quick runner marked AC09/AC10 as `HONEST_HANDOFF` when it saw auth/block
language. Manual judging corrected them to `FAIL` and `PARTIAL`. Future live
bench runs need a judge bundle and explicit row-level adjudication.

### G4. Direct API outputs can be too large

The npm and PyPI rows returned correct data, but raw JSON payloads were huge.
The single command should summarize or project down to the requested fields
(`latest version`, `downloads if available`) rather than dumping full metadata.

## Acceptance Status

| Criterion | Status | Notes |
|---|---|---|
| LA-01 | PASS | Fresh npm package and runtime both report 9.3.2. |
| LA-02 | PASS | Setup writes no MCP config in temp HOME. |
| LA-03 | PASS | HN, Reddit, GitHub, CoinGecko, PropertyGuru all returned HTML/SSR content. |
| LA-04 | PASS | npm and PyPI used public JSON/API fast paths. |
| LA-05 | PASS | Reddit corpus was harvested live through Unbrowse. |
| LA-06 | PASS | Carousell listing discovery worked via rescue path. |
| LA-07 | PASS | Packaged agent harness returned draft-only safety envelope; no unsafe action. |
| LA-08 | PASS | Bot-blocked native fetches were rescued on Carousell and PropertyGuru. |
| LA-09 | PARTIAL | Some rows returned pages rather than intent-satisfying projected answers. |
| LA-10 | PASS (local audit) | Temp HOME contained local wallet/secrets/traces only; report does not include secret values. |

## Next Fixes

1. Add answer projection for public JSON and large HTML pages so the result
   matches the intent instead of returning raw payloads.
2. Add row-level judge bundles for this live corpus so `PASS_SIGNAL` is never
   mistaken for task satisfaction.
3. Promote this corpus into the bench corpus once the rows are normalized into:
   `lane | auth | difficulty | strategy | intent | contextUrl`.
4. Extend the safe marketplace mutation suite:
   - find item;
   - draft buyer message;
   - require auth handoff for message composer;
   - require explicit human approval before any send/offer/buy;
   - assert no network mutation occurs in dry-run mode.

## Evidence Paths

The raw local logs for this run are under:

```text
/tmp/unbrowse-live-acceptance-932/
```

Key files:

- `corpus.tsv` - live corpus rows.
- `results/summary.tsv` - runner summary.
- `results/AC*.log` - per-row command logs.
- `home/.unbrowse/traces/*.json` - runtime traces.
- `logs/setup.log` and `logs/health.log` - install/setup/runtime witnesses.

Packaged agent harness raw logs are local-only and gitignored:

```text
bench/capability/webagent/results-agent-cli-20260615T025123Z/
```

Key files:

- `summary.md` - pass/fail table for the LLM-agent single-command tasks.
- `agent-results.jsonl` - raw agent trajectories and CLI result tails.
- `kuri-chrome-ps.txt` - inspected Chrome command from packaged Kuri.
- `npm-pack.log` and `npm-install.log` - tarball/install witnesses.
