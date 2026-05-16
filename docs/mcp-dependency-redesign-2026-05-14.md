# MCP dependency + fallback redesign  -  2026-05-14

**Author:** Lewis + planning session
**Question:** Unbrowse MCP is "not being used properly." Why, and what's the fix?
**Sources:** Mined 35 session logs (2026-05-08 → 2026-05-14, 128 MCP calls + 182 CLI calls), audited 23 unbrowse-* skills, read `src/mcp.ts` tool registry and existing audit docs.

---

## TL;DR  -  what to fix, ranked by agent impact

| Rank | Issue | Impact | Cost |
|---|---|---|---|
| **P0a** | `unbrowse_run` hallucinated  -  most-called tool name doesn't exist (25 calls, 100% error) | Every other fix is moot until tool-name mental-model matches surface | 1-line alias dispatcher in `src/mcp.ts` OR full rename |
| **P0b** | `unbrowse_fetch` returns -32000 process death (11 calls observed) | Kills the whole MCP server, forces ToolSearch reload | Add process resilience handler at entry point + remove from advertised surface OR fix the crash |
| **P0c** | 25KB wire-budget clamp ignores caller `path/extract/limit` (32 truncations) | Systematic CLI fallback  -  every list endpoint >a few rows | Honor caller projection; only diet when no projection was passed |
| **P1a** | Session-bound tools (click/fill/press/select/submit/screenshot/scroll) NEVER CALLED (0 of 128) | Agents drop to `unbrowse_eval` JS escape hatch instead | Always-advertise these tools; return `no_active_session` error if called cold |
| **P1b** | `unbrowse_resolve` description has poison "ALTERNATIVES" clause | Carousell-shoes failure mode  -  agents take the alternative on a perfect cache hit | Surgical removal; rewrite to recipe-driven pattern |
| **P1c** | `COMMON_TOOL_POLICY` carries two competing rules ("go+markdown for URLs" vs "resolve-first for intent") | Coin-flip routing on URL+intent prompts | Pick one (resolve-first); kill the other |
| **P2a** | `defuddle` skill description steals URL-read prompts from `unbrowse` | Skill auto-routing coin-flip on "read this page" | Narrow defuddle to "only when unbrowse failed" OR retire it |
| **P2b** | 6 foundry-auto skills + 4 dev-loop duplicates pollute the skill catalogue | Wrong skill triggers, none triggers reliably | Delete the auto-gen stubs; collapse dev loops under `unbrowse-session-driver` |
| **P2c** | Canonical `packages/skill/SKILL.md` not installed in `~/.claude/skills/` | Lewis's curated description never wins auto-routing | Symlink or `bun run install-skill` step |
| **P3a** | `feedback` errors 50× (mostly fired post-shutdown) | Silent learning-loop break | Fire feedback BEFORE close; or queue locally if server gone |
| **P3b** | "MCP server disconnected" misleading message on session close | Context bloat, phantom-fault diagnosis | Rename event; suppress re-announcement |

**Order of operations:** P0 stop the bleeding before any redesign. P1-P2 land the redesign. P3 polish.

---

## Layer 1  -  Tool dependency graph (the contract agents read)

The 33 tools partition into a 6-tier state machine. Every tool description should name its **tier**, its **preconditions**, and point at `next_action` for sequencing  -  nothing more.

```
                       +-------------------------------------+
                       |  TIER 0 - INFO (always available)   |
                       |  health . stats . skills . skill .  |
                       |  sessions . settings . index        |
                       |  -> read-only; no preconditions     |
                       +-------------------------------------+
                                       |
                       +---------------+---------------+
                       v               v               v
            TIER 1 - RESOLVE      TIER 6 - DIAGNOSE   TIER 4 - AUTH
            (entry point)         (escape hatches)    (recovery)
            ---------------       -----------------   --------------
            unbrowse_resolve      diagnose            auth_capture
            { intent, url? }      trace
                                  validate
                       |
                  no_match? ---------------+
                       |                   v
                       v            TIER 2 - BROWSE LIFECYCLE
            TIER 3 - EXECUTE        -------------------------
            ---------------         unbrowse_go { url }
            unbrowse_execute         |
            { skill, endpoint }      |  <- after go, TIER 5 unlocks
                       |             |
                       v             v
            TIER 7 - FEEDBACK   TIER 5 - BROWSE INTERACT
            ----------------    -------------------------
            unbrowse_feedback   READ:  snap . text . markdown .
            (MANDATORY)                screenshot . cookies
                                ACT:   click . fill . type . press .
                                       select . scroll . submit . eval
                                       |
                                       v
                                CLOSE: sync . close
                                       |
                                       v
                       TIER 8 - REVIEW/PUBLISH (first-visit only)
                       -----------------------------------------
                       review -> publish -> annotate
```

