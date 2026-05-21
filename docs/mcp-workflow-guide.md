# Unbrowse MCP Workflow Guide

**For:** any MCP host (Claude Desktop, Cursor, Aiko, Claude Code, custom agent SDK)
**Source of truth:** `src/mcp.ts` — every line cite below resolves to current code.
**Companion docs:** `docs/mcp-vs-cli-ux-audit.md`, `docs/mcp-ux-fix-plan.md`

This guide tells your driving LLM the **exact tool sequence** for the common things callers ask Unbrowse to do. Read top to bottom in ~10 minutes.

---

## Part I — Flows

### §1 What Unbrowse is, in one paragraph

Unbrowse is an **API-native agent browser**: it takes a natural-language intent ("search Reddit for X"), looks up a cached marketplace skill, and either calls a learned API endpoint directly OR opens a real Chrome tab via Kuri, watches the traffic, and turns it into a reusable skill so the next call is the API path. The MCP server exposes 39 tools that drive this loop. Your job as a caller is to pick the right starting tool, dispatch what each result says comes next, and never short-circuit the publish step on a cold path.

### §2 The three intent classes

| Class | What the user asked for | Start with | Common terminus |
|---|---|---|---|
| **2a** Cached intent | "find X on site Y" (Unbrowse has used this site before) | `unbrowse_resolve` | `unbrowse_execute` → `unbrowse_feedback` |
| **2b** Cold intent | Same shape, but first time on this domain | `unbrowse_resolve` (falls through) → `unbrowse_go` | `unbrowse_close` → `unbrowse_review` → `unbrowse_publish` |
| **2c** URL → contents | "open this URL and tell me what's there" | `unbrowse_resolve` (with `url`, `--raw`) | Falls into 2a or 2b |

`unbrowse_fetch` ships as of v6.16 (`src/mcp.ts` line ~3180) -- it's the one-shot URL fetcher Class 2c falls through to when the marketplace has no skill yet. The §M4 entry below is kept as historical context for callers reading older transcripts; current callers should use `unbrowse_fetch` directly.

---

### §2a — Cached intent (the happy path, 1-2 tool calls)

```
unbrowse_resolve { intent, url? }   ← src/mcp.ts:944
        │
        ├─ result.available_endpoints[]  → pick by example_response_compact + requires/yields
        │
unbrowse_execute { skill, endpoint, params }   ← src/mcp.ts:1021
        │
        ├─ result.next_action.command === "unbrowse_feedback"   (post Phase 1, src/mcp.ts:680)
        │
unbrowse_feedback { skill, endpoint, rating: 1-5 }   ← src/mcp.ts:1172
        │
        └─ done. Show the user the data from execute.
```

**Picking from the shortlist** (`unbrowse_resolve` returns ranked endpoints):
- Score order is BM25-driven; trust the top entry by default.
- Confirm by reading `example_response_compact` — does the shape match the user's intent?
- Inspect `requires` and `yields` — are the required params already in your context?
- Per `src/mcp.ts:945` workflow, do NOT skip ahead to `unbrowse_execute` without resolving first; you risk wrong-template or stale endpoint.

**`unbrowse_feedback` is non-optional** (`src/mcp.ts:1022`). Rating: 5=right+fast, 4=right+slow, 3=incomplete, 2=wrong endpoint, 1=useless.

---

### §2b — Cold intent (browse → capture → publish, 6-12 tool calls)

When `unbrowse_resolve` returns `status: "no_cached_match"`:

