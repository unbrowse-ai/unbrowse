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
    mcp_tool: "unbrowse_publish",
    summary: "Register a captured skill manifest (sequence of endpoints + selectors).",
  },
  {
    subcommand: "build template",
    verb: "build",
    op_kind: "build:template",
    op_class: "build",
    action: "template",
    mcp_tool: "unbrowse_annotate",
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

  // ── breath ─────────────────────────────────────────────────────────
  {
    subcommand: "breath go",
    verb: "breath",
    op_kind: "breath:navigate",
    op_class: "actuate",
    action: "navigate",
    mcp_tool: "unbrowse_go",
    summary: "Navigate the current session to a URL.",
  },
  {
    subcommand: "breath fill",
    verb: "breath",
    op_kind: "breath:fill",
    op_class: "actuate",
    action: "fill",
    mcp_tool: "unbrowse_fill",
    summary: "Dereference a value pointer and Input.insertText into the selector.",
  },
  {
    subcommand: "breath fill-form",
    verb: "breath",
    op_kind: "breath:fill_form",
    op_class: "actuate",
    action: "fill_form",
    mcp_tool: "unbrowse_fill_form", // NEW MCP tool — wire in later wave.
    summary:
      "End-to-end form fill: snap the form, enumerate candidates, populate per slot, resolve+inject every field.",
  },
  {
    subcommand: "breath type",
    verb: "breath",
    op_kind: "breath:type",
    op_class: "actuate",
    action: "type",
    mcp_tool: "unbrowse_type",
    summary: "Dereference a value pointer and dispatch per-character key events.",
  },
  {
    subcommand: "breath click",
    verb: "breath",
    op_kind: "breath:click",
    op_class: "actuate",
    action: "click",
    mcp_tool: "unbrowse_click",
    summary: "Compose Input.dispatchMouseEvent press+release on a selector.",
  },
  {
    subcommand: "breath press",
    verb: "breath",
    op_kind: "breath:press",
    op_class: "actuate",
    action: "press",
    mcp_tool: "unbrowse_press",
    summary: "Dispatch a single Input.dispatchKeyEvent (with modifiers).",
  },
  {
    subcommand: "breath select",
    verb: "breath",
    op_kind: "breath:select",
    op_class: "actuate",
    action: "select",
    mcp_tool: "unbrowse_select",
    summary: "Set a <select> element's value (pointer-or-cleartext).",
  },
  {
    subcommand: "breath scroll",
    verb: "breath",
    op_kind: "breath:scroll",
    op_class: "actuate",
    action: "scroll",
    mcp_tool: "unbrowse_scroll",
    summary: "Scroll the page or a specific selector by (dx, dy) pixels.",
  },
  {
    subcommand: "breath submit",
    verb: "breath",
    op_kind: "breath:submit",
    op_class: "actuate",
    action: "submit",
    mcp_tool: "unbrowse_submit",
    summary: "Submit a form (optionally targeted by selector).",
  },
  {
    subcommand: "breath execute",
    verb: "breath",
    op_kind: "breath:execute",
    op_class: "actuate",
    action: "execute",
    mcp_tool: "unbrowse_execute",
    summary: "Replay a captured endpoint with pointer-resolved headers + body.",
  },
  {
    subcommand: "breath auth-capture",
    verb: "breath",
    op_kind: "breath:auth_capture",
    op_class: "actuate",
    action: "auth_capture",
    mcp_tool: "unbrowse_auth_capture",
    summary: "Interactive auth flow; on completion writes credential pointer to vault.",
  },
  {
    subcommand: "breath proxy-rotate",
    verb: "breath",
    op_kind: "breath:proxy_rotate",
    op_class: "actuate",
    action: "proxy_rotate",
    mcp_tool: "unbrowse_proxy_rotate", // NEW MCP tool — wire in later wave.
    summary: "Rotate the residential proxy session (iproyal sticky-IP refresh).",
  },
  {
    subcommand: "breath close",
    verb: "breath",
    op_kind: "breath:close",
    op_class: "actuate",
    action: "close",
    mcp_tool: "unbrowse_close",
    summary: "Close the current browse session; drain capture pipeline. DEPRECATED in v7.2.0-preview.0 — use 'breath session-park' (KV-persisted).",
  },
  {
    subcommand: "breath session-park",
    verb: "breath",
    op_kind: "breath:session_park",
    op_class: "actuate",
    action: "session_park",
    mcp_tool: "unbrowse_session_park", // NEW MCP tool — wire in later wave.
    summary: "Park the current browse session — same teardown as close + persists pointer-of-pointer chain to KV for later session-restore. v7.2.0-preview.0 KV path is inert; v7.3 wires real storage.",
  },
  {
    subcommand: "breath session-restore",
    verb: "breath",
    op_kind: "breath:session_restore",
    op_class: "actuate",
    action: "session_restore",
    mcp_tool: "unbrowse_session_restore", // NEW MCP tool — wire in later wave.
    summary: "Restore a previously parked session — KV read, wallet-signed challenge, spawn or attach to Chrome, rebuild local session record.",
  },

  // ── eval ───────────────────────────────────────────────────────────
  {
    subcommand: "eval snap",
    verb: "eval",
    op_kind: "eval:snap",
    op_class: "observe",
    action: "snap",
    mcp_tool: "unbrowse_snap",
    summary: "Accessibility.getFullAXTree of the current page (the [e0] frame).",
  },
  {
    subcommand: "eval resolve",
    verb: "eval",
    op_kind: "eval:resolve",
    op_class: "observe",
    action: "resolve",
    mcp_tool: "unbrowse_resolve",
    summary: "Ranked endpoint shortlist for an intent (route cache + marketplace).",
  },
  {
    subcommand: "eval status",
    verb: "eval",
    op_kind: "eval:status",
    op_class: "observe",
    action: "status",
    mcp_tool: "unbrowse_health",
    summary: "Current session + server health snapshot.",
  },
  {
    subcommand: "eval version",
    verb: "eval",
    op_kind: "eval:version",
    op_class: "observe",
    action: "version",
    mcp_tool: "unbrowse_version", // NEW MCP tool — wire in later wave.
    summary: "CLI version + build_sha + walletPubkey + signed release manifest.",
  },
  {
    subcommand: "eval trace",
    verb: "eval",
    op_kind: "eval:trace",
    op_class: "observe",
    action: "trace",
    mcp_tool: "unbrowse_trace",
    summary: "Read the stateless decision_trace for a session id.",
  },
  {
    subcommand: "eval markdown",
    verb: "eval",
    op_kind: "eval:markdown",
    op_class: "observe",
    action: "markdown",
    mcp_tool: "unbrowse_markdown",
    summary: "Readable-markdown view of the current page.",
  },
  {
    subcommand: "eval screenshot",
    verb: "eval",
    op_kind: "eval:screenshot",
    op_class: "observe",
    action: "screenshot",
    mcp_tool: "unbrowse_screenshot",
    summary: "Page.captureScreenshot PNG of the current page.",
  },
  {
    subcommand: "eval text",
    verb: "eval",
    op_kind: "eval:text",
    op_class: "observe",
    action: "text",
    mcp_tool: "unbrowse_text",
    summary: "Stripped page text or selector-scoped innerText.",
  },
  {
    subcommand: "eval cookies",
    verb: "eval",
    op_kind: "eval:cookies",
    op_class: "observe",
    action: "cookies",
    mcp_tool: "unbrowse_cookies",
    summary: "Cookie listing for a domain — names + domains + expires ONLY (no values).",
  },
  {
    subcommand: "eval stats",
    verb: "eval",
    op_kind: "eval:stats",
    op_class: "observe",
    action: "stats",
    mcp_tool: "unbrowse_stats",
    summary: "Marketplace + earnings stats summary.",
  },
  {
    subcommand: "eval skills",
    verb: "eval",
    op_kind: "eval:skills",
    op_class: "observe",
    action: "skills",
    mcp_tool: "unbrowse_skills",
    summary: "List captured skills.",
  },
  {
    subcommand: "eval skill",
    verb: "eval",
    op_kind: "eval:skill",
    op_class: "observe",
    action: "skill",
    mcp_tool: "unbrowse_skill",
    summary: "Detail one captured skill by id.",
  },
  {
    subcommand: "eval sessions",
    verb: "eval",
    op_kind: "eval:sessions",
    op_class: "observe",
    action: "sessions",
    mcp_tool: "unbrowse_sessions",
    summary: "List active browse sessions.",
  },
  {
    subcommand: "eval earnings",
    verb: "eval",
    op_kind: "eval:earnings",
    op_class: "observe",
    action: "earnings",
    mcp_tool: "unbrowse_earnings",
    summary: "x402 earnings summary for the current agent.",
  },
  {
    subcommand: "eval settings",
    verb: "eval",
    op_kind: "eval:settings",
    op_class: "observe",
    action: "settings",
    mcp_tool: "unbrowse_settings",
    summary: "Current local config + capture-pipeline settings.",
  },
  {
    subcommand: "eval feedback",
    verb: "eval",
    op_kind: "eval:feedback",
    op_class: "observe",
    action: "feedback",
    mcp_tool: "unbrowse_feedback",
    summary: "Submit feedback on the last execute (commitment-only).",
  },
  {
    subcommand: "eval reflect",
    verb: "eval",
    op_kind: "eval:reflect",
    op_class: "observe",
    action: "reflect",
    mcp_tool: "unbrowse_reflect",
    summary: "Reflect on the user-facing outcome of the current task.",
  },
  {
    subcommand: "eval auth-inventory",
    verb: "eval",
    op_kind: "eval:auth_inventory",
    op_class: "observe",
    action: "auth_inventory",
    mcp_tool: "unbrowse_auth_inventory",
    summary:
      "Per-domain AST of what the user can already authenticate against — local browser cookies (metadata only), history hostnames, bookmarks. Bias the resolve ranker toward logged-in domains.",
  },
  {
    subcommand: "eval spec",
    verb: "eval",
    op_kind: "eval:spec_discover",
    op_class: "observe",
    action: "spec_discover",
    mcp_tool: "unbrowse_spec",
    summary:
      "Probe spec-publishing endpoints (openapi/swagger/sitemap/robots/graphql) for a target site BEFORE the browse-capture-rank dance. If the site publishes its surface, that IS the ground-truth AST — skip the capture.",
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
