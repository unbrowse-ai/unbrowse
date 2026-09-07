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
  /**
   * Optional per-command CLI arg surface for --help. When present the
   * router derives per-command help from THIS row instead of the generic
   * fallback, so the kind-map stays the single source of truth for what
   * an agent can type. List only command-specific flags; the router
   * appends the global --help/--json/--pretty set.
   */
  readonly cli?: {
    readonly usage: string;
    readonly positional?: ReadonlyArray<{ name: string; description: string; required?: boolean }>;
    readonly flags?: ReadonlyArray<{ name: string; description: string; value_expected?: boolean }>;
  };
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
    cli: {
      usage: "unbrowse build skill <skill-id> [--domain <domain>] [--public] [--dry-run]",
      positional: [
        { name: "<skill-id>", description: "Local skill id from `unbrowse skills`.", required: true },
      ],
      flags: [
        { name: "--domain", description: "Override the skill's bound domain.", value_expected: true },
        { name: "--public", description: "Publish to the global marketplace (default: account-scoped).", value_expected: false },
        { name: "--dry-run", description: "Validate the manifest without publishing.", value_expected: false },
      ],
    },
    summary: "Register a captured skill manifest (sequence of endpoints + selectors).",
  },
  {
    subcommand: "build template",
    verb: "build",
    op_kind: "build:template",
    op_class: "build",
    action: "template",
    mcp_tool: "unbrowse_build_template",
    cli: {
      usage: "unbrowse template <name> [--field <selector>=<pointer>] [--from-skill <id>]",
      positional: [
        { name: "<name>", description: "Template identifier (kebab-case).", required: true },
      ],
      flags: [
        { name: "--field", description: "Repeatable `<selector>=<pointer>` binding.", value_expected: true },
        { name: "--from-skill", description: "Bootstrap fields from an existing skill id.", value_expected: true },
      ],
    },
    summary: "Declare a reusable fill/exec template binding selectors to value pointers.",
  },
  {
    subcommand: "build value-source",
    verb: "build",
    op_kind: "build:value-source",
    op_class: "build",
    action: "value-source",
    mcp_tool: null,
    cli: {
      usage: "unbrowse value-source <pointer> [--from-stdin] [--prompt] [--touch-id]",
      positional: [
        { name: "<pointer>", description: "Target pointer URI to write to, e.g. `keychain://com.unbrowse/lewis` (must be a `<scheme>://...` URI).", required: true },
      ],
      flags: [
        { name: "--from-stdin", description: "Read the cleartext value from stdin (no echo).", value_expected: false },
        { name: "--prompt", description: "Interactively prompt for the value (no echo).", value_expected: false },
        { name: "--touch-id", description: "For keychain:// — require user-presence ACL on read.", value_expected: false },
      ],
    },
    summary: "Register a vault item (one-time write to keychain/op/bw); local-only.",
  },
  {
    subcommand: "build index",
    verb: "build",
    op_kind: "build:index",
    op_class: "build",
    action: "index",
    mcp_tool: "unbrowse_build_index",
    cli: {
      usage: "unbrowse index --skill <id>",
      flags: [
        { name: "--skill", description: "Skill id to index into the route cache (required).", value_expected: true },
      ],
    },
    summary: "Index a target site's surface into the route cache from captured traffic.",
  },
  {
    subcommand: "build publish",
    verb: "build",
    op_kind: "build:publish",
    op_class: "build",
    action: "publish",
    mcp_tool: "unbrowse_build_publish",
    cli: {
      usage: "unbrowse publish --skill <id> [--endpoints <json>] [--confirm-publish]",
      flags: [
        { name: "--skill", description: "Skill id to publish (required).", value_expected: true },
        { name: "--endpoints", description: "JSON array of endpoint descriptions; supplying it runs phase 2 (merge + publish), omitting it runs phase 1 (returns endpoints needing descriptions).", value_expected: true },
        { name: "--confirm-publish", description: "Confirm the publish after reviewing the returned endpoint set.", value_expected: false },
      ],
    },
    summary: "Publish a captured endpoint/skill to the marketplace route graph.",
  },
  {
    subcommand: "build publish-bundle",
    verb: "build",
    op_kind: "build:publish_bundle",
    op_class: "build",
    action: "publish_bundle",
    mcp_tool: "unbrowse_build_publish_bundle",
    cli: {
      usage: "unbrowse publish-bundle --preset <path> [--site-url <url>] [--hosts <a,b,c>]",
      flags: [
        { name: "--preset", description: "Path to the bundle preset file (required).", value_expected: true },
        { name: "--site-url", description: "Site URL context for the bundle publish.", value_expected: true },
        { name: "--hosts", description: "Comma-separated host list to scope the bundle publish.", value_expected: true },
      ],
    },
    summary: "Publish a bundle of captured composite endpoints as one marketplace artifact.",
  },
  {
    subcommand: "build annotate",
    verb: "build",
    op_kind: "build:annotate",
    op_class: "build",
    action: "annotate",
    mcp_tool: "unbrowse_build_annotate",
    cli: {
      usage: 'unbrowse annotate --skill <id> --endpoint <id> [--text "<note>"] [--constraint <param>:<rule>:<message>]',
      flags: [
        { name: "--skill", description: "Skill id owning the endpoint (required).", value_expected: true },
        { name: "--endpoint", description: "Endpoint id to annotate (required).", value_expected: true },
        { name: "--text", description: "Free-text annotation to attach; --text or --constraint is required.", value_expected: true },
        { name: "--constraint", description: "Parameter constraint as `<param>:<rule>:<message>`; --text or --constraint is required.", value_expected: true },
      ],
    },
    summary: "Attach human-readable metadata/labels to a captured endpoint or skill.",
  },
  {
    subcommand: "build review",
    verb: "build",
    op_kind: "build:review",
    op_class: "build",
    action: "review",
    mcp_tool: "unbrowse_build_review",
    cli: {
      usage: "unbrowse review --skill <id> --endpoints '<json-array>'",
      flags: [
        { name: "--skill", description: "Skill id under review (required).", value_expected: true },
        { name: "--endpoints", description: "Required non-empty JSON array of {endpoint_id, description?, action_kind?, resource_kind?, parameter_reviews?, response_reviews?}.", value_expected: true },
      ],
    },
    summary: "Review pending review-gated endpoints before they publish to the marketplace.",
  },
  {
    subcommand: "build skill-package",
    verb: "build",
    op_kind: "build:skill_package",
    op_class: "build",
    action: "skill_package",
    mcp_tool: "unbrowse_build_skill_package",
    cli: {
      usage: "unbrowse skill-package <skill-id> [--out <dir>] [--expose]",
      positional: [
        { name: "<skill-id>", description: "Captured skill id to package; alternatively supply via --skill or --id.", required: true },
      ],
      flags: [
        { name: "--skill", description: "Alternate to the positional skill id.", value_expected: true },
        { name: "--id", description: "Alternate to the positional skill id.", value_expected: true },
        { name: "--out", description: "Output directory for the generated package (default ./unbrowse-ai-<domain>).", value_expected: true },
        { name: "--expose", description: "Mark the package publicly exposed (installable via `npx skills add`).", value_expected: false },
      ],
    },
    summary: "Package a captured skill into a distributable, installable skill bundle.",
  },
  {
    subcommand: "build setup",
    verb: "build",
    op_kind: "build:setup",
    op_class: "build",
    action: "setup",
    mcp_tool: null,
    cli: {
      usage: "unbrowse setup [--opencode <global|project|off>] [--skip-browser] [--no-skill] [--no-start]",
      flags: [
        { name: "--opencode", description: "Install scope for the Open Code command: global|project|off (bare flag = auto).", value_expected: true },
        { name: "--skip-browser", description: "Skip automatic browser-engine installation.", value_expected: false },
        { name: "--no-skill", description: "Skip installing the unbrowse Agent Skill (SKILL.md).", value_expected: false },
        { name: "--no-start", description: "Skip local runtime warm-up; report the server as not started.", value_expected: false },
        { name: "--mcp", description: "Deprecated no-op (aliases --no-claude-register, --no-mcp-host-register); MCP host autoinstall was removed from setup.", value_expected: false },
      ],
    },
    summary: "First-run setup: configure local config, payment rail, and contribution mode; local-only.",
  },
  {
    subcommand: "build register",
    verb: "build",
    op_kind: "build:register",
    op_class: "build",
    action: "register",
    mcp_tool: null,
    cli: {
      usage: "unbrowse register [--email <address>] [--reset] [--no-prompt]",
      flags: [
        { name: "--email", description: "Email to send a magic link to; mints and saves a new API key.", value_expected: true },
        { name: "--reset", description: "Clear the local API key and re-register from scratch (aliases: --force, --reset-key).", value_expected: false },
        { name: "--no-prompt", description: "Skip the interactive email prompt when --email is not given.", value_expected: false },
      ],
    },
    summary: "Register the agent identity/wallet with the marketplace; local-only.",
  },
  {
    subcommand: "build contribute",
    verb: "build",
    op_kind: "build:contribute",
    op_class: "build",
    action: "contribute",
    mcp_tool: null,
    cli: {
      usage: "unbrowse contribute",
    },
    summary: "Set the contribution preference governing whether captures auto-publish; local-only.",
  },
  {
    subcommand: "build cleanup-stale",
    verb: "build",
    op_kind: "build:cleanup_stale",
    op_class: "build",
    action: "cleanup_stale",
    mcp_tool: "unbrowse_build_cleanup_stale",
    cli: {
      usage: "unbrowse cleanup-stale [--skill <id>] [--domain <domain>] [--limit <n>]",
      flags: [
        { name: "--skill", description: "Restrict cleanup to one skill's endpoints.", value_expected: true },
        { name: "--domain", description: "Restrict cleanup to one domain.", value_expected: true },
        { name: "--limit", description: "Maximum number of stale endpoints to prune.", value_expected: true },
      ],
    },
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
    cli: {
      usage: "unbrowse go <url> [--session <id>] [--timeout <ms>]",
      positional: [{ name: "<url>", description: "URL to open in a browse session.", required: true }],
      flags: [
        { name: "--session", description: "Reuse an existing session id through a multi-step flow.", value_expected: true },
        { name: "--timeout", description: "Wall-clock bound in ms (default 30000).", value_expected: true },
      ],
    },
    summary: "Navigate the current session to a URL.",
  },
  {
    subcommand: "breath fill",
    verb: "breath",
    op_kind: "breath:fill",
    op_class: "actuate",
    action: "fill",
    mcp_tool: "unbrowse_breath_fill",
    cli: {
      usage: "unbrowse fill <selector> <pointer> [--session <id>] [--arg key=value] [--argScope <json>]",
      positional: [
        { name: "<selector>", description: "CSS selector (`#password`) or an `eN`/`@eN`/`[eN]` accessibility ref from snap.", required: true },
        { name: "<pointer>", description: "Value pointer (op:// | keychain:// | bw:// | arg:// | cleartext).", required: true },
      ],
      flags: [
        { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
        { name: "--arg", description: "Single arg-scope key (key=value form).", value_expected: true },
        { name: "--argScope", description: "Full arg-scope object as JSON.", value_expected: true },
      ],
    },
    summary: "Dereference a value pointer and Input.insertText into the selector.",
  },
  {
    subcommand: "breath fill-form",
    verb: "breath",
    op_kind: "breath:fill_form",
    op_class: "actuate",
    action: "fill_form",
    mcp_tool: "unbrowse_breath_fill_form",
    cli: {
      usage: "unbrowse fill-form [selector] [--intent <text>] [--dry-run] [--session <id>] [--arg key=value] [--argScope <json>]",
      positional: [{ name: "[selector]", description: "CSS selector for the form (default: the first <form> on the page).", required: false }],
      flags: [
        { name: "--intent", description: "Free-text intent that focuses the per-slot candidate pick.", value_expected: true },
        { name: "--dry-run", description: "Stop at PROPOSE — print proposed pointers without resolving/injecting.", value_expected: false },
        { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
        { name: "--arg", description: "Single arg-scope key (key=value form).", value_expected: true },
        { name: "--argScope", description: "Full arg-scope object as JSON.", value_expected: true },
      ],
    },
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
    cli: {
      usage: "unbrowse type <text-or-pointer> [--session <id>] [--arg key=value] [--argScope <json>]",
      positional: [{ name: "<text-or-pointer>", description: "Literal text (echoed, not auditable) or a value pointer (op://|keychain://|bw://|arg://).", required: true }],
      flags: [
        { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
        { name: "--arg", description: "Single arg-scope key (key=value form).", value_expected: true },
        { name: "--argScope", description: "Full arg-scope object as JSON.", value_expected: true },
      ],
    },
    summary: "Dereference a value pointer and dispatch per-character key events.",
  },
  {
    subcommand: "breath click",
    verb: "breath",
    op_kind: "breath:click",
    op_class: "actuate",
    action: "click",
    mcp_tool: "unbrowse_breath_click",
    cli: {
      usage: "unbrowse click <selector> [--session <id>] [--button left|right|middle] [--click-count 1|2|3] [--modifiers shift,alt,ctrl,meta] [--timeout <ms>]",
      positional: [{ name: "<selector>", description: "CSS selector OR `[eN]` accessibility ref.", required: true }],
      flags: [
        { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
        { name: "--button", description: "left | right | middle (default: left).", value_expected: true },
        { name: "--click-count", description: "1 for single, 2 for double, 3 for triple (default: 1).", value_expected: true },
        { name: "--modifiers", description: "Comma-separated: shift,alt,ctrl,meta.", value_expected: true },
        { name: "--timeout", description: "Wall-clock timeout in ms (default: 30000).", value_expected: true },
      ],
    },
    summary: "Compose Input.dispatchMouseEvent press+release on a selector.",
  },
  {
    subcommand: "breath press",
    verb: "breath",
    op_kind: "breath:press",
    op_class: "actuate",
    action: "press",
    mcp_tool: "unbrowse_breath_press",
    cli: {
      usage: "unbrowse press <key> [--session <id>]",
      positional: [{ name: "<key>", description: "Key name: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space.", required: true }],
      flags: [{ name: "--session", description: "Browse session id (default: most-recent).", value_expected: true }],
    },
    summary: "Dispatch a single Input.dispatchKeyEvent (with modifiers).",
  },
  {
    subcommand: "breath select",
    verb: "breath",
    op_kind: "breath:select",
    op_class: "actuate",
    action: "select",
    mcp_tool: "unbrowse_breath_select",
    cli: {
      usage: "unbrowse select <selector> <pointer-or-value> [--session <id>] [--by value|label|index] [--arg key=value] [--argScope <json>] [--timeout <ms>]",
      positional: [
        { name: "<selector>", description: "CSS selector of the <select> element.", required: true },
        { name: "<pointer-or-value>", description: "Value pointer (op:// | keychain:// | bw:// | arg://) or cleartext literal.", required: true },
      ],
      flags: [
        { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
        { name: "--by", description: "value | label | index (default: value).", value_expected: true },
        { name: "--arg", description: "Single arg-scope key (key=value form).", value_expected: true },
        { name: "--argScope", description: "Full arg-scope object as JSON.", value_expected: true },
        { name: "--timeout", description: "Wall-clock timeout in ms (default: 30000).", value_expected: true },
      ],
    },
    summary: "Set a <select> element's value (pointer-or-cleartext).",
  },
  {
    subcommand: "breath scroll",
    verb: "breath",
    op_kind: "breath:scroll",
    op_class: "actuate",
    action: "scroll",
    mcp_tool: "unbrowse_breath_scroll",
    cli: {
      usage: "unbrowse scroll [selector] <dx,dy> [--session <id>]",
      positional: [
        { name: "[selector]", description: "Optional CSS selector to anchor the wheel event over its center.", required: false },
        { name: "<dx,dy>", description: "Pixels. `500` = `0,500`. Signed integers permitted.", required: true },
      ],
      flags: [{ name: "--session", description: "Browse session id (default: most-recent).", value_expected: true }],
    },
    summary: "Scroll the page or a specific selector by (dx, dy) pixels.",
  },
  {
    subcommand: "breath submit",
    verb: "breath",
    op_kind: "breath:submit",
    op_class: "actuate",
    action: "submit",
    mcp_tool: "unbrowse_breath_submit",
    cli: {
      usage: "unbrowse submit [selector] [--session <id>] [--wait] [--timeout <ms>]",
      positional: [{ name: "[selector]", description: "CSS selector of the <form> or a form-bound element (default: activeElement's form ancestor).", required: false }],
      flags: [
        { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
        { name: "--wait", description: "Wait for navigation after submit (default: false in v7.0).", value_expected: false },
        { name: "--timeout", description: "Navigation wait timeout in ms.", value_expected: true },
      ],
    },
    summary: "Submit a form (optionally targeted by selector).",
  },
  {
    subcommand: "breath execute",
    verb: "breath",
    op_kind: "breath:execute",
    op_class: "actuate",
    action: "execute",
    mcp_tool: "unbrowse_breath_execute",
    cli: {
      usage: "unbrowse execute --skill <id> --endpoint <id> [-p k=v ...] [--dry-run]",
      flags: [
        { name: "--skill", description: "Skill id from the resolve shortlist.", value_expected: true },
        { name: "--endpoint", description: "Endpoint id from the resolve shortlist.", value_expected: true },
        { name: "--params", description: "Endpoint parameters as JSON or key=value pairs.", value_expected: true },
        { name: "--session", description: "Bind the replay to an existing session id.", value_expected: true },
        { name: "--method", description: "Override the HTTP method.", value_expected: true },
        { name: "--dry-run", description: "Preview the request shape without executing. ALWAYS run this before a mutation.", value_expected: false },
        { name: "--confirm-unsafe", description: "Execute a mutating endpoint after a reviewed --dry-run.", value_expected: false },
        { name: "--path", description: "Dot-path projection of the response (e.g. data.items[]).", value_expected: true },
        { name: "--extract", description: "Comma-separated fields to keep from --path rows.", value_expected: true },
        { name: "--limit", description: "Cap the number of projected rows.", value_expected: true },
      ],
    },
    summary: "Replay a captured endpoint with pointer-resolved headers + body.",
  },
  {
    subcommand: "breath auth-capture",
    verb: "breath",
    op_kind: "breath:auth_capture",
    op_class: "actuate",
    action: "auth_capture",
    mcp_tool: "unbrowse_breath_auth_capture",
    cli: {
      usage: "unbrowse auth-capture <login-url> [--domain <domain>] [--timeout <ms>] [--settle <ms>]",
      positional: [{ name: "<login-url>", description: "Absolute URL of the login page.", required: true }],
      flags: [
        { name: "--domain", description: "Cookie domain to filter on (default: derived from login-url host).", value_expected: true },
        { name: "--timeout", description: "Hard timeout in ms (default: 300000).", value_expected: true },
        { name: "--settle", description: "No-new-cookie quiet period in ms (default: 10000).", value_expected: true },
      ],
    },
    summary: "Interactive auth flow; on completion writes credential pointer to vault.",
  },
  {
    subcommand: "breath proxy-rotate",
    verb: "breath",
    op_kind: "breath:proxy_rotate",
    op_class: "actuate",
    action: "proxy_rotate",
    mcp_tool: "unbrowse_breath_proxy_rotate",
    cli: {
      usage: "unbrowse proxy-rotate [--country <iso2>] [--session <id>]",
      flags: [
        { name: "--session", description: "Browse session id (default: spawn a new one).", value_expected: true },
        { name: "--country", description: "Country lock (ISO-3166-1 alpha-2, e.g. US, MY, SG).", value_expected: true },
      ],
    },
    summary: "Rotate the residential proxy session (iproyal sticky-IP refresh).",
  },
  {
    subcommand: "breath close",
    verb: "breath",
    op_kind: "breath:close",
    op_class: "actuate",
    action: "close",
    mcp_tool: "unbrowse_breath_close",
    cli: {
      usage: "unbrowse close [session-id] [--session <id>]",
      positional: [{ name: "[session-id]", description: "Session id (default: most-recent).", required: false }],
      flags: [{ name: "--session", description: "Alternate form of the positional session id.", value_expected: true }],
    },
    summary: "Close the current browse session; drain capture pipeline. DEPRECATED in v7.2.0-preview.0 — use 'breath session-park' (KV-persisted).",
  },
  {
    subcommand: "breath session-park",
    verb: "breath",
    op_kind: "breath:session_park",
    op_class: "actuate",
    action: "session_park",
    mcp_tool: "unbrowse_breath_session_park",
    cli: {
      usage: "unbrowse session-park [session-id] [--session <id>]",
      positional: [{ name: "[session-id]", description: "Session id (default: most-recent).", required: false }],
      flags: [{ name: "--session", description: "Alternate form of the positional session id.", value_expected: true }],
    },
    summary: "Park the current browse session — same teardown as close + persists pointer-of-pointer chain to KV for later session-restore. v7.2.0-preview.0 KV path is inert; v7.3 wires real storage.",
  },
  {
    subcommand: "breath session-restore",
    verb: "breath",
    op_kind: "breath:session_restore",
    op_class: "actuate",
    action: "session_restore",
    mcp_tool: "unbrowse_breath_session_restore",
    cli: {
      usage: "unbrowse session-restore <session-id> [--ws <existing-chrome-ws>]",
      positional: [{ name: "<session-id>", description: "Session id to restore (from a prior session-park).", required: true }],
      flags: [{ name: "--ws", description: "Attach to an existing Chrome at this ws:// endpoint rather than spawning a fresh browser.", value_expected: true }],
    },
    summary: "Restore a previously parked session — KV read, wallet-signed challenge, spawn or attach to Chrome, rebuild local session record.",
  },
  {
    subcommand: "breath run",
    verb: "breath",
    op_kind: "breath:run",
    op_class: "actuate",
    action: "run",
    mcp_tool: "unbrowse_breath_run",
    cli: {
      usage: 'unbrowse run <url> "<task>" [--dry-run] [--confirm-third-party-terms] [--budget <ms>]',
      positional: [
        { name: "<url>", description: "Target site (alt form: --url).", required: true },
        { name: '"<task>"', description: "Natural-language description of what to do (alt form: --intent/--task/--query).", required: true },
      ],
      flags: [
        { name: "--url", description: "Alternate form of the <url> positional.", value_expected: true },
        { name: "--intent", description: "Alternate form of the task positional (aliases: --task, --query).", value_expected: true },
        { name: "--dry-run", description: "Preview the request shape without executing.", value_expected: false },
        { name: "--confirm-third-party-terms", description: "Required to proceed past the third-party ToS gate for a write.", value_expected: false },
        { name: "--budget", description: "Resolve budget in ms (default: 8000).", value_expected: true },
        { name: "--endpoint-id", description: "Skip resolve; force a specific endpoint id (alias: --endpoint).", value_expected: true },
        { name: "--no-execute", description: "Resolve only; do not auto-execute the best-ranked endpoint.", value_expected: false },
        { name: "--header", description: "Explicit auth header for a direct authorized read (`Name: value` or JSON object).", value_expected: true },
        { name: "--bearer-token", description: "Explicit bearer token for a direct authorized read.", value_expected: true },
        { name: "--body", description: "Write request body (JSON); routes to the write-execute path.", value_expected: true },
        { name: "--method", description: "Explicit HTTP method for a one-hole write.", value_expected: true },
        { name: "--params", description: "Extra request params as a JSON object, merged into the request.", value_expected: true },
      ],
    },
    summary: "Resolve an intent then execute the best-ranked endpoint in one shot.",
  },
  {
    subcommand: "breath get",
    verb: "breath",
    op_kind: "breath:get",
    op_class: "actuate",
    action: "get",
    mcp_tool: "unbrowse_breath_get",
    cli: {
      usage: 'unbrowse get "<task>" [--url <url>]',
      positional: [{ name: '"<task>"', description: "Natural-language description of the result you want.", required: true }],
      flags: [{ name: "--url", description: "Target site to resolve against (recommended).", value_expected: true }],
    },
    summary: "Cache-first one-call fetch by intent — resolves from the local skill-cache, auto-captures on a miss, and replays the cached endpoint next time.",
  },
  {
    subcommand: "breath fetch",
    verb: "breath",
    op_kind: "breath:fetch",
    op_class: "actuate",
    action: "fetch",
    mcp_tool: "unbrowse_breath_fetch",
    cli: {
      usage: "unbrowse fetch <url>",
      positional: [{ name: "<url>", description: "URL to fetch and return as clean content.", required: true }],
    },
    summary: "Replay a captured endpoint by id/url with pointer-resolved request.",
  },
  {
    subcommand: "breath capture",
    verb: "breath",
    op_kind: "breath:capture",
    op_class: "actuate",
    action: "capture",
    mcp_tool: "unbrowse_breath_capture",
    cli: {
      usage: 'unbrowse capture --url <url> --intent "<task>"',
      flags: [
        { name: "--url", description: "Site to browse and capture.", value_expected: true },
        { name: "--intent", description: "What you are trying to get — guides capture and indexing.", value_expected: true },
      ],
    },
    summary: "Drive a browse session to capture a site's internal API routes into the cache.",
  },
  {
    subcommand: "breath back",
    verb: "breath",
    op_kind: "breath:back",
    op_class: "actuate",
    action: "back",
    mcp_tool: "unbrowse_breath_back",
    cli: {
      usage: "unbrowse back [--session <id>]",
      flags: [{ name: "--session", description: "Browse session id (default: most-recent).", value_expected: true }],
    },
    summary: "Navigate the current session back one entry in history.",
  },
  {
    subcommand: "breath forward",
    verb: "breath",
    op_kind: "breath:forward",
    op_class: "actuate",
    action: "forward",
    mcp_tool: "unbrowse_breath_forward",
    cli: {
      usage: "unbrowse forward [--session <id>]",
      flags: [{ name: "--session", description: "Browse session id (default: most-recent).", value_expected: true }],
    },
    summary: "Navigate the current session forward one entry in history.",
  },
  {
    subcommand: "breath sync",
    verb: "breath",
    op_kind: "breath:sync",
    op_class: "actuate",
    action: "sync",
    mcp_tool: "unbrowse_breath_sync",
    cli: {
      usage: "unbrowse sync [--session <id>]",
      flags: [{ name: "--session", description: "Browse session id (default: most-recent).", value_expected: true }],
    },
    summary: "Sync the local session state with the live browser tab.",
  },
  {
    subcommand: "breath run-js",
    verb: "breath",
    op_kind: "breath:run_js",
    op_class: "actuate",
    action: "run_js",
    mcp_tool: "unbrowse_breath_run_js",
    cli: {
      usage: "unbrowse run-js <expression> [--session <id>] [--timeout <ms>]",
      positional: [{ name: "<expression>", description: "JavaScript expression to evaluate in the current page context.", required: true }],
      flags: [
        { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
        { name: "--timeout", description: "Wall-clock timeout in ms (default: 30000).", value_expected: true },
      ],
    },
    summary: "Evaluate arbitrary JavaScript in the current page context (renamed from eval to avoid verb collision).",
  },
  {
    subcommand: "breath auth",
    verb: "breath",
    op_kind: "breath:auth_login",
    op_class: "actuate",
    action: "auth_login",
    mcp_tool: "unbrowse_breath_auth_login",
    cli: {
      usage: "unbrowse auth <login_url>",
      positional: [{ name: "<login_url>", description: "Login page to open; the user signs in once, cookies persist for the domain.", required: true }],
    },
    summary: "Drive an interactive login flow for a target site and bind the session.",
  },
  {
    subcommand: "breath connect-chrome",
    verb: "breath",
    op_kind: "breath:connect_chrome",
    op_class: "actuate",
    action: "connect_chrome",
    mcp_tool: null,
    cli: {
      usage: "unbrowse connect-chrome",
    },
    summary: "Attach to an already-running Chrome instance over the DevTools protocol; local-only.",
  },
  {
    subcommand: "breath serve",
    verb: "breath",
    op_kind: "breath:serve",
    op_class: "actuate",
    action: "serve",
    mcp_tool: null,
    cli: {
      usage: "unbrowse serve",
    },
    summary: "Bounded foreground compatibility facade only — honors --no-auto-start; never auto-spawns a daemon; local-only.",
  },
  {
    subcommand: "breath mcp",
    verb: "breath",
    op_kind: "breath:mcp",
    op_class: "actuate",
    action: "mcp",
    mcp_tool: null,
    cli: {
      usage: "unbrowse mcp [--no-auto-start]",
      flags: [{ name: "--no-auto-start", description: "Do not auto-start the daemon; pass through to the spawned MCP server process.", value_expected: false }],
    },
    summary: "Run the stdio MCP server in-process for a host config; local-only.",
  },
  {
    subcommand: "breath dashboard",
    verb: "breath",
    op_kind: "breath:dashboard",
    op_class: "actuate",
    action: "dashboard",
    mcp_tool: null,
    cli: {
      usage: "unbrowse dashboard [--account] [--path </some/path>] [--no-open]",
      flags: [
        { name: "--account", description: "Open /account instead of /dashboard (mutation safety pairing).", value_expected: false },
        { name: "--path", description: "Custom path to open; must start with '/' (default: /dashboard).", value_expected: true },
        { name: "--no-open", description: "Don't auto-open the browser; print the pairing/login URL instead.", value_expected: false },
      ],
    },
    summary: "Open the local dashboard UI in a browser; local-only.",
  },
  {
    subcommand: "breath upgrade",
    verb: "breath",
    op_kind: "breath:upgrade",
    op_class: "actuate",
    action: "upgrade",
    mcp_tool: null,
    cli: {
      usage: "unbrowse upgrade [--hint-only]",
      flags: [{ name: "--hint-only", description: "Silent check-and-apply mode (used by the session-start hook); suppresses status output.", value_expected: false }],
    },
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
    cli: {
      usage: "unbrowse snap [--session <id>]",
      flags: [
        { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
      ],
    },
    summary: "Accessibility.getFullAXTree of the current page (the [e0] frame).",
  },
  {
    subcommand: "eval resolve",
    verb: "eval",
    op_kind: "eval:resolve",
    op_class: "observe",
    action: "resolve",
    mcp_tool: "unbrowse_eval_resolve",
    cli: {
      usage: 'unbrowse resolve --intent "<task>" [--url <url>] [--domain <domain>] [--limit <n>]',
      flags: [
        { name: "--intent", description: "What you want from the site — ranks the shortlist.", value_expected: true },
        { name: "--url", description: "Target site URL to scope the search.", value_expected: true },
        { name: "--domain", description: "Scope to a domain (e.g. www.linkedin.com).", value_expected: true },
        { name: "--limit", description: "Max shortlist entries.", value_expected: true },
        { name: "--fresh", description: "Bypass the cached resolution and re-rank.", value_expected: false },
      ],
    },
    summary: "Ranked endpoint shortlist for an intent (route cache + marketplace).",
  },
  {
    subcommand: "eval status",
    verb: "eval",
    op_kind: "eval:status",
    op_class: "observe",
    action: "status",
    mcp_tool: "unbrowse_eval_status",
    cli: {
      usage: "unbrowse status [--session <id>]",
      flags: [
        { name: "--session", description: "Restrict to a single session id.", value_expected: true },
      ],
    },
    summary: "Current session + server health snapshot.",
  },
  {
    subcommand: "eval version",
    verb: "eval",
    op_kind: "eval:version",
    op_class: "observe",
    action: "version",
    mcp_tool: "unbrowse_eval_version",
    cli: {
      usage: "unbrowse version",
    },
    summary: "CLI version + build_sha + walletPubkey + signed release manifest.",
  },
  {
    subcommand: "eval trace",
    verb: "eval",
    op_kind: "eval:trace",
    op_class: "observe",
    action: "trace",
    mcp_tool: "unbrowse_eval_trace",
    cli: {
      usage: "unbrowse trace <session-id|host> [--domain <host>] [--intent <substring>] [--limit <n>]",
      positional: [
        { name: "session-id", description: "Browse session id, or a bare host like `example.com`.", required: true },
      ],
      flags: [
        { name: "--domain", description: "Explicit host (overrides session-id resolution).", value_expected: true },
        { name: "--intent", description: "Filter by intent substring.", value_expected: true },
        { name: "--limit", description: "Max rows to emit (default 50).", value_expected: true },
      ],
    },
    summary: "Read the stateless decision_trace for a session id.",
  },
  {
    subcommand: "eval markdown",
    verb: "eval",
    op_kind: "eval:markdown",
    op_class: "observe",
    action: "markdown",
    mcp_tool: "unbrowse_eval_markdown",
    cli: {
      usage: "unbrowse markdown [--session <id>] [--raw]",
      flags: [
        { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
        { name: "--raw", description: "Skip 10KB truncation; return full markdown.", value_expected: false },
      ],
    },
    summary: "Readable-markdown view of the current page.",
  },
  {
    subcommand: "eval screenshot",
    verb: "eval",
    op_kind: "eval:screenshot",
    op_class: "observe",
    action: "screenshot",
    mcp_tool: "unbrowse_eval_screenshot",
    cli: {
      usage: "unbrowse screenshot [--session <id>] [--stdout]",
      flags: [
        { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
        { name: "--stdout", description: "Write raw PNG bytes to stdout for piping; disables JSON output.", value_expected: false },
      ],
    },
    summary: "Page.captureScreenshot PNG of the current page.",
  },
  {
    subcommand: "eval text",
    verb: "eval",
    op_kind: "eval:text",
    op_class: "observe",
    action: "text",
    mcp_tool: "unbrowse_eval_text",
    cli: {
      usage: "unbrowse text [selector] [--session <id>]",
      positional: [
        { name: "selector", description: "CSS selector (default: document.body).", required: false },
      ],
      flags: [
        { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
      ],
    },
    summary: "Stripped page text or selector-scoped innerText.",
  },
  {
    subcommand: "eval cookies",
    verb: "eval",
    op_kind: "eval:cookies",
    op_class: "observe",
    action: "cookies",
    mcp_tool: "unbrowse_eval_cookies",
    cli: {
      usage: "unbrowse cookies [domain] [--session <id>] [--no-json]",
      positional: [
        { name: "domain", description: "Restrict to this domain/URL (default: all on current page).", required: false },
      ],
      flags: [
        { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
        { name: "--no-json", description: "Pretty-print `name@domain` lines instead of JSON.", value_expected: false },
      ],
    },
    summary: "Cookie listing for a domain — names + domains + expires ONLY (no values).",
  },
  {
    subcommand: "eval stats",
    verb: "eval",
    op_kind: "eval:stats",
    op_class: "observe",
    action: "stats",
    mcp_tool: "unbrowse_eval_stats",
    cli: {
      usage: "unbrowse stats [--domains] [--fresh]",
      flags: [
        {
          name: "--domains",
          description:
            "Per-domain view: indexed (skills/endpoints), used (executions), queried (hits/misses incl. unindexed demand). Aggregate-only.",
          value_expected: false,
        },
        { name: "--fresh", description: "Bypass CDN / KV cache (Cache-Control: no-cache).", value_expected: false },
      ],
    },
    summary: "Marketplace + earnings stats summary; --domains for the per-domain monitor.",
  },
  {
    subcommand: "eval skills",
    verb: "eval",
    op_kind: "eval:skills",
    op_class: "observe",
    action: "skills",
    mcp_tool: "unbrowse_eval_skills",
    cli: {
      usage: "unbrowse skills [--domain <domain>] [--limit <n>] [--include-deprecated] [--fresh]",
      flags: [
        { name: "--domain", description: "Filter by domain.", value_expected: true },
        { name: "--limit", description: "Max rows.", value_expected: true },
        { name: "--include-deprecated", description: "Include stale/deprecated skills.", value_expected: false },
        { name: "--fresh", description: "Bypass CDN / KV cache.", value_expected: false },
      ],
    },
    summary: "List captured skills.",
  },
  {
    subcommand: "eval skill",
    verb: "eval",
    op_kind: "eval:skill",
    op_class: "observe",
    action: "skill",
    mcp_tool: "unbrowse_eval_skill",
    cli: {
      usage: "unbrowse skill <skill-id> [--fresh]",
      positional: [
        { name: "skill-id", description: "Skill id from `unbrowse skills`.", required: true },
      ],
      flags: [
        { name: "--fresh", description: "Bypass CDN / KV cache.", value_expected: false },
      ],
    },
    summary: "Detail one captured skill by id.",
  },
  {
    subcommand: "eval sessions",
    verb: "eval",
    op_kind: "eval:sessions",
    op_class: "observe",
    action: "sessions",
    mcp_tool: "unbrowse_eval_sessions",
    cli: {
      usage: "unbrowse sessions [--limit <n>]",
      flags: [
        { name: "--limit", description: "Max rows (default: unlimited).", value_expected: true },
      ],
    },
    summary: "List active browse sessions.",
  },
  {
    subcommand: "eval earnings",
    verb: "eval",
    op_kind: "eval:earnings",
    op_class: "observe",
    action: "earnings",
    mcp_tool: "unbrowse_eval_earnings",
    cli: {
      usage: "unbrowse earnings [--since <YYYY-MM-DD>] [--agent-id <id>] [--fresh]",
      flags: [
        { name: "--since", description: "ISO8601/YYYY-MM-DD lower bound.", value_expected: true },
        { name: "--agent-id", description: "Override the derived agentId (sha256(walletPubkey)).", value_expected: true },
        { name: "--fresh", description: "Bypass CDN / KV cache.", value_expected: false },
      ],
    },
    summary: "x402 earnings summary for the current agent.",
  },
  {
    subcommand: "eval settings",
    verb: "eval",
    op_kind: "eval:settings",
    op_class: "observe",
    action: "settings",
    mcp_tool: "unbrowse_eval_settings",
    cli: {
      usage: "unbrowse settings [--set <key>=<pointer>] [--unset <key>] [--get <key>] [--include-env]",
      flags: [
        { name: "--set", description: "Set key=value (pointer-prefixed: literal:|op://|keychain://|bw://|arg://|unbrowse://).", value_expected: true },
        { name: "--unset", description: "Remove a key (wallet-signed DELETE).", value_expected: true },
        { name: "--get", description: "Read a single key — returns the stored pointer.", value_expected: true },
        { name: "--include-env", description: "Include resolved env-var names (not values).", value_expected: false },
      ],
    },
    summary: "Current local config + capture-pipeline settings.",
  },
  {
    subcommand: "eval feedback",
    verb: "eval",
    op_kind: "eval:feedback",
    op_class: "observe",
    action: "feedback",
    mcp_tool: "unbrowse_eval_feedback",
    cli: {
      usage: "unbrowse feedback <skill-id> --endpoint <endpoint-id> --rating <1-5> [--note <text>] [--session <id>]",
      positional: [
        { name: "skill-id", description: "Skill id the feedback targets.", required: true },
      ],
      flags: [
        { name: "--endpoint", description: "Endpoint id this feedback targets.", value_expected: true },
        { name: "--rating", description: "Integer rating 1..5.", value_expected: true },
        { name: "--note", description: "Free-form note (sanitized — pointers/secrets stripped).", value_expected: true },
        { name: "--session", description: "Session id (for the audit trail).", value_expected: true },
      ],
    },
    summary: "Submit feedback on the last execute (commitment-only).",
  },
  {
    subcommand: "eval reflect",
    verb: "eval",
    op_kind: "eval:reflect",
    op_class: "observe",
    action: "reflect",
    mcp_tool: "unbrowse_eval_reflect",
    cli: {
      usage: "unbrowse reflect --outcome <achieved|partial|failed> --skill <id> --endpoint <id> [--session-id <id>]",
      flags: [
        { name: "--outcome", description: "achieved | partial | failed.", value_expected: true },
        { name: "--skill", description: "Skill id whose reliability the reflect updates.", value_expected: true },
        { name: "--endpoint", description: "Endpoint id whose reliability the reflect updates.", value_expected: true },
        { name: "--session-id", description: "Session id (local trail only — not sent to backend).", value_expected: true },
      ],
    },
    summary: "Reflect on the user-facing outcome of the current task.",
  },
  {
    subcommand: "eval auth-inventory",
    verb: "eval",
    op_kind: "eval:auth_inventory",
    op_class: "observe",
    action: "auth_inventory",
    mcp_tool: "unbrowse_eval_auth_inventory",
    cli: {
      usage: "unbrowse auth-inventory [--limit <n>] [--dia-only] [--chrome-profile <path>] [--dia-profile <path>] [--firefox-profile <path>] [--no-json]",
      flags: [
        { name: "--limit", description: "Top-N domains by score (default 100).", value_expected: true },
        { name: "--chrome-profile", description: "Test override: scan exactly this Chrome profile directory.", value_expected: true },
        { name: "--dia-profile", description: "Test override: scan exactly this Dia Chromium profile directory.", value_expected: true },
        { name: "--dia-only", description: "Scan default Dia profiles and skip Chrome/Firefox defaults.", value_expected: false },
        { name: "--firefox-profile", description: "Test override: scan exactly this Firefox profile directory.", value_expected: true },
        { name: "--no-json", description: "Compact `domain: score check` lines instead of JSON.", value_expected: false },
      ],
    },
    summary:
      "Per-domain AST of what the user can already authenticate against — local browser cookies (metadata only), history hostnames, bookmarks. Bias the resolve ranker toward logged-in domains.",
  },
  {
    subcommand: "eval browsers",
    verb: "eval",
    op_kind: "eval:browsers",
    op_class: "observe",
    action: "browsers",
    mcp_tool: "unbrowse_eval_browsers",
    cli: {
      usage: "unbrowse browsers [--set <name>=<path>] [--prefer <name>] [--profile <leaf>]",
      flags: [
        { name: "--set", description: "Remember a browser path: name=/absolute/user-data-dir (e.g. chromium=~/.config/chromium).", value_expected: true },
        { name: "--prefer", description: "Prefer this browser name for auto cookie import (stored in browser-paths.json).", value_expected: true },
        { name: "--profile", description: "Optional profile leaf with --set (Default, Profile 1, …).", value_expected: true },
      ],
    },
    summary:
      "List installed local browsers as cookie-import options (name, profile root, last-active, DB presence). Metadata only — never cookie values.",
  },
  {
    subcommand: "eval spec",
    verb: "eval",
    op_kind: "eval:spec_discover",
    op_class: "observe",
    action: "spec_discover",
    mcp_tool: "unbrowse_eval_spec_discover",
    cli: {
      usage: "unbrowse spec <url-or-domain> [--graphql] [--budget-ms <n>]",
      positional: [
        { name: "url-or-domain", description: "Target site origin, e.g. `example.com` or `https://api.example.com`.", required: true },
      ],
      flags: [
        { name: "--graphql", description: "Also probe POST /graphql for introspection (opt-in; some sites flag it).", value_expected: false },
        { name: "--budget-ms", description: "Per-probe timeout (default 3000).", value_expected: true },
      ],
    },
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
    cli: {
      usage: 'unbrowse explain --intent "<task>" --url <url> [--top <n>]',
      flags: [
        { name: "--intent", description: "Natural-language intent to explain (alias --task).", value_expected: true },
        { name: "--url", description: "Target site URL.", value_expected: true },
        { name: "--top", description: "Max shortlist entries returned (default 5).", value_expected: true },
      ],
    },
    summary: "Explain how a given intent would resolve and execute, without acting.",
  },
  {
    subcommand: "eval search",
    verb: "eval",
    op_kind: "eval:search",
    op_class: "observe",
    action: "search",
    mcp_tool: "unbrowse_eval_search",
    cli: {
      usage: 'unbrowse search --intent "<task>" [--url <url>] [--domain <domain>]',
      flags: [
        { name: "--intent", description: "What you want from the site — drives the search and telemetry.", value_expected: true },
        { name: "--url", description: "Target site URL to scope the search.", value_expected: true },
        { name: "--domain", description: "Scope to a domain (derived from --url when omitted).", value_expected: true },
      ],
    },
    summary: "Search the marketplace/route graph for endpoints matching a query.",
  },
  {
    subcommand: "eval research",
    verb: "eval",
    op_kind: "eval:research",
    op_class: "observe",
    action: "research",
    mcp_tool: "unbrowse_eval_research",
    cli: {
      usage: 'unbrowse research "<query>" [--num-results <n>]',
      positional: [
        { name: "query", description: "Natural-language research question.", required: true },
      ],
      flags: [
        { name: "--num-results", description: "Max search results to fetch and synthesize (default 5).", value_expected: true },
      ],
    },
    summary: "Research a question: the full resolve->read->ground walk (search -> extract* -> synthesized cited answer). The deep end of the same pipeline `search` and `extract` expose.",
  },
  {
    subcommand: "eval extract",
    verb: "eval",
    op_kind: "eval:extract",
    op_class: "observe",
    action: "extract",
    mcp_tool: "unbrowse_eval_extract",
    cli: {
      usage: "unbrowse extract <url> [<url2> ...]",
      positional: [
        { name: "url", description: "One or more URLs to extract clean content from.", required: true },
      ],
      flags: [
        { name: "--url", description: "Comma-separated URL list (alternative to positional args).", value_expected: true },
      ],
    },
    summary: "Extract clean content from one or more URLs (the READ step of research, exposed in batch; a URL hole -> its markdown value). Tavily /extract parity.",
  },
  {
    subcommand: "eval map",
    verb: "eval",
    op_kind: "eval:map",
    op_class: "observe",
    action: "map",
    mcp_tool: "unbrowse_eval_map",
    cli: {
      usage: "unbrowse map <url>",
      positional: [
        { name: "url", description: "URL whose outgoing links to map.", required: true },
      ],
    },
    summary: "Map a URL's outgoing links (a URL hole -> its POINTERS; the pointers face of the read that `extract` resolves to a value). Tavily /map parity.",
  },
  {
    subcommand: "eval crawl",
    verb: "eval",
    op_kind: "eval:crawl",
    op_class: "observe",
    action: "crawl",
    mcp_tool: "unbrowse_eval_crawl",
    cli: {
      usage: "unbrowse crawl <url> [--max-pages <n>]",
      positional: [
        { name: "url", description: "Seed URL to crawl.", required: true },
      ],
      flags: [
        { name: "--max-pages", description: "Max pages to crawl, same-domain (default 5).", value_expected: true },
      ],
    },
    summary: "Crawl a seed URL one hop (map ∘ extract*, same-domain, page-capped): read the seed + its same-site links. Tavily /crawl parity.",
  },
  {
    subcommand: "eval inspect",
    verb: "eval",
    op_kind: "eval:inspect",
    op_class: "observe",
    action: "inspect",
    mcp_tool: "unbrowse_eval_inspect",
    cli: {
      usage: "unbrowse inspect [session-id] [--session <id>] [--all]",
      positional: [
        { name: "session-id", description: "Browse session id to inspect (default: most-recent).", required: false },
      ],
      flags: [
        { name: "--session", description: "Browse session id (alternative to the positional).", value_expected: true },
        { name: "--all", description: "List all sessions instead of inspecting one.", value_expected: false },
      ],
    },
    summary: "Inspect a captured endpoint's full request/response shape and metadata.",
  },
  {
    subcommand: "eval account",
    verb: "eval",
    op_kind: "eval:account",
    op_class: "observe",
    action: "account",
    mcp_tool: null,
    cli: {
      usage: "unbrowse account [--reset-key] [--email <email>] [--no-prompt]",
      flags: [
        { name: "--reset-key", description: "Rotate the API key (delegates to register --reset).", value_expected: false },
        { name: "--email", description: "Email to use when resetting/registering.", value_expected: true },
        { name: "--no-prompt", description: "Skip interactive prompts during reset.", value_expected: false },
      ],
    },
    summary: "Show the current agent account, wallet, and credit balance; local-only.",
  },
  {
    subcommand: "eval config",
    verb: "eval",
    op_kind: "eval:config",
    op_class: "observe",
    action: "config",
    mcp_tool: null,
    cli: {
      usage: "unbrowse config get telemetry | unbrowse config set telemetry <true|false>",
      positional: [
        { name: "action", description: "get | set.", required: true },
        { name: "key", description: "Config key (currently only `telemetry`).", required: true },
        { name: "value", description: "New value for `set` (true|false).", required: false },
      ],
    },
    summary: "Read or write local config keys; local-only.",
  },
  {
    subcommand: "eval schema",
    verb: "eval",
    op_kind: "eval:schema",
    op_class: "observe",
    action: "schema",
    mcp_tool: null,
    cli: {
      usage: "unbrowse schema <command>",
      positional: [
        { name: "<command>", description: "Flat command name (resolve, execute, …) or the full \"<verb> <cap>\" form.", required: true },
      ],
    },
    summary: "Typed schema for one command: op_kind, MCP tool mapping, arg surface, and exit codes — self-description as data, derived from the kind-map.",
  },
  {
    subcommand: "eval contract",
    verb: "eval",
    op_kind: "eval:contract",
    op_class: "observe",
    action: "contract",
    mcp_tool: null,
    cli: {
      usage: 'unbrowse contract "<goal>"',
      positional: [
        { name: "goal", description: "The truth claim; the verb rides in the leading token (declare|iterate|satisfied|died|validate|signed|status).", required: true },
      ],
    },
    summary: "Declare a truth claim (wallet-signed) or read its projection: `contract declare <text>` / `contract status <id>`.",
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

/**
 * Commands one edit away from `token` (Damerau-Levenshtein ≤ 1, so
 * transpositions like "reslove" → "resolve" count). Candidates derive from
 * the SAME flat surface the dispatch uses (flatVerbMap) plus any extras the
 * caller owns (cli.ts adds its own specials like "health") — never a
 * hand-kept list. Used by the front door's typo guard: a bare single token
 * this close to a real command is a mistyped command, not a web intent.
 */
export function nearestFlatCommands(token: string, extras: readonly string[] = []): string[] {
  if (!token || token.length < 3 || token.includes(" ")) return [];
  const candidates = [...flatVerbMap().keys(), ...extras];
  const hits: string[] = [];
  for (const cand of candidates) {
    if (cand === token) continue;
    if (Math.abs(cand.length - token.length) > 1) continue;
    if (damerauLevenshtein1(token, cand)) hits.push(cand);
  }
  return [...new Set(hits)];
}

/** True iff Damerau-Levenshtein distance between a and b is exactly ≤ 1 (a ≠ b). */
export function oneEditAway(a: string, b: string): boolean {
  return damerauLevenshtein1(a, b);
}

function damerauLevenshtein1(a: string, b: string): boolean {
  if (a === b) return false;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    // One substitution, or one adjacent transposition.
    let i = 0;
    while (i < la && a[i] === b[i]) i++;
    if (i === la) return false;
    // substitution: rest equal after the single mismatch
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    // transposition: swapped pair, rest equal
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  // One insertion/deletion.
  const [shorter, longer] = la < lb ? [a, b] : [b, a];
  let i = 0;
  while (i < shorter.length && shorter[i] === longer[i]) i++;
  return shorter.slice(i) === longer.slice(i + 1);
}

/**
 * Recognize a /contract attestation goal at the root: `unbrowse "satisfied:<id> …"`,
 * `"died:<id> …"`, `"status:<id>"`, etc. The aiko verb closure (build/run/eval/prune
 * = declare/iterate/satisfied/died, + the validate/signed/status reads) rides in the
 * goal's LEADING TOKEN. This is the contract substrate's own grammar — not a per-site
 * allowlist — so recognizing it is structural, not a hard filter.
 *
 * Why this exists: `unbrowse contract` is goal-only and so is the root front door
 * (`unbrowse "<goal>"` → resolve+execute, which auto-declares — a TASK goal is already
 * a contract). The only piece not yet at the root is the explicit ATTESTATION (a
 * substrate op, not a task). This recognizer routes those through the root so
 * `unbrowse "satisfied:<id> — proof"` works WITHOUT a separate `contract` subcommand —
 * the merge of `unbrowse contract` into `unbrowse` itself. A plain task goal returns
 * false and falls through to the resolve+execute front door (which still auto-declares).
 */
export function looksLikeContractGoal(firstArg: string): boolean {
  return /^(declare|iterate|satisfied|died|validate|signed|status)\s*:/i.test(
    (firstArg ?? "").trimStart(),
  );
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