```
unbrowse_resolve { intent, url } → result.status === "no_cached_match"
        │   result.next_action.command === "unbrowse_go"  (post Phase 1, src/mcp.ts:832)
        │
unbrowse_go { url }                            ← src/mcp.ts:1464
        │
        ├─ Returns session_id (implicit; tab is now live)
        │
LOOP: explore until you have what the user asked for
        │
        ├── unbrowse_snap                      ← src/mcp.ts:1485   read a11y tree with [eN] refs
        ├── unbrowse_click { ref }             ← src/mcp.ts:1505
        ├── unbrowse_fill { ref, value }       ← src/mcp.ts:1526
        ├── unbrowse_type { text }             ← src/mcp.ts:1549
        ├── unbrowse_press { key }             ← src/mcp.ts:1570   e.g. "Enter"
        ├── unbrowse_select { ref, value }     ← src/mcp.ts:1591
        ├── unbrowse_scroll                    ← src/mcp.ts:1614
        ├── unbrowse_submit                    ← src/mcp.ts:1636   form submission
        ├── unbrowse_text / unbrowse_markdown  ← src/mcp.ts:1683/1663  read page content
        └── unbrowse_eval { expression }       ← src/mcp.ts:1725   JS escape hatch (avoid if possible)
        │
        │   ← After every snap, act on the [eN] element ref from the new tree,
        │     not on stale refs from a previous snap. The DOM changes.
        │
        │   ← If a step looks broken (empty snap, blank page, wrong content),
        │     branch to §4b — unbrowse_diagnose / unbrowse_trace surface what
        │     happened without restarting the session.
        │
        ├─ When you have the answer for the user:
        │
unbrowse_close { session_id? }                 ← src/mcp.ts:1762
        │   (or unbrowse_sync to checkpoint without closing — src/mcp.ts:1746)
        │
        ├─ result.next_action.command === "unbrowse_review"   (post Phase 1, src/mcp.ts:709)
        │
unbrowse_review { skill, endpoints }           ← src/mcp.ts:1217
        │   write proper descriptions + action_kind/resource_kind per endpoint
        │
unbrowse_publish { skill, confirm_publish: true }  ← src/mcp.ts:1282
        │   FIRST call without confirm_publish — inspect the diff
        │   SECOND call with confirm_publish: true — actually publish
        │
        └─ done. Now show the user the data from the browse loop.
```

**Stop conditions you MUST observe:**
- `unbrowse_review` and `unbrowse_publish` are **non-skippable** on first-visit to a domain (`src/mcp.ts:1022, 1187, 1252, 1740`). The MCP returns `next_action: { command: "unbrowse_review" }` after close/sync precisely to make this hard to miss. **Do not answer the user before calling them** unless `next_action` is absent and you confirmed via `unbrowse_skills` that the domain was already published.
- The browse session's `session_id` is implicit — tools below `unbrowse_go` operate on the active session. Pass `session_id` only if you opened a named one.

---

### §2c — URL → contents (no dedicated path)

Today, "just fetch this URL" routes through `unbrowse_resolve { url, raw: true }`. If a cached endpoint matches (most major sites have one), execute it. If not, fall through to §2b's browse path, but exit early after `unbrowse_text` or `unbrowse_markdown` — you still close + review + publish for the domain's first visit.

When `unbrowse_fetch` ships (tracked separately), this section collapses to one tool call. See Part III §M4.

---

### §3 Reading tool results

#### `next_action` (Phase 1, shipped 2026-05-11 commit `928ccc79`)

Every result that previously carried `_workflow_hints` now ALSO carries a root-level structured `next_action`:

```jsonc
{
  // ... tool-specific result fields
  "next_action": {
    "title": "Review the captured endpoints",
    "command": "unbrowse_review",          // literal MCP tool name
    "command_args": { "skill": "sk_eatigo_chinatown" },
    "why": "Required before publish so the marketplace gets a real schema."
  },
  "_workflow_hints": { /* prose, legacy, back-compat */ }
}
```

**Dispatch rule:**
1. If `next_action` is present → call `next_action.command` with `next_action.command_args` (merge user-provided params if needed).
2. If `next_action` is absent → fall back to `_workflow_hints.next_step` (prose) and parse manually.
3. If both absent → terminal step, return to the user.

`next_action` is omitted when the suggested call is not dispatchable (e.g. `unbrowse_go` needs a `url` but resolve had only a domain — `src/mcp.ts:832`). In that case the prose hint still describes the intent verbally.

#### Dynamic tool reveal (Phase 2, shipped 2026-05-11)

Two cheatsheet primitives the server now uses on the wire:

