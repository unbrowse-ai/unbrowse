/**
 * The load-bearing 1:1 mapping table for v7. Every CLI subcommand
 * maps to exactly one unbrowse-native op kind and exactly one MCP tool
 * (or `null` for local-only flows).
 *
 * Mark 4:11 — "unto them that are without, all these things are done in
 * parables." The PUBLIC surface speaks unbrowse-native "ops" (verb:action
 * pairs); the aiko-side mapping from an op to its covenant verb lives OUT
 * of this bundle. `strings $(which unbrowse)` shows `breath:navigate`,
 * `eval:snap`, `build:skill` — generic ops — never covenant-mechanism
 * names.
 *
 * The `as const` annotation freezes the literal types so cross-wave
 * consumers can pattern-match on `subcommand` / `op_kind` / `mcp_tool`
 * as string literal unions — drift is a compile error, not a runtime
 * surprise.
 */
export type V7Verb = "build" | "breath" | "eval";

/**
 * The GENERIC op classes. Three abstract classes every unbrowse primitive
 * collapses onto:
 *   - `actuate`  → side-effectful runtime act (navigate/click/fill/...)
 *   - `observe`  → read-only query/capture (snap/resolve/status/...)
 *   - `build`    → declarative skill/template/value-source declaration
 * These are generic, abstract op-class names — NOT covenant-mechanism
 * strings. The per-action specificity lives in the `action` field; the
 * collision-free dispatch key is `op_kind` (`<verb>:<action>`).
 */
export type V7OpClass = "actuate" | "observe" | "build";

export interface KindMapEntry {
  /** Full CLI surface form, e.g. "breath fill". */
  readonly subcommand: string;
  /** Verb root (matches first token of `subcommand`). */
  readonly verb: V7Verb;
  /**
   * The unbrowse-native op kind — the collision-free dispatch key,
   * shaped `<verb>:<action>` (e.g. `breath:navigate`, `eval:snap`,
   * `build:skill`). Generic ops, no covenant-mechanism prefix. This is
   * the string that appears in the public bundle and API responses.
   */
  readonly op_kind: string;
  /**
   * The GENERIC op class this primitive collapses onto. One of the 3
   * abstract classes — NOT a per-action sub-kind.
   */
  readonly op_class: V7OpClass;
  /**
   * The specific action. Unique per row when combined with `op_class`
   * (the `op_kind` key folds verb+action into the collision-free string).
   */
  readonly action: string;
  /** MCP tool name that this subcommand 1:1-maps to, or `null` if local-only. */
  readonly mcp_tool: string | null;
  /** One-sentence purpose (machine-readable; surfaces in --help output). */
  readonly summary: string;
}