**Invariants enforced by `next_action`:**

- `unbrowse_resolve` success → `next_action.command = "unbrowse_execute"` with `skill_id` + top `endpoint_id` pre-filled
- `unbrowse_resolve` no_match → `next_action.command = "unbrowse_go"` with `url` pre-filled
- `unbrowse_resolve` auth_required → `next_action.command = "unbrowse_auth_capture"` with login URL
- `unbrowse_execute` success → `next_action.command = "unbrowse_feedback"` with skill+endpoint pre-filled
- `unbrowse_execute` truncated → `next_action.command = "unbrowse_execute"` re-call with `schema: true` to inspect shape first
- `unbrowse_close` first-visit → `next_action.command = "unbrowse_review"` with skill_id
- `unbrowse_review` success → `next_action.command = "unbrowse_publish"` with skill_id (inspect)
- `unbrowse_publish` first call → `next_action.command = "unbrowse_publish"` with `confirm_publish: true`
- `unbrowse_auth_capture` success → `next_action.command = "unbrowse_resolve"` retry original intent

**Already shipped** (May 11 Phase 1): `next_action` exists in resolve/execute/close. **Missing**: publish chain, auth retry chain, truncation recovery, review chain.

---

## Layer 2  -  Fallback chain spec (one error → one next move)

| Error class | Source tool | Next move (next_action.command) | Rationale |
|---|---|---|---|
| `no_match` / `no_cached_match` | resolve | `unbrowse_go { url }` | Cold domain; live capture is the path |
| `auth_required` | resolve / execute | `unbrowse_auth_capture { url }` | Cookie / login flow |
| `endpoint_not_found` / `stale_endpoint` | execute | `unbrowse_resolve { intent, url, force_capture: true }` | Cache stale; re-resolve |
| `payload_exceeded_wire_budget_after_diet` | execute | `unbrowse_execute { ..., schema: true }` then narrower `path` | Inspect shape, then project |
| `recoverable_browse_failure` | go | `unbrowse_diagnose` then `unbrowse_health` | Surface visual + version, then fail loudly |
| `Connection closed` (-32000) | any | `unbrowse_health` (forces respawn) then retry | Daemon was reaped |
| `kuri_problem` | go / fetch | `unbrowse_diagnose` + report to user | Browser broke; not agent's job to fix |
| `confirm_third_party_terms` | resolve / execute | Same tool with flag set | One-call retry, no branch |
| `browse_session_open` | go | `unbrowse_snap` (start interactive loop) | Tab is live |

**Critical:** every error MUST emit a structured `next_action` even when `unbrowse_diagnose` is the answer. Today browser failures return a prose error with no machine-readable next step.

**Hard rule:** if no `next_action` can be populated (e.g. `unbrowse_go` failure with no URL context), emit `next_action: null` explicitly with `error_class` and `user_surface: true` flag  -  agent shows the error to the user instead of looping.

---

## Layer 3  -  Description refactor (recipe-driven)

**Template** every tool follows after refactor:

```
<one-line purpose: what the tool does in user vocabulary>.

Tier: <0-8>. Preconditions: <none | open browse session | prior resolve>.
Sequencing: dispatch on `next_action` in the result. For the multi-step
recipe, fetch `prompts/get workflow:<recipe-name>` with your intent.

Mutually exclusive with: <names>. Never call directly when <condition>.
```

**Example  -  `unbrowse_resolve` BEFORE (current, 296 chars + poison):**

> Use when the agent has an INTENT (e.g. 'top stories', 'get user profile') and wants a structured result. Returns a ranked shortlist of cached marketplace endpoints. Workflow: (1) call unbrowse_resolve with the intent + url/domain to receive available_endpoints; (2) pick the best match using example_response_compact, requires, and yields fields as evidence; (3) call unbrowse_execute with that endpoint_id. **ALTERNATIVES: if you just have a URL and want its raw page contents, call unbrowse_go then unbrowse_markdown (no marketplace lookup needed).** If the site has no cached endpoints (status=no_match), fall through to unbrowse_go to capture fresh DOM. AFTER presenting results to the user, you MUST call unbrowse_feedback.

