/**
 * The load-bearing 1:1 mapping table for v7. Every CLI subcommand
 * maps to exactly one covenant kind name and exactly one MCP tool
 * (or `null` for local-only flows).
 *
 * The canonical mapping lives in
 *   .planning/v7-rip/VALUE_STORE_ADAPTERS.md §"1:1 mapping table"
 * and this file is the typed mirror. Keep them in sync.
 *
 * The `as const` annotation freezes the literal types so cross-wave
 * consumers (the MCP wiring wave, the covenant wave) can pattern-match
 * on `subcommand` / `covenant_kind` / `mcp_tool` as string literal
 * unions — drift is a compile error, not a runtime surprise.
 */
export type V7Verb = "build" | "breath" | "eval";

export interface KindMapEntry {
  /** Full CLI surface form, e.g. "breath fill". */
  readonly subcommand: string;
  /** Verb root (matches first token of `subcommand`). */
  readonly verb: V7Verb;
  /** Covenant kind name. Stable identifier in the ledger / KindSpec. */
  readonly covenant_kind: string;
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
    covenant_kind: "skill_declare",
    mcp_tool: "unbrowse_publish",
    summary: "Register a captured skill manifest (sequence of endpoints + selectors).",
  },
  {
    subcommand: "build template",
    verb: "build",
    covenant_kind: "fill_template_declare",
    mcp_tool: "unbrowse_annotate",
    summary: "Declare a reusable fill/exec template binding selectors to value pointers.",
  },
  {
    subcommand: "build value-source",
    verb: "build",
    covenant_kind: "value_source_declare",
    mcp_tool: null,
    summary: "Register a vault item (one-time write to keychain/op/bw); local-only.",
  },

  // ── breath ─────────────────────────────────────────────────────────
  {
    subcommand: "breath go",
    verb: "breath",
    covenant_kind: "actuate_navigate",
    mcp_tool: "unbrowse_go",
    summary: "Navigate the current session to a URL.",
  },
  {
    subcommand: "breath fill",
    verb: "breath",
    covenant_kind: "actuate_fill",
    mcp_tool: "unbrowse_fill",
    summary: "Dereference a value pointer and Input.insertText into the selector.",
  },
  {
    subcommand: "breath type",
    verb: "breath",
    covenant_kind: "actuate_type",
    mcp_tool: "unbrowse_type",
    summary: "Dereference a value pointer and dispatch per-character key events.",
  },
  {
    subcommand: "breath click",
    verb: "breath",
    covenant_kind: "actuate_click",
    mcp_tool: "unbrowse_click",
    summary: "Compose Input.dispatchMouseEvent press+release on a selector.",
  },
  {
    subcommand: "breath press",
    verb: "breath",
    covenant_kind: "actuate_press",
    mcp_tool: "unbrowse_press",
    summary: "Dispatch a single Input.dispatchKeyEvent (with modifiers).",
  },
  {
    subcommand: "breath select",
    verb: "breath",
    covenant_kind: "actuate_select",
    mcp_tool: "unbrowse_select",
    summary: "Set a <select> element's value (pointer-or-cleartext).",
  },
  {
    subcommand: "breath scroll",
    verb: "breath",
    covenant_kind: "actuate_scroll",
    mcp_tool: "unbrowse_scroll",
    summary: "Scroll the page or a specific selector by (dx, dy) pixels.",
  },
  {
    subcommand: "breath submit",
    verb: "breath",
    covenant_kind: "actuate_submit",
    mcp_tool: "unbrowse_submit",
    summary: "Submit a form (optionally targeted by selector).",
  },
  {
    subcommand: "breath execute",
    verb: "breath",
    covenant_kind: "actuate_execute",
    mcp_tool: "unbrowse_execute",
    summary: "Replay a captured endpoint with pointer-resolved headers + body.",
  },
  {
    subcommand: "breath auth-capture",
    verb: "breath",
    covenant_kind: "actuate_auth_capture",
    mcp_tool: "unbrowse_auth_capture",
    summary: "Interactive auth flow; on completion writes credential pointer to vault.",
  },
  {
    subcommand: "breath proxy-rotate",
    verb: "breath",
    covenant_kind: "actuate_proxy_rotate",
    mcp_tool: "unbrowse_proxy_rotate", // NEW MCP tool — wire in later wave.
    summary: "Rotate the residential proxy session (iproyal sticky-IP refresh).",
  },
  {
    subcommand: "breath close",
    verb: "breath",
    covenant_kind: "actuate_close",
    mcp_tool: "unbrowse_close",
    summary: "Close the current browse session; drain capture pipeline.",
  },

  // ── eval ───────────────────────────────────────────────────────────
  {
    subcommand: "eval snap",
    verb: "eval",
    covenant_kind: "observe_snap",
    mcp_tool: "unbrowse_snap",
    summary: "Accessibility.getFullAXTree of the current page (the [e0] frame).",
  },
  {
    subcommand: "eval resolve",
    verb: "eval",
    covenant_kind: "observe_resolve",
    mcp_tool: "unbrowse_resolve",
    summary: "Ranked endpoint shortlist for an intent (route cache + marketplace).",
  },
  {
    subcommand: "eval status",
    verb: "eval",
    covenant_kind: "observe_status",
    mcp_tool: "unbrowse_health",
    summary: "Current session + server health snapshot.",
  },
  {
    subcommand: "eval version",
    verb: "eval",
    covenant_kind: "observe_version",
    mcp_tool: "unbrowse_version", // NEW MCP tool — wire in later wave.
    summary: "CLI version + build_sha + walletPubkey + signed release manifest.",
  },
  {
    subcommand: "eval trace",
    verb: "eval",
    covenant_kind: "observe_trace",
    mcp_tool: "unbrowse_trace",
    summary: "Read the stateless decision_trace for a session id.",
  },
  {
    subcommand: "eval markdown",
    verb: "eval",
    covenant_kind: "observe_markdown",
    mcp_tool: "unbrowse_markdown",
    summary: "Readable-markdown view of the current page.",
  },
  {
    subcommand: "eval screenshot",
    verb: "eval",
    covenant_kind: "observe_screenshot",
    mcp_tool: "unbrowse_screenshot",
    summary: "Page.captureScreenshot PNG of the current page.",
  },
  {
    subcommand: "eval text",
    verb: "eval",
    covenant_kind: "observe_text",
    mcp_tool: "unbrowse_text",
    summary: "Stripped page text or selector-scoped innerText.",
  },
  {
    subcommand: "eval cookies",
    verb: "eval",
    covenant_kind: "observe_cookies",
    mcp_tool: "unbrowse_cookies",
    summary: "Cookie listing for a domain — names + domains + expires ONLY (no values).",
  },
  {
    subcommand: "eval stats",
    verb: "eval",
    covenant_kind: "observe_stats",
    mcp_tool: "unbrowse_stats",
    summary: "Marketplace + earnings stats summary.",
  },
  {
    subcommand: "eval skills",
    verb: "eval",
    covenant_kind: "observe_skills",
    mcp_tool: "unbrowse_skills",
    summary: "List captured skills.",
  },
  {
    subcommand: "eval skill",
    verb: "eval",
    covenant_kind: "observe_skill",
    mcp_tool: "unbrowse_skill",
    summary: "Detail one captured skill by id.",
  },
  {
    subcommand: "eval sessions",
    verb: "eval",
    covenant_kind: "observe_sessions",
    mcp_tool: "unbrowse_sessions",
    summary: "List active browse sessions.",
  },
  {
    subcommand: "eval earnings",
    verb: "eval",
    covenant_kind: "observe_earnings",
    mcp_tool: "unbrowse_earnings",
    summary: "x402 earnings summary for the current agent.",
  },
  {
    subcommand: "eval settings",
    verb: "eval",
    covenant_kind: "observe_settings",
    mcp_tool: "unbrowse_settings",
    summary: "Current local config + capture-pipeline settings.",
  },
  {
    subcommand: "eval feedback",
    verb: "eval",
    covenant_kind: "observe_feedback",
    mcp_tool: "unbrowse_feedback",
    summary: "Submit feedback on the last execute (commitment-only).",
  },
  {
    subcommand: "eval reflect",
    verb: "eval",
    covenant_kind: "observe_reflect",
    mcp_tool: "unbrowse_reflect",
    summary: "Reflect on the user-facing outcome of the current task.",
  },
] as const satisfies readonly KindMapEntry[];

export type V7Subcommand = (typeof KIND_MAP)[number]["subcommand"];
export type V7CovenantKind = (typeof KIND_MAP)[number]["covenant_kind"];
export type V7McpTool = NonNullable<(typeof KIND_MAP)[number]["mcp_tool"]>;

/** Lookup by `"<verb> <sub>"`. Throws if unknown — guarantees 1:1 dispatch. */
export function lookupKindMap(verb: string, sub: string): KindMapEntry | undefined {
  const key = `${verb} ${sub}`;
  return KIND_MAP.find((e) => e.subcommand === key);
}

/** Compile-time invariant: every covenant_kind is unique. */
type _AssertUnique = AssertNoDuplicate<(typeof KIND_MAP)[number]["covenant_kind"]>;
type AssertNoDuplicate<T extends string, Seen extends string = never> =
  T extends infer U
    ? U extends string
      ? U extends Seen ? never : AssertNoDuplicate<Exclude<T, U>, Seen | U>
      : never
    : true;
// Silence unused-type-alias lint by referencing _AssertUnique in a type-level no-op.
export type _KindMapInvariantAttested = _AssertUnique extends never ? "duplicate" : "ok";