1. **`initialize` declares** `capabilities.tools.listChanged: true` and `capabilities.prompts.listChanged: true`.
2. **`tools/list` is state-dependent.** Before any `unbrowse_go`, the server returns ~18 tools (resolve/execute/feedback/skills/auth/etc.). After `unbrowse_go` succeeds, the server emits `{ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }` and the next `tools/list` returns all 33 (the 15 session-bound tools — `unbrowse_snap`, `click`, `fill`, `type`, `press`, `select`, `scroll`, `submit`, `screenshot`, `text`, `markdown`, `cookies`, `eval`, `sync`, `close` — are revealed). On `unbrowse_close`, the notification fires again and the list shrinks back.

**Caller obligation:** when you receive `notifications/tools/list_changed`, re-issue `tools/list` immediately. The MCP spec requires this; without it, your agent never sees the freshly-revealed session tools.

#### Workflow recipes via `prompts/get` (Phase 3, shipped 2026-05-11)

`prompts/list` now includes:

- `workflow:resolve-execute-feedback` — args: `{ intent, url? }`. Returns the cached-intent playbook (§2a).
- `workflow:browse-and-publish` — args: `{ intent, url }`. Returns the cold-intent playbook (§2b). Encodes the non-skippable close→review→publish sequence as injectable text — Aiko's failure mode (§M1) prevented by recipe injection rather than reasoning over prose.

Calling `prompts/get` returns `{ description, messages: [{ role:"assistant", content:{ type:"text", text:"..." }}] }`. The text is templated against the args and lists the exact tool sequence to follow.

#### Error shapes

| `result.status` or `result.error` | What it means | Next move |
|---|---|---|
| `no_cached_match` | Resolve found nothing; intent is cold for this domain | §2b — `unbrowse_go` |
| `auth_required` | Site rejected the call without a login | §4a — `unbrowse_auth_capture` |
| `browse_session_open` | First-pass browser already opened a tab for this resolve | Drive it: `unbrowse_snap` → act → close |
| Generic HTTP errors in `result.error` | Backend or upstream API failed | Read `result.error` text; may need `unbrowse_diagnose` |

### §4 Side-branches

#### §4a — Authentication (`unbrowse_auth_capture`, `src/mcp.ts:1397`)

Trigger when a previous call returned `auth_required`, OR pre-emptively before scraping a gated page. **Opens a visible Chrome tab** for the user to sign in; cookies persist for future `unbrowse_resolve` / `unbrowse_execute` / `unbrowse_go` calls.

```
unbrowse_resolve { intent, url } → result.error === "auth_required"
        │
unbrowse_auth_capture { url }                  ← src/mcp.ts:1397
        │   (user signs in via tab; cookies stored in Keychain)
        │
unbrowse_resolve { intent, url }               ← retry, should now succeed
```

**Not for logging into Unbrowse itself** (no such login exists) — for the target SITE's auth.

#### §4b — Diagnosis (when something is wrong)

| Tool | Line | When |
|---|---|---|
| `unbrowse_diagnose` | `src/mcp.ts:1875` | A previous call returned wrong/empty data; capture visual + structured context |
| `unbrowse_trace` | `src/mcp.ts:1900` | Get execution trace with diagnostic scores + screenshots |
| `unbrowse_validate` | `src/mcp.ts:1917` | Verify a captured skill is still correct (screenshots vs schema) |

Use sparingly; these are escape hatches for the agent or for Lewis when something looks broken.

### §5 Hard stop rules