**AFTER (recipe-driven, ~180 chars, no poison):**

> Entry point for any web task. Returns a ranked endpoint shortlist or routes to live capture. Tier 1. Preconditions: none. Sequencing: dispatch on `next_action`. For the full playbook, fetch `prompts/get workflow:resolve-execute-feedback` with `intent` and `url`.

The "ALTERNATIVES" clause is the poison  -  it offers `unbrowse_go` as an option BEFORE resolve has run, training agents to skip cache. The new shape names ONE entry point and points to a recipe for sequencing.

**Apply this template to all 33 tools.** Concrete rewrite list at the end of this doc; size budget is 800 chars cumulative per tool incl. tier + preconditions + recipe reference. That keeps `tools/list` response under 30KB total (33 tools × 800 chars = 26.4KB).

**Recipe prompts needed** (extend `src/mcp.ts:484-577`):

| Recipe name | Args | Replaces this prose | Tier coverage |
|---|---|---|---|
| `workflow:resolve-execute-feedback` shipped | `intent, url` | Cached-intent happy path | 1->3->7 |
| `workflow:browse-and-publish` shipped | `intent, url` | Cold-intent full path | 1->2->5->8 |
| `workflow:auth-then-retry` NEW | `url, intent` | Auth recovery | 1->4->1->3 |
| `workflow:truncation-recovery` NEW | `skill, endpoint` | 25KB clamp escape | 3 (schema -> narrower projection) |
| `workflow:browse-extract` NEW | `url, what_to_extract` | Read-only browse | 2->5(read)->close |
| `workflow:diagnose-and-report` NEW | `last_tool, error_class` | Fail-loudly path | 6->user |

**Critical: kill `COMMON_TOOL_POLICY`'s "go+markdown for URL contents" clause.** Replace the whole block with:

> ROUTING: `unbrowse_resolve` is the entry point for ANY web task. The result's `next_action` field tells you the next call. Never call `unbrowse_go`, `unbrowse_execute`, or browser-interaction tools without a prior `next_action` directing you there. For workflow sequencing, fetch `prompts/list` and dispatch on `workflow:*` recipes.

---

## Layer 4  -  Skill consolidation

Current state in `~/.claude/skills/`:

| Cluster | Members | Verdict |
|---|---|---|
| **Auto-gen stubs (delete)** | `base-directory-unbrowse`, `explore-unbrowse-codebase`, `test-unbrowse`, `unbrowse-understand`, `kuri-unbrowse`, `unbrowse-using-server` | All have foundry template descriptions, never triggered productively |
| **Dev-loop duplicates (collapse)** | `unbrowse-dogfood`, `unbrowse-eval`, `unbrowse-improvement-loop`, `unbrowse-local-verify-loop`, `unbrowse-test-loop`, `unbrowse-trace-loop` | `unbrowse-session-driver` is the umbrella; keep it + `unbrowse-eval` for evals; retire the rest |
| **Specialized (keep)** | `unbrowse-ai`, `unbrowse-session-bug-harvester`, `unbrowse-funnel-operator`, `unbrowse-financial-modeling`, `unbrowse-warm-outreach`, `unbrowse-typefully-campaigns`, `unbrowse-growth-os`, `unbrowse-visual-campaign-loop` | Distinct purposes, no overlap |
| **Adjacent (disambiguate)** | `defuddle`, `agent-browser`, `kuri-agent`, `browser-automation` | Either narrow descriptions to "fallback only" or retire |
| **Canonical (install)** | `packages/skill/SKILL.md` (NOT in `~/.claude/skills/`) | Add to skill catalogue |

**Concrete actions:**

1. **`bun run install-canonical-skill`**  -  script that symlinks `packages/skill/SKILL.md` to `~/.claude/skills/unbrowse/SKILL.md` so Claude's loader sees Lewis's curated description.
2. **Delete the 6 auto-gen stubs.** They have `candidate_skill: true` in frontmatter and have never been promoted.
3. **Collapse 4 dev-loop duplicates** under `unbrowse-session-driver`. Move their content into `references/` of session-driver and delete the standalone skills.
4. **Narrow `defuddle`**  -  change its description from "Use instead of WebFetch when the user provides a URL" to "Use ONLY when `unbrowse` has explicitly failed and the user authorized fallback. Default to `unbrowse` for any URL/web task."
5. **Retire `browser-automation`** (truncated description, no unbrowse reference, contradicts the unbrowse-first rule).
6. **Add explicit anti-routing prose to canonical `unbrowse` skill description**: "Replaces curl, fetch, WebFetch, defuddle, agent-browser, kuri-agent, browser-automation, page.goto, headless playwright, manual screenshots."