export const KIND_MAP = [
  // ── build ──────────────────────────────────────────────────────────
  {
    subcommand: "build skill",
    verb: "build",
    op_kind: "build:skill",
    op_class: "build",
    action: "skill",
    mcp_tool: "unbrowse_build_skill",
    summary: "Register a captured skill manifest (sequence of endpoints + selectors).",
  },
  {
    subcommand: "build template",
    verb: "build",
    op_kind: "build:template",
    op_class: "build",
    action: "template",
    mcp_tool: "unbrowse_build_template",
    summary: "Declare a reusable fill/exec template binding selectors to value pointers.",
  },
  {
    subcommand: "build value-source",
    verb: "build",
    op_kind: "build:value-source",
    op_class: "build",
    action: "value-source",
    mcp_tool: null,
    summary: "Register a vault item (one-time write to keychain/op/bw); local-only.",
  },
  {
    subcommand: "build index",
    verb: "build",
    op_kind: "build:index",
    op_class: "build",
    action: "index",
    mcp_tool: "unbrowse_build_index",
    summary: "Index a target site's surface into the route cache from captured traffic.",
  },
  {
    subcommand: "build publish",
    verb: "build",
    op_kind: "build:publish",
    op_class: "build",
    action: "publish",
    mcp_tool: "unbrowse_build_publish",
    summary: "Publish a captured endpoint/skill to the marketplace route graph.",
  },
  {
    subcommand: "build publish-bundle",
    verb: "build",
    op_kind: "build:publish_bundle",
    op_class: "build",
    action: "publish_bundle",
    mcp_tool: "unbrowse_build_publish_bundle",
    summary: "Publish a bundle of captured composite endpoints as one marketplace artifact.",
  },
  {
    subcommand: "build annotate",
    verb: "build",
    op_kind: "build:annotate",
    op_class: "build",
    action: "annotate",
    mcp_tool: "unbrowse_build_annotate",
    summary: "Attach human-readable metadata/labels to a captured endpoint or skill.",
  },
  {
    subcommand: "build review",
    verb: "build",
    op_kind: "build:review",
    op_class: "build",
    action: "review",
    mcp_tool: "unbrowse_build_review",
    summary: "Review pending review-gated endpoints before they publish to the marketplace.",
  },
  {
    subcommand: "build skill-package",
    verb: "build",
    op_kind: "build:skill_package",
    op_class: "build",
    action: "skill_package",
    mcp_tool: "unbrowse_build_skill_package",
    summary: "Package a captured skill into a distributable, installable skill bundle.",
  },
  {
    subcommand: "build setup",
    verb: "build",
    op_kind: "build:setup",
    op_class: "build",
    action: "setup",
    mcp_tool: null,
    summary: "First-run setup: configure local config, payment rail, and contribution mode; local-only.",
  },
  {
    subcommand: "build register",
    verb: "build",
    op_kind: "build:register",
    op_class: "build",
    action: "register",
    mcp_tool: null,
    summary: "Register the agent identity/wallet with the marketplace; local-only.",
  },
  {
    subcommand: "build contribute",
    verb: "build",
    op_kind: "build:contribute",
    op_class: "build",
    action: "contribute",
    mcp_tool: null,
    summary: "Set the contribution preference governing whether captures auto-publish; local-only.",
  },
  {
    subcommand: "build cleanup-stale",
    verb: "build",
    op_kind: "build:cleanup_stale",
    op_class: "build",
    action: "cleanup_stale",
    mcp_tool: "unbrowse_build_cleanup_stale",
    summary: "Prune stale/expired captured endpoints from the local route cache.",
  },

  // ── breath ─────────────────────────────────────────────────────────
  {
    subcommand: "breath go",
    verb: "breath",
    op_kind: "breath:navigate",
    op_class: "actuate",
    action: "navigate",
    mcp_tool: "unbrowse_breath_navigate",
    summary: "Navigate the current session to a URL.",
  },
  {
    subcommand: "breath fill",
    verb: "breath",
    op_kind: "breath:fill",
    op_class: "actuate",
    action: "fill",
    mcp_tool: "unbrowse_breath_fill",
    summary: "Dereference a value pointer and Input.insertText into the selector.",
  },
  {
    subcommand: "breath fill-form",
    verb: "breath",
    op_kind: "breath:fill_form",
    op_class: "actuate",
    action: "fill_form",
    mcp_tool: "unbrowse_breath_fill_form",
    summary:
      "End-to-end form fill: snap the form, enumerate candidates, populate per slot, resolve+inject every field.",
  },
  {
    subcommand: "breath type",
    verb: "breath",
    op_kind: "breath:type",
    op_class: "actuate",
    action: "type",
    mcp_tool: "unbrowse_breath_type",
    summary: "Dereference a value pointer and dispatch per-character key events.",
  },
  {
    subcommand: "breath click",
    verb: "breath",
    op_kind: "breath:click",
    op_class: "actuate",
    action: "click",
    mcp_tool: "unbrowse_breath_click",
    summary: "Compose Input.dispatchMouseEvent press+release on a selector.",
  },
  {
    subcommand: "breath press",
    verb: "breath",
    op_kind: "breath:press",
    op_class: "actuate",
    action: "press",
    mcp_tool: "unbrowse_breath_press",
    summary: "Dispatch a single Input.dispatchKeyEvent (with modifiers).",
  },
  {
    subcommand: "breath select",
    verb: "breath",
    op_kind: "breath:select",
    op_class: "actuate",
    action: "select",
    mcp_tool: "unbrowse_breath_select",
    summary: "Set a <select> element's value (pointer-or-cleartext).",
  },
  {
    subcommand: "breath scroll",
    verb: "breath",
    op_kind: "breath:scroll",
    op_class: "actuate",
    action: "scroll",
    mcp_tool: "unbrowse_breath_scroll",
    summary: "Scroll the page or a specific selector by (dx, dy) pixels.",
  },
  {
    subcommand: "breath submit",
    verb: "breath",
    op_kind: "breath:submit",
    op_class: "actuate",
    action: "submit",
    mcp_tool: "unbrowse_breath_submit",
    summary: "Submit a form (optionally targeted by selector).",
  },
  {
    subcommand: "breath execute",
    verb: "breath",
    op_kind: "breath:execute",
    op_class: "actuate",
    action: "execute",
    mcp_tool: "unbrowse_breath_execute",
    summary: "Replay a captured endpoint with pointer-resolved headers + body.",
  },
  {
    subcommand: "breath auth-capture",
    verb: "breath",
    op_kind: "breath:auth_capture",
    op_class: "actuate",
    action: "auth_capture",
    mcp_tool: "unbrowse_breath_auth_capture",
    summary: "Interactive auth flow; on completion writes credential pointer to vault.",
  },
  {
    subcommand: "breath proxy-rotate",
    verb: "breath",
    op_kind: "breath:proxy_rotate",
    op_class: "actuate",
    action: "proxy_rotate",
    mcp_tool: "unbrowse_breath_proxy_rotate",
    summary: "Rotate the residential proxy session (iproyal sticky-IP refresh).",
  },
  {
    subcommand: "breath close",
    verb: "breath",
    op_kind: "breath:close",
    op_class: "actuate",
    action: "close",
    mcp_tool: "unbrowse_breath_close",
    summary: "Close the current browse session; drain capture pipeline. DEPRECATED in v7.2.0-preview.0 — use 'breath session-park' (KV-persisted).",
  },
  {
    subcommand: "breath session-park",
    verb: "breath",
    op_kind: "breath:session_park",
    op_class: "actuate",
    action: "session_park",
    mcp_tool: "unbrowse_breath_session_park",
    summary: "Park the current browse session — same teardown as close + persists pointer-of-pointer chain to KV for later session-restore. v7.2.0-preview.0 KV path is inert; v7.3 wires real storage.",
  },
  {
    subcommand: "breath session-restore",
    verb: "breath",
    op_kind: "breath:session_restore",
    op_class: "actuate",
    action: "session_restore",
    mcp_tool: "unbrowse_breath_session_restore",
    summary: "Restore a previously parked session — KV read, wallet-signed challenge, spawn or attach to Chrome, rebuild local session record.",
  },
  {
    subcommand: "breath run",
    verb: "breath",
    op_kind: "breath:run",
    op_class: "actuate",
    action: "run",
    mcp_tool: "unbrowse_breath_run",
    summary: "Resolve an intent then execute the best-ranked endpoint in one shot.",
  },
  {
    subcommand: "breath get",
    verb: "breath",
    op_kind: "breath:get",
    op_class: "actuate",
    action: "get",
    mcp_tool: "unbrowse_breath_get",
    summary: "Fetch a resource by intent — convenience wrapper delegating to run/search.",
  },
  {
    subcommand: "breath fetch",
    verb: "breath",
    op_kind: "breath:fetch",
    op_class: "actuate",
    action: "fetch",
    mcp_tool: "unbrowse_breath_fetch",
    summary: "Replay a captured endpoint by id/url with pointer-resolved request.",
  },
  {
    subcommand: "breath capture",
    verb: "breath",
    op_kind: "breath:capture",
    op_class: "actuate",
    action: "capture",
    mcp_tool: "unbrowse_breath_capture",
    summary: "Drive a browse session to capture a site's internal API routes into the cache.",
  },
  {
    subcommand: "breath back",
    verb: "breath",
    op_kind: "breath:back",
    op_class: "actuate",
    action: "back",
    mcp_tool: "unbrowse_breath_back",
    summary: "Navigate the current session back one entry in history.",
  },
  {
    subcommand: "breath forward",
    verb: "breath",
    op_kind: "breath:forward",
    op_class: "actuate",
    action: "forward",
    mcp_tool: "unbrowse_breath_forward",
    summary: "Navigate the current session forward one entry in history.",
  },
  {
    subcommand: "breath sync",
    verb: "breath",
    op_kind: "breath:sync",
    op_class: "actuate",
    action: "sync",
    mcp_tool: "unbrowse_breath_sync",
    summary: "Sync the local session state with the live browser tab.",
  },
  {
    subcommand: "breath run-js",
    verb: "breath",
    op_kind: "breath:run_js",
    op_class: "actuate",
    action: "run_js",
    mcp_tool: "unbrowse_breath_run_js",
    summary: "Evaluate arbitrary JavaScript in the current page context (renamed from eval to avoid verb collision).",
  },
  {
    subcommand: "breath auth",
    verb: "breath",
    op_kind: "breath:auth_login",
    op_class: "actuate",
    action: "auth_login",
    mcp_tool: "unbrowse_breath_auth_login",
    summary: "Drive an interactive login flow for a target site and bind the session.",
  },
  {
    subcommand: "breath connect-chrome",
    verb: "breath",
    op_kind: "breath:connect_chrome",
    op_class: "actuate",
    action: "connect_chrome",
    mcp_tool: null,
    summary: "Attach to an already-running Chrome instance over the DevTools protocol; local-only.",
  },
  {
    subcommand: "breath serve",
    verb: "breath",
    op_kind: "breath:serve",
    op_class: "actuate",
    action: "serve",
    mcp_tool: null,
    summary: "Bounded foreground compatibility facade only — honors --no-auto-start; never auto-spawns a daemon; local-only.",
  },
  {
    subcommand: "breath mcp",
    verb: "breath",
    op_kind: "breath:mcp",
    op_class: "actuate",
    action: "mcp",
    mcp_tool: null,
    summary: "Run the stdio MCP server in-process for a host config; local-only.",
  },
  {
    subcommand: "breath dashboard",
    verb: "breath",
    op_kind: "breath:dashboard",
    op_class: "actuate",
    action: "dashboard",
    mcp_tool: null,
    summary: "Open the local dashboard UI in a browser; local-only.",
  },
  {
    subcommand: "breath upgrade",
    verb: "breath",
    op_kind: "breath:upgrade",
    op_class: "actuate",
    action: "upgrade",
    mcp_tool: null,
    summary: "Self-update the CLI binary to the latest signed release; local-only.",
  },

  // ── eval ───────────────────────────────────────────────────────────
  {
    subcommand: "eval snap",
    verb: "eval",
    op_kind: "eval:snap",
    op_class: "observe",
    action: "snap",
    mcp_tool: "unbrowse_eval_snap",
    summary: "Accessibility.getFullAXTree of the current page (the [e0] frame).",
  },
  {
    subcommand: "eval resolve",
    verb: "eval",
    op_kind: "eval:resolve",
    op_class: "observe",
    action: "resolve",
    mcp_tool: "unbrowse_eval_resolve",
    summary: "Ranked endpoint shortlist for an intent (route cache + marketplace).",
  },
  {
    subcommand: "eval status",
    verb: "eval",
    op_kind: "eval:status",
    op_class: "observe",
    action: "status",
    mcp_tool: "unbrowse_eval_status",
    summary: "Current session + server health snapshot.",
  },
  {
    subcommand: "eval version",
    verb: "eval",
    op_kind: "eval:version",
    op_class: "observe",
    action: "version",
    mcp_tool: "unbrowse_eval_version",
    summary: "CLI version + build_sha + walletPubkey + signed release manifest.",
  },
  {
    subcommand: "eval trace",
    verb: "eval",
    op_kind: "eval:trace",
    op_class: "observe",
    action: "trace",
    mcp_tool: "unbrowse_eval_trace",
    summary: "Read the stateless decision_trace for a session id.",
  },
  {
    subcommand: "eval markdown",
    verb: "eval",
    op_kind: "eval:markdown",
    op_class: "observe",
    action: "markdown",
    mcp_tool: "unbrowse_eval_markdown",
    summary: "Readable-markdown view of the current page.",
  },
  {
    subcommand: "eval screenshot",
    verb: "eval",
    op_kind: "eval:screenshot",
    op_class: "observe",
    action: "screenshot",
    mcp_tool: "unbrowse_eval_screenshot",
    summary: "Page.captureScreenshot PNG of the current page.",
  },
  {
    subcommand: "eval text",
    verb: "eval",
    op_kind: "eval:text",
    op_class: "observe",
    action: "text",
    mcp_tool: "unbrowse_eval_text",
    summary: "Stripped page text or selector-scoped innerText.",
  },
  {
    subcommand: "eval cookies",
    verb: "eval",
    op_kind: "eval:cookies",
    op_class: "observe",
    action: "cookies",
    mcp_tool: "unbrowse_eval_cookies",
    summary: "Cookie listing for a domain — names + domains + expires ONLY (no values).",
  },
  {
    subcommand: "eval stats",
    verb: "eval",
    op_kind: "eval:stats",
    op_class: "observe",
    action: "stats",
    mcp_tool: "unbrowse_eval_stats",
    summary: "Marketplace + earnings stats summary.",
  },
  {
    subcommand: "eval skills",
    verb: "eval",
    op_kind: "eval:skills",
    op_class: "observe",
    action: "skills",
    mcp_tool: "unbrowse_eval_skills",
    summary: "List captured skills.",
  },
  {
    subcommand: "eval skill",
    verb: "eval",
    op_kind: "eval:skill",
    op_class: "observe",
    action: "skill",
    mcp_tool: "unbrowse_eval_skill",
    summary: "Detail one captured skill by id.",
  },
  {
    subcommand: "eval sessions",
    verb: "eval",
    op_kind: "eval:sessions",
    op_class: "observe",
    action: "sessions",
    mcp_tool: "unbrowse_eval_sessions",
    summary: "List active browse sessions.",
  },
  {
    subcommand: "eval earnings",
    verb: "eval",
    op_kind: "eval:earnings",
    op_class: "observe",
    action: "earnings",
    mcp_tool: "unbrowse_eval_earnings",
    summary: "x402 earnings summary for the current agent.",
  },
  {
    subcommand: "eval settings",
    verb: "eval",
    op_kind: "eval:settings",
    op_class: "observe",
    action: "settings",
    mcp_tool: "unbrowse_eval_settings",
    summary: "Current local config + capture-pipeline settings.",
  },
  {
    subcommand: "eval feedback",
    verb: "eval",
    op_kind: "eval:feedback",
    op_class: "observe",
    action: "feedback",
    mcp_tool: "unbrowse_eval_feedback",
    summary: "Submit feedback on the last execute (commitment-only).",
  },
  {
    subcommand: "eval reflect",
    verb: "eval",
    op_kind: "eval:reflect",
    op_class: "observe",
    action: "reflect",
    mcp_tool: "unbrowse_eval_reflect",
    summary: "Reflect on the user-facing outcome of the current task.",
  },
  {
    subcommand: "eval auth-inventory",
    verb: "eval",
    op_kind: "eval:auth_inventory",
    op_class: "observe",
    action: "auth_inventory",
    mcp_tool: "unbrowse_eval_auth_inventory",
    summary:
      "Per-domain AST of what the user can already authenticate against — local browser cookies (metadata only), history hostnames, bookmarks. Bias the resolve ranker toward logged-in domains.",
  },
  {
    subcommand: "eval spec",
    verb: "eval",
    op_kind: "eval:spec_discover",
    op_class: "observe",
    action: "spec_discover",
    mcp_tool: "unbrowse_eval_spec_discover",
    summary:
      "Probe spec-publishing endpoints (openapi/swagger/sitemap/robots/graphql) for a target site BEFORE the browse-capture-rank dance. If the site publishes its surface, that IS the ground-truth AST — skip the capture.",
  },
  {
    subcommand: "eval explain",
    verb: "eval",
    op_kind: "eval:explain",
    op_class: "observe",
    action: "explain",
    mcp_tool: "unbrowse_eval_explain",
    summary: "Explain how a given intent would resolve and execute, without acting.",
  },
  {
    subcommand: "eval search",
    verb: "eval",
    op_kind: "eval:search",
    op_class: "observe",
    action: "search",
    mcp_tool: "unbrowse_eval_search",
    summary: "Search the marketplace/route graph for endpoints matching a query.",
  },
  {
    subcommand: "eval research",
    verb: "eval",
    op_kind: "eval:research",
    op_class: "observe",
    action: "research",
    mcp_tool: "unbrowse_eval_research",
    summary: "Research a question: the full resolve->read->ground walk (search -> extract* -> synthesized cited answer). The deep end of the same pipeline `search` and `extract` expose.",
  },
  {
    subcommand: "eval extract",
    verb: "eval",
    op_kind: "eval:extract",
    op_class: "observe",
    action: "extract",
    mcp_tool: "unbrowse_eval_extract",
    summary: "Extract clean content from one or more URLs (the READ step of research, exposed in batch; a URL hole -> its markdown value). Tavily /extract parity.",
  },
  {
    subcommand: "eval map",
    verb: "eval",
    op_kind: "eval:map",
    op_class: "observe",
    action: "map",
    mcp_tool: "unbrowse_eval_map",
    summary: "Map a URL's outgoing links (a URL hole -> its POINTERS; the pointers face of the read that `extract` resolves to a value). Tavily /map parity.",
  },
  {
    subcommand: "eval crawl",
    verb: "eval",
    op_kind: "eval:crawl",
    op_class: "observe",
    action: "crawl",
    mcp_tool: "unbrowse_eval_crawl",
    summary: "Crawl a seed URL one hop (map ∘ extract*, same-domain, page-capped): read the seed + its same-site links. Tavily /crawl parity.",
  },
  {
    subcommand: "eval inspect",
    verb: "eval",
    op_kind: "eval:inspect",
    op_class: "observe",
    action: "inspect",
    mcp_tool: "unbrowse_eval_inspect",
    summary: "Inspect a captured endpoint's full request/response shape and metadata.",
  },
  {
    subcommand: "eval account",
    verb: "eval",
    op_kind: "eval:account",
    op_class: "observe",
    action: "account",
    mcp_tool: null,
    summary: "Show the current agent account, wallet, and credit balance; local-only.",
  },
  {
    subcommand: "eval config",
    verb: "eval",
    op_kind: "eval:config",
    op_class: "observe",
    action: "config",
    mcp_tool: null,
    summary: "Read or write local config keys; local-only.",
  },
] as const satisfies readonly KindMapEntry[];