1. **Never show the user data from a cold-browse session without calling `unbrowse_review` + `unbrowse_publish`** (Aiko's eatigo failure — see Part III §M1).
2. **Never call `unbrowse_execute` without first calling `unbrowse_resolve`** (`src/mcp.ts:945, 991, 1434`).
3. **Never trust a stale `[eN]` ref** — always re-snap after any action that changes the page.
4. **Never call `unbrowse_publish` once and assume it shipped** — the first call is inspection; only `confirm_publish: true` actually publishes (`src/mcp.ts:1283`).
5. **Browser-open is a failure mode, not a feature.** If `unbrowse_resolve` returns a cached endpoint, prefer it over `unbrowse_go` even if you could browse.

---

## Part II — Tool reference

Every tool registered by `src/mcp.ts` (39 total as of v6.16). The list below is canonical for tool *names* and intended use; line cites have drifted significantly since the v6.13 baseline and SHOULD be re-derived at read time with `grep -n 'name: "unbrowse_' src/mcp.ts`. Tools added since v6.13: `unbrowse_reflect`, `unbrowse_publish_suggestions`, `unbrowse_earnings`, `unbrowse_run`, `unbrowse_fetch`, `unbrowse_test_crash`.

### Resolve / execute / feedback (5)

| Tool | Line | Required | Summary |
|---|---|---|---|
| `unbrowse_health` | 995 | — | Local runtime health + version trace. Use to confirm MCP is alive. |
| `unbrowse_resolve` | 1005 | `intent` | Rank cached marketplace endpoints by intent + url. Start here for ANY web task. |
| `unbrowse_execute` | 1082 | `skill`, `endpoint` | Call a chosen endpoint. Pass `params` for templates/queries. |
| `unbrowse_stats` | 1137 | — | Lifetime impact: time saved, tokens saved, browser calls avoided. |
| `unbrowse_feedback` | 1233 | `skill`, `endpoint`, `rating` | MANDATORY after execute. 5=right+fast → 1=useless. |

### Skill management (6)

| Tool | Line | Required | Summary |
|---|---|---|---|
| `unbrowse_index` | 1261 | `skill` | Recompute local DAG + workflow contracts for a cached skill. |
| `unbrowse_review` | 1278 | `skill`, `endpoints` | Write descriptions + action_kind/resource_kind. MANDATORY after browse. |
| `unbrowse_publish` | 1343 | `skill` | Two-call: first inspect, then `confirm_publish: true` to ship to marketplace. |
| `unbrowse_annotate` | 1841 | `skill`, `endpoint` | Contribute learned constraints/best practices to an endpoint. |
| `unbrowse_skills` | 1479 | — | List locally available + learned skills. |
| `unbrowse_skill` | 1489 | `id` | Fetch one skill manifest by id. |

### Settings / auth / sessions (3)

| Tool | Line | Required | Summary |
|---|---|---|---|
| `unbrowse_settings` | 1410 | — | Show or update capture/publish policy + domain rules. |
| `unbrowse_auth_capture` | 1458 | `url` | Open Chrome tab for the user to sign in to a target site; cookies persist. |
| `unbrowse_sessions` | 1506 | `domain` | Read stored session logs for one domain. |

### Browse open / close (3)

| Tool | Line | Required | Summary |
|---|---|---|---|
| `unbrowse_go` | 1525 | `url` | Open a live Chrome tab and begin passive capture. Implicit session_id. |
| `unbrowse_sync` | 1807 | — | Checkpoint capture mid-session, queue index pipeline, keep tab open. |
| `unbrowse_close` | 1823 | — | Close the session, checkpoint, queue index. ALWAYS followed by review + publish on first-visit. |

### Browse read (5)

| Tool | Line | Required | Summary |
|---|---|---|---|
| `unbrowse_snap` | 1549 | — | A11y tree with `[eN]` refs. Re-snap after every action that changes the DOM. |
| `unbrowse_screenshot` | 1728 | — | PNG of current tab. Diagnosis use. |
| `unbrowse_text` | 1744 | — | Plain text of current page. |
| `unbrowse_markdown` | 1758 | — | Markdown render of current page. Prefer over `_text` for structured content. |
| `unbrowse_cookies` | 1772 | — | Inspect cookies visible to the current tab. |

### Browse act (8)

| Tool | Line | Required | Summary |
|---|---|---|---|
| `unbrowse_click` | 1569 | `ref` | Click element by `[eN]` ref from a recent snap. |
| `unbrowse_fill` | 1590 | `ref`, `value` | Set input value by ref (no keystrokes — direct). |
| `unbrowse_type` | 1613 | `text` | Type with key events at the currently focused element. |
| `unbrowse_press` | 1634 | `key` | Press a key (e.g. "Enter", "Tab", "Escape"). |
| `unbrowse_select` | 1655 | `ref`, `value` | Select option in a `<select>` by ref. |
| `unbrowse_scroll` | 1678 | — | Scroll current page. |
| `unbrowse_submit` | 1700 | — | Submit the currently focused form. |
| `unbrowse_eval` | 1786 | `expression` | Run JS in the tab. Escape hatch; prefer structured tools when possible. |

### Diagnosis (3)

| Tool | Line | Required | Summary |
|---|---|---|---|
| `unbrowse_diagnose` | 1875 | — | Capture visual + structured context when something is wrong. |
| `unbrowse_trace` | 1900 | — | Execution trace with diagnostic scores + visual context. |
| `unbrowse_validate` | 1917 | `skill_id` | Validate a captured skill quality by screenshotting current behavior. |

---

## Part III — Common mistakes (the failure museum)

### §M1 — Show data before publish (Aiko's eatigo, 2026-05-11)

**What happened:** Aiko got "find food on eatigo at 54a pagoda street," ran `resolve → go → snap → fill → press → snap → click → snap → text`, presented 38 restaurants to the user, **stopped**.

**Why:** Pre-Phase-1, the `_workflow_hints.next_step` field said "Call unbrowse_review to describe the captured endpoints, then unbrowse_publish." Aiko literally reasoned past it ("the typical feedback/publish flow doesn't quite apply the same way") and skipped.

**Prevention:**
- Post-Phase-1: `unbrowse_close` now returns `result.next_action.command === "unbrowse_review"` at the root. Treat `next_action` as dispatchable, not interpretive (Part I §3).
- Hard rule in §5.1: never answer the user from a cold-browse session before review + publish.

### §M2 — Treat prose hints as advice

**What happened:** Same as M1 — `_workflow_hints` was treated as English suggestion the LLM could agree with or not.

**Prevention:** Dispatch on the structured `next_action` (Part I §3). The prose field remains for back-compat; it's not the contract.

### §M3 — Call `unbrowse_execute` without `unbrowse_resolve`

**What happens:** You don't know which skill or endpoint to pass. You guess. Wrong template fires. Real data is two endpoints away.

**Prevention:** `src/mcp.ts:945` makes this explicit in the tool description: "ALWAYS call this first." Treat resolve as the only legitimate way to obtain `(skill, endpoint)` arguments for execute. The only exception is calling execute again with the SAME endpoint_id returned by the prior resolve.

### §M4 — Try to call `unbrowse_fetch`

**What happens:** Several prose hints reference `unbrowse_fetch` (`src/mcp.ts:566, 573, 945, 1398`). It does NOT exist as a registered tool. Your `tools/call` returns method-not-found.

**Prevention:** Until the tool ships, route URL-fetch intents through `unbrowse_resolve { url, raw: true }` and fall through to §2b's browse path if cache misses. Track in `docs/mcp-ux-fix-plan.md` for future addition.

### §M5 — Publish without `confirm_publish: true`

**What happens:** You call `unbrowse_publish { skill }`. The result looks fine. You assume the skill is in the marketplace. It isn't — that call was inspection-only.

**Prevention:** `src/mcp.ts:1283` documents the two-call pattern. The first call returns a preview; the second call with `confirm_publish: true` actually publishes. Always make two calls; never skip the inspect.

---

## Appendix — File map

| File | What lives there |
|---|---|
| `src/mcp.ts:901-1838` | The 33-tool registry (single `const tools: ToolDefinition[]`) |
| `src/mcp.ts:566-590` | COMMON_TOOL_POLICY prose injected into every tool description |
| `src/mcp.ts:641-700` | `addExecuteNextStepHints`, `addCaptureNextStepHints` (Phase 1) |
| `src/mcp.ts:747-840` | `addResolveMissGuidance` (Phase 1) |
| `src/cli.ts:1060+` | CLI's parallel `next_action` shape (reference, not target) |
| `docs/mcp-vs-cli-ux-audit.md` | Audit of MCP vs CLI UX gaps |
| `docs/mcp-ux-fix-plan.md` | 4-phase fix plan (Phase 1 shipped) |
| `scripts/verify-mcp-workflow-guide.sh` | Falsifier — every tool here must appear in src/mcp.ts |