---

## Verification  -  agent-judged eval harness

Per Lewis's pick: re-run canonical intents after each layer change, agent in-thread judges artifacts. NO grep-based pass/fail.

**Corpus** (`harness/probes/mcp-redesign-corpus.txt`):

```
# format: intent | url | expected_terminus
search carousell sg for m3 ultra mac studio | https://www.carousell.sg/search/mac%20studio%20m3%20ultra | execute_returns_listings
find shoes on carousell | https://www.carousell.sg/search/shoes | execute_returns_listings
get the page title of arxiv.org/abs/2604.00694 | https://arxiv.org/abs/2604.00694 | execute_returns_title
search eatigo for restaurants near pagoda street | https://www.eatigo.com/sg/singapore/all/all | execute_returns_restaurants
trending stories on hacker news | https://news.ycombinator.com | execute_returns_stories
read this article | https://www.theverge.com/tech | execute_returns_article
```

**Runner** (`harness/probes/mcp-redesign.sh`):
1. Spawn fresh MCP session, snapshot `tools/list`
2. For each corpus row, simulate an agent loop:
   - Call resolve, dispatch on `next_action` exactly as a real agent would
   - Cap at 5 tool calls per intent  -  if not converged, mark as `infinite_loop`
   - Capture full transcript per intent: `harness/runs/<run-id>/<intent-hash>.jsonl`
3. NO assertions; emit manifest.json with raw artifacts.

**Judge protocol** (`harness/probes/mcp-redesign-judge.md`):
- For each intent: did the agent reach `expected_terminus`?
- Tool-call count vs budget (5)?
- Any hallucinated tool names called?
- Any error-class without a `next_action`?
- Did the agent ever drop to CLI or curl mid-flow?

**Regression gates:**
- Hallucinated tool count must be 0 (zero `unbrowse_run` / `unbrowse_fetch` errors).
- Per-intent budget <= 4 tool calls for cached-intent class (2a).
- Per-intent budget <= 12 tool calls for cold-intent class (2b).
- Zero CLI/curl fallbacks (the harness can detect Bash invocations via tool-use ordering).

Hook the corpus into the existing **agent-experience harness** (`bun run agent-xp`) so this becomes a release-blocking check, not a one-off.

---

## Concrete edit plan

Phase 0  -  stop the bleeding (1-2 commits):

1. `src/mcp.ts`  -  add `unbrowse_run` and `unbrowse_fetch` as **alias tools** that dispatch to `unbrowse_resolve` and either fail loudly with a clear "renamed to X" message OR transparently call the right tool. Choice: **transparent dispatch + deprecation note in result**  -  solves 36 wasted calls per Lewis's session corpus at zero cost.
2. `src/mcp.ts:820-905` (`dietIfOversize` + `maybePostProcessResult`)  -  when caller passed `path`/`extract`/`limit`, do NOT run the safety-net diet on the result, OR raise `WIRE_BUDGET_CHARS` to 250KB for projected results. Test: `tests/mcp-payload-projection.test.ts`  -  call execute with `limit: 297` on a 565KB endpoint, assert returned array length === 297, assert no `truncated: true`.
3. Add `process.on('uncaughtException')` + `process.on('unhandledRejection')` at MCP entry point (around `src/mcp.ts:2367`-ish). Convert throws to JSON-RPC error envelopes; keep stdio loop alive. Test: `tests/mcp-fetch-resilience.test.ts` from `carousell-shoes-mcp-fix-plan.md`.

Phase 1  -  description refactor (1 commit):

4. Apply the 800-char template to all 33 tool descriptions. Delete every "ALTERNATIVES" / "if you just have a URL" / "or call X instead" clause. Test: `tests/tool-descriptions-no-poison.test.ts`  -  grep every description for banned substrings, fail if any match.
5. Rewrite `COMMON_TOOL_POLICY` (lines 721-728) to single-rule resolve-first routing.

Phase 2  -  recipe prompts (1 commit):