export type V7Subcommand = (typeof KIND_MAP)[number]["subcommand"];
export type V7OpKind = (typeof KIND_MAP)[number]["op_kind"];
export type V7McpTool = NonNullable<(typeof KIND_MAP)[number]["mcp_tool"]>;

/** Lookup by `"<verb> <sub>"`. Throws if unknown — guarantees 1:1 dispatch. */
export function lookupKindMap(verb: string, sub: string): KindMapEntry | undefined {
  const key = `${verb} ${sub}`;
  return KIND_MAP.find((e) => e.subcommand === key);
}

// Flat legacy command → verb, DERIVED from KIND_MAP (the second token of every
// `subcommand`). Single source of truth so the allowlist cannot drift behind the
// dispatch the way the old hand-maintained KNOWN_COMMANDS did (the misroute that
// sent `settings`/`fetch`/`search`/`skills`/`spec`/`explain` into the one-hole
// `get` fallback). Genuine collisions (the same action word under two verbs) are
// resolved by the override below — the only one today is `skill`.
const FLAT_VERB_OVERRIDES: Record<string, V7Verb> = {
  // `unbrowse skill <id>` is the eval READ (get a SkillManifest); `build skill`
  // is the create form. The flat alias resolves to the read.
  skill: "eval",
};
let _flatVerbMap: Map<string, V7Verb> | null = null;
function flatVerbMap(): Map<string, V7Verb> {
  if (_flatVerbMap) return _flatVerbMap;
  const m = new Map<string, V7Verb>();
  for (const e of KIND_MAP) {
    const parts = e.subcommand.split(" ");
    if (parts.length !== 2) continue;
    if (!m.has(parts[1])) m.set(parts[1], e.verb); // first wins; overrides fix collisions
  }
  for (const [k, v] of Object.entries(FLAT_VERB_OVERRIDES)) m.set(k, v);
  return (_flatVerbMap = m);
}

/**
 * The verb a flat legacy command routes to (build/breath/eval), or null when the
 * token is NOT a known flat command — i.e. a genuine natural-language intent that
 * should fall through to the one-hole `get` path. Multi-word input and the verbs
 * themselves return null (verbs are handled by the verb dispatch, not here).
 */
export function flatCommandVerb(name: string): V7Verb | null {
  if (!name || name.includes(" ")) return null;
  if (name === "build" || name === "breath" || name === "eval") return null;
  return flatVerbMap().get(name) ?? null;
}

/** Compile-time invariant: every op_kind is unique. */
type _AssertUnique = AssertNoDuplicate<(typeof KIND_MAP)[number]["op_kind"]>;
type AssertNoDuplicate<T extends string, Seen extends string = never> =
  T extends infer U
    ? U extends string
      ? U extends Seen ? never : AssertNoDuplicate<Exclude<T, U>, Seen | U>
      : never
    : true;
// Silence unused-type-alias lint by referencing _AssertUnique in a type-level no-op.
export type _KindMapInvariantAttested = _AssertUnique extends never ? "duplicate" : "ok";