6. Add 4 new recipe prompts (`workflow:auth-then-retry`, `workflow:truncation-recovery`, `workflow:browse-extract`, `workflow:diagnose-and-report`). Wire into `prompts` array at `src/mcp.ts:579-609`. Test: `tests/workflow-prompts-coverage.test.ts`  -  assert every error class in Layer 2 maps to a recipe.

Phase 3  -  session-tool visibility (1 commit):

7. Stop hiding session-bound tools behind `listChanged`. Always advertise click/fill/press/select/submit/screenshot/scroll. When called without an active session, return `error: "no_active_session", next_action: {command: "unbrowse_go", command_args: {url: <hint>}}`. Test: `tests/mcp-session-tool-cold-call.test.ts`  -  call `unbrowse_click` before any `unbrowse_go`, assert error envelope shape (not absence from tools/list).

Phase 4  -  fallback chains (1 commit):

8. Populate `next_action` on every error path in execute / go / close / review / publish handlers per Layer 2 spec. Test: `tests/mcp-next-action-coverage.test.ts`  -  call every tool with conditions that produce every documented error class, assert each result has either dispatchable `next_action` or `next_action: null` with `user_surface: true`.

Phase 5  -  skill catalogue (out of repo, in `~/.claude/skills/`):

9. Symlink `packages/skill/SKILL.md` -> `~/.claude/skills/unbrowse/SKILL.md`.
10. `rm -rf ~/.claude/skills/{base-directory-unbrowse,explore-unbrowse-codebase,test-unbrowse,unbrowse-understand,kuri-unbrowse,unbrowse-using-server,browser-automation}`.
11. Collapse `unbrowse-{dogfood,improvement-loop,local-verify-loop,test-loop,trace-loop}` into `unbrowse-session-driver/references/`.
12. Edit `~/.claude/skills/defuddle/SKILL.md` description to "fallback only" wording.

Phase 6  -  verification (1 commit):

13. Ship the corpus + runner + judge protocol described above. Wire `bun run agent-xp:mcp-redesign` as a release-blocking eval.

---

## Rollback plan

Each phase is one commit, independently revertible. P0 phase is the highest-risk for users (changes behavior) but each fix is structurally trivial. If the alias dispatcher misbehaves, removing it returns the surface to today's broken state  -  no worse off than now.

The description refactor (Phase 1) is the highest-risk for *agents*  -  changing 33 descriptions at once could regress more than it fixes. Mitigation: land Phase 1 behind a `UNBROWSE_DESCRIPTION_V2=1` env var for one minor release; flip default after the agent-judged eval reports zero regressions across the corpus.

---

## Out of scope this redesign

- `unbrowse_fetch` as a real tool  -  Lewis's `mcp-workflow-guide.md` §M4 already tracks this; the alias dispatcher in P0a is the bridge until the real tool ships.
- CLI redesign  -  CLI is fine; agents prefer it for the wrong reasons (clamp + hallucination), not for CLI strengths. Fix MCP, CLI usage will drop naturally.
- Marketplace endpoint quality (wrong-template, stale skills)  -  separate problem, separate plan.
- Streaming MCP responses  -  protocol-level work, distinct loop.

---

## Open questions for Lewis

1. **Alias dispatcher vs hard rename:** Do we want `unbrowse_run` to transparently call `unbrowse_resolve`, OR fail with `"Renamed to unbrowse_resolve. Call that instead."` and let the agent learn? Transparent dispatch is friendlier; hard rename forces a one-time training update. Recommend transparent + deprecation note.
2. **Description budget:** 800 chars/tool × 33 tools = 26.4KB on `tools/list`. Acceptable? Current is higher (~35KB with poison clauses). New target halves the description prose; can go tighter if needed.
3. **Skill catalogue cleanup:** Lewis owns `~/.claude/skills/`. I can write the symlink + rm script but you run it  -  confirm before I include in the diff.
4. **Verification corpus:** 6 intents in the corpus is the minimum. Want more (Reddit, X, Stripe docs, Linear)? Each adds eval time; current corpus runs ~3 min on remote agent-xp.
5. **Recipe-driven references in tool descriptions:** if a host (Aiko, custom SDK) doesn't fetch `prompts/get`, the description's `workflow:*` reference is a dead pointer. Acceptable degradation since `next_action` still works? Recommend yes  -  recipes are belt-and-suspenders for hosts that consume them.
