/**
 * mcp-tool-schemas — the typed tool contracts, as DATA.
 *
 * Split out of src/mcp.ts so the schemas can be read without executing anything.
 * mcp.ts calls main() at module scope, so importing it starts the stdio server
 * and writes a telemetry session file; that made the schemas unreadable by
 * `unbrowse schema`, which is a read-only query. The packaged binary depends on
 * that import side effect (single-binary.ts), so the fix could not be to guard
 * main() — the schemas had to move instead.
 *
 * This module imports NOTHING and runs NOTHING. It is the single source of truth
 * for tool shape: mcp.ts binds handlers to these by name, so a schema declared
 * here without a handler (or vice versa) is a startup error, not silent drift.
 *
 * Dev/test-only tools (unbrowse_type_audit, unbrowse_test_crash) are deliberately
 * NOT here — they are conditionally registered in mcp.ts and are not part of the
 * agent-facing surface.
 */

export type JsonSchemaProperty = {
  type?: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  additionalProperties?: boolean;
};

export type JsonSchema = {
  type: "object";
  description?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolSchema = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: Record<string, boolean>;
};

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "unbrowse_eval_resolve",
    description: "Use when the agent has an INTENT (e.g. 'top stories', 'get user profile') and wants a structured result. Returns a ranked shortlist of cached marketplace endpoints. Workflow: (1) call unbrowse_eval_resolve with the intent + url/domain → returns available_endpoints; (2) pick the best match using example_response_compact, requires, and yields fields as evidence; (3) call unbrowse_breath_execute with that endpoint_id. ALTERNATIVES: if you only need raw page capture, use unbrowse_breath_navigate. If the site has no cached endpoints (no_cached_match), fall through to unbrowse_breath_navigate to capture fresh DOM. AFTER presenting results to the user, you MUST call unbrowse_eval_feedback.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "Natural-language task to perform on the page or site." },
        url: { type: "string", description: "Exact page URL to resolve against." },
        endpoint_id: { type: "string", description: "Force a specific endpoint returned from a prior resolve." },
        params: { type: "object", description: "Extra execution params merged into the endpoint call." },
        execute: { type: "boolean", description: "Auto-execute the selected or top-ranked endpoint." },
        dry_run: { type: "boolean", description: "Preview unsafe calls without applying them." },
        confirm_third_party_terms: { type: "boolean", description: "Explicitly confirm policy-sensitive third-party terms risk for flagged domains/actions." },
        force_capture: { type: "boolean", description: "Bypass cache and re-capture the exact URL." },
        raw: { type: "boolean", description: "Keep raw projection enabled. Default true." },
        schema: { type: "boolean", description: "Return a schema tree instead of data." },
        path: { type: "string", description: "Drill into the result before returning it, e.g. data.items[] ." },
        extract: { type: "string", description: "Project specific fields, e.g. name,url or alias:path.to.value." },
        limit: { type: "number", description: "Limit returned array rows." },
        flash: { type: "boolean", description: "Token-minimal shortlist: each candidate is reduced to endpoint_id + skill_id + a one-line flash_evidence string. Opt-in; default returns the full rich shortlist." },
      },
      required: ["intent"],
      additionalProperties: false,
    },
  },
  {
    name: "unbrowse_breath_execute",
    description: "Execute a known endpoint by skill and endpoint id. Only call after unbrowse_eval_resolve returned endpoints. Mutation-shaped routes are deny/whitelist/ask governed: if the result contains mutation_confirmation_required, ask the user whether to allow this exact request, then retry once with confirm_unsafe=true only after explicit consent. After presenting results to the user, you MUST call unbrowse_eval_feedback.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill id." },
        endpoint: { type: "string", description: "Endpoint id inside the skill." },
        params: { type: "object", description: "Execution params." },
        url: { type: "string", description: "Context URL for explicit replay/auth." },
        intent: { type: "string", description: "Optional natural-language intent for trace context." },
        dry_run: { type: "boolean", description: "Preview unsafe calls without applying them." },
        confirm_unsafe: { type: "boolean", description: "Confirm mutation if the endpoint is unsafe." },
        confirm_third_party_terms: { type: "boolean", description: "Explicitly confirm policy-sensitive third-party terms risk for flagged domains/actions." },
        raw: { type: "boolean", description: "Keep raw projection enabled. Default true." },
        schema: { type: "boolean", description: "Return a schema tree instead of data." },
        path: { type: "string", description: "Drill into the result before returning it, e.g. data.items[] ." },
        extract: { type: "string", description: "Project specific fields, e.g. name,url or alias:path.to.value." },
        limit: { type: "number", description: "Limit returned array rows." },
      },
      required: ["skill"],
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_eval_stats",
    description: "Show lifetime impact for this agent: total time saved, tokens saved, cost saved, browser calls avoided, and marketplace earnings/spending. Read-only - safe to call anytime. Use this to show the user the concrete value Unbrowse has delivered.",
    inputSchema: {
      type: "object",
      properties: {
        include_recent: { type: "boolean", description: "Include recent earnings/spending transactions. Default false." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_search_endpoints",
    description: "Semantic search across ALL marketplace endpoints. Returns a flat list of endpoints (one row per endpoint, not grouped by skill) ranked by semantic match to your intent. Use this when you want to discover endpoints across many skills/domains (vs unbrowse_eval_resolve which binds an intent to a specific URL, or the skill-grouped search). Anonymous-allowed: public discovery works without an API key; authenticated agents pay the standard search fee. Each hit carries endpoint_id + skill_id so you can chain into unbrowse_breath_execute or unbrowse_eval_skill.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "Natural-language intent (e.g., 'search trending repositories', 'list calendar events for next week')." },
        k: { type: "number", description: "Max results to return (1-50, default 10).", minimum: 1, maximum: 50 },
        domain: { type: "string", description: "Optional: restrict the search to one host (e.g., 'github.com'). Omit for cross-marketplace search." },
      },
      required: ["intent"],
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_eval_search",
    description: "Unified search-on-top: find the route/skill (or the web answer) for an intent. Searches the shared route graph first, plus best-effort web (Exa) enrichment. Discovery is FREE — you only pay when you execute a returned PAID route: unbrowse_breath_execute settles that per-request via x402 (split 50/35/15 platform/indexer/owner), delegated to your wallet (no keys handled here). Returns ranked hits, each with skill_id + endpoint_id where applicable so you can chain into unbrowse_breath_execute.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "Natural-language query (e.g., 'best machine learning frameworks', 'find a route to list GitHub repos')." },
        k: { type: "number", description: "Max results to return (1-25, default 10).", minimum: 1, maximum: 25 },
        web: { type: "boolean", description: "Allow live web-search fallback when no indexed route fits (default true). Set false to search the route graph only." },
      },
      required: ["intent"],
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_eval_feedback",
    description: "MANDATORY after every unbrowse_breath_execute where results were shown to the user. Submit quality feedback so the marketplace learns which endpoints work.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill id." },
        endpoint: { type: "string", description: "Endpoint id." },
        rating: { type: "number", description: "1-5 rating. 5=right+fast, 1=useless." },
        outcome: { type: "string", description: "Optional outcome label such as success or wrong_endpoint." },
        diagnostics: { type: "object", description: "Optional structured diagnostics payload." },
      },
      required: ["skill", "endpoint", "rating"],
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_eval_reflect",
    description: "Declare the outcome of the user-facing intent you just pursued. Call this once per intent, after you believe the goal is achieved, failed, or partially complete. The substrate uses this signal both to surface slow/broken paths to maintainers AND to update the reliability_score of the skill+endpoint you just executed against (when you pass skill_id+endpoint_id). Anonymous: only the outcome value (and optional hashed notes) are recorded; no transcript text. Skip the call if you are running diagnostics rather than pursuing a user intent.",
    inputSchema: {
      type: "object",
      properties: {
        intent_status: { type: "string", description: "achieved | failed | partial", enum: ["achieved", "failed", "partial"] },
        notes_hash: { type: "string", description: "Optional sha256:16 fingerprint of free-text notes. Hash locally before sending — never raw text." },
        skill_id: { type: "string", description: "Optional. The skill_id you just executed against. When present, the substrate applies a Bayesian-smoothed reliability update to (skill_id, endpoint_id)." },
        endpoint_id: { type: "string", description: "Optional. The endpoint_id you just executed against. Required together with skill_id for reliability attribution." },
      },
      required: ["intent_status"],
      additionalProperties: false,
    },
  },
  {
    name: "unbrowse_build_index",
    description: "Recompute the local graph, workflow contracts, and sanitized workflow export for a cached skill without remote marketplace share.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill id to re-index locally." },
      },
      required: ["skill"],
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_build_review",
    description: "Describe each captured endpoint (description, action_kind, resource_kind) before the skill leaves your machine. Stamps reviewed_at on the skill (provenance that a real review happened; with auto_review=false it is also the publish gate). You are opted in by default; after review: skill auto-publishes to the public Unbrowse marketplace and earns x402 rewards when other agents execute it. Rewards land in your wallet - pair one via `unbrowse setup` if needed. To stay private instead, call unbrowse_eval_settings with share_pointers=false BEFORE you review (with auto_review=false, any unreviewed capture is held locally; with the default auto_review=true, captures publish without a reviewed_at stamp).",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill id to review." },
        endpoints: {
          type: "array",
          description: "Endpoint review payloads.",
          items: {
            type: "object",
            properties: {
              endpoint_id: { type: "string", description: "Endpoint id to review." },
              description: { type: "string", description: "Reviewed human description of what the endpoint returns and key constraints." },
              action_kind: { type: "string", description: "Reviewed action kind, e.g. search/detail/create/list." },
              resource_kind: { type: "string", description: "Reviewed resource kind, e.g. book/post/order." },
              parameter_reviews: {
                type: "array",
                description: "Optional request parameter schema review entries.",
                items: {
                  type: "object",
                  properties: {
                    location: { type: "string", description: "One of path/query/body/header." },
                    name: { type: "string", description: "Parameter name." },
                    description: { type: "string", description: "Reviewed parameter description." },
                    type: { type: "string", description: "Reviewed type." },
                    required: { type: "boolean", description: "Whether the parameter is required." },
                    user_supplied: { type: "boolean", description: "Whether the parameter should be user supplied." },
                    format: { type: "string", description: "Optional semantic format, e.g. date." },
                  },
                  additionalProperties: false,
                },
              },
              response_reviews: {
                type: "array",
                description: "Optional response field schema review entries.",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string", description: "Field path, e.g. items[].title." },
                    description: { type: "string", description: "Reviewed field description." },
                    type: { type: "string", description: "Reviewed field type." },
                  },
                  additionalProperties: false,
                },
              },
            },
            required: ["endpoint_id"],
            additionalProperties: false,
          },
        },
      },
      required: ["skill", "endpoints"],
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_build_publish",
    description: "Publish a skill to the marketplace after unbrowse_build_review. Call with only skill first to inspect the publish surface, then call again with reviewed endpoints and confirm_publish=true. Do not skip unbrowse_build_review before publishing.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill id." },
        confirm_publish: { type: "boolean", description: "Explicitly confirm remote share/re-publish. Omit for inspection-only." },
        endpoints: {
          type: "array",
          description: "Optional reviewed endpoint payloads to merge before publish.",
          items: {
            type: "object",
            properties: {
              endpoint_id: { type: "string", description: "Endpoint id to publish/review." },
              description: { type: "string", description: "Reviewed endpoint description." },
              action_kind: { type: "string", description: "Reviewed action kind." },
              resource_kind: { type: "string", description: "Reviewed resource kind." },
              parameter_reviews: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    location: { type: "string", description: "One of path/query/body/header." },
                    name: { type: "string", description: "Parameter name." },
                    description: { type: "string", description: "Reviewed parameter description." },
                    type: { type: "string", description: "Reviewed type." },
                    required: { type: "boolean", description: "Whether the parameter is required." },
                  },
                  additionalProperties: false,
                },
              },
              response_reviews: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string", description: "Field path, e.g. items[].title." },
                    description: { type: "string", description: "Reviewed field description." },
                    type: { type: "string", description: "Reviewed field type." },
                  },
                  additionalProperties: false,
                },
              },
            },
            required: ["endpoint_id"],
            additionalProperties: false,
          },
        },
      },
      required: ["skill"],
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_publish_suggestions",
    description: "List local skills that have been USED N+ times locally but were never published (no `reviewed_at` and no published publish-artifact). Use to retroactively publish working captures that fell through the review gate — typically existing-user backlog from before `auto_review` defaulted on, or skills captured while `share_pointers=false` was set. Returns evidence (execution_count, success_rate, last_used, most_used_endpoint) so the agent decides whether to apply. Call with `apply=true` and a `skill_ids` array to publish in one shot (no reviewed_at is stamped — that field records an actual unbrowse_build_review). New captures with `auto_review=true` publish automatically and never appear here.",
    inputSchema: {
      type: "object",
      properties: {
        min_executions: {
          type: "number",
          description: "Minimum local execution count to include a skill (default 3). Lower the threshold to surface less-used skills; raise it for higher-confidence batches.",
        },
        min_success_rate: {
          type: "number",
          description: "Minimum local execution success rate (0..1, default 0.7). Skills with mostly-failing traces are excluded so the marketplace doesn't fill with broken endpoints.",
        },
        limit: {
          type: "number",
          description: "Maximum suggestions to return (default 10).",
        },
        apply: {
          type: "boolean",
          description: "When true, the substrate publishes the named skill_ids (without stamping reviewed_at — only unbrowse_build_review sets that). Combine with skill_ids[].",
        },
        skill_ids: {
          type: "array",
          items: { type: "string" },
          description: "Skill IDs to publish when apply=true. Use the skill_id values from a previous suggestions response.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "unbrowse_eval_earnings",
    description: "Show what the calling agent has earned from contributions to the Unbrowse marketplace, and which skills are paying. Aggregates creator payouts (when an agent executes a skill you published) and indexer attribution (delta-based credit for adding new endpoints to a domain). Returns `total_earned_usd`, ledger breakdown (creator vs indexer), recent transactions, and milestone progress (passed_usd, next_usd, progress_to_next_pct). Pass `verbose=true` to also get per-skill contributions sorted by local execution count, so you can see which captures are working hardest. Read-only — exposes data; the calling agent decides whether to surface it to the user.",
    inputSchema: {
      type: "object",
      properties: {
        verbose: {
          type: "boolean",
          description: "When true, include per-skill contribution breakdown with execution counts (slower because it joins local manifests with trace store).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "unbrowse_eval_settings",
  description: "Show or update local marketplace/publish policy. Remote publication is fail-closed: `share_pointers` defaults false and must be explicitly enabled; `auto_review` and checkpoint auto-publish also default false. Local passive capture/indexing remains enabled. Enabling sharing does not replace independent replay validation: remote publish additionally requires lifecycle-issued evidence. Per-domain blacklist/prompt-list rules can further block publication for banking, healthcare, internal, or draft URLs. Returns sponsor status and wallet/reward information.",
    inputSchema: {
      type: "object",
      properties: {
        share_pointers: {
          type: "boolean",
          description: "Public marketplace participation. true (default) = reviewed skills publish publicly and earn x402 rewards; false = private mode, every capture stays local. Flipping false retroactively stops future publishes; already-published skills remain on the marketplace until explicitly retracted.",
        },
        auto_review: {
          type: "boolean",
          description: "Publish captures on close/sync without an explicit `unbrowse_build_review` call (no `reviewed_at` is stamped - that field records an actual review). true (default) = heuristic + LLM-augmented descriptions accepted as-is; false = the agent must call `unbrowse_build_review` before each skill publishes.",
        },
        auto_publish: {
          type: "boolean",
          description: "Whether ready-to-publish skills auto-publish on close/sync (true) or wait for an explicit unbrowse_build_publish call (false). Independent of share_pointers and auto_review - auto_publish=false + share_pointers=true means you publish manually, on your timing.",
        },
        passive_index: {
          type: "boolean",
          description: "Passive parallel indexing. true (default) = the capture → reverse-engineer → index → publish pipeline runs in the background while you browse, so `sync` checkpoints return immediately instead of blocking on the page's late-XHR settle — browsing stays fast and the index grows in parallel. false = run the pipeline inline (each sync waits until the page's endpoints are fully reverse-engineered: slower browse, but every checkpoint's endpoints are complete before it returns).",
        },
        attach_existing_chrome: {
          type: "boolean",
          description: "Browser launch policy. false (default) = never touch your real Chrome; launch a clean managed headless Chrome instead. true = explicitly opt into attaching to your already-running Chrome on the CDP port when possible, so one pipeline can capture tabs any agent opens. Keep false on shared machines, automated/CI gate runs, or privacy-sensitive work. Persisted to config.json; KURI_DISABLE_CDP_ATTACH=1, KURI_CLEAN_ROOM=1, and UNBROWSE_LOCAL_ONLY=1 are per-process overrides that still win.",
        },
        publish_blacklist: {
          type: "array",
          items: { type: "string" },
          description: "Domains that must never publish (e.g. bank.com, *.health.example). Even after review or under auto_review, captures matching these domains stay local. Sensitive-domain protection.",
        },
        publish_promptlist: {
          type: "array",
          items: { type: "string" },
          description: "Domains that pause auto-publish and require an explicit unbrowse_build_publish call to share.",
        },
        clear_publish_blacklist: { type: "boolean", description: "Clear the current publish blacklist." },
        clear_publish_promptlist: { type: "boolean", description: "Clear the current publish prompt-list." },
        mutation_policy: {
          type: "string",
          enum: ["ask", "deny", "whitelist"],
          description: "Mutation safety mode. ask (default) returns a user-confirmation request for unwhitelisted writes; deny blocks them; whitelist allows only listed METHOD URL patterns.",
        },
        mutation_whitelist: {
          type: "array",
          items: { type: "string" },
          description: "Exact or *-patterned mutation rules such as POST https://example.com/api/items. These routes may execute without another prompt.",
        },
      },
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_breath_auth_capture",
    description: "Capture site authentication: opens a Kuri browser tab at the given URL so the user can sign in. Cookies are persisted automatically and used by future unbrowse_eval_resolve / unbrowse_breath_execute calls. Use when a previous call returned auth_required, or pre-emptively before fetching gated content. NOTE: This is NOT for logging into Unbrowse itself - it captures the SITE's auth state.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Login page or gated page URL." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { openWorldHint: true },
  },
  {
    name: "unbrowse_eval_skills",
    description: "List locally available and learned skills from the Unbrowse runtime.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_eval_skill",
    description: "Fetch one skill manifest by skill id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Skill id." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_eval_sessions",
    description: "Read stored session logs for one domain for debugging.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Domain whose sessions you want to inspect." },
        limit: { type: "number", description: "Maximum session records to return. Default 10." },
      },
      required: ["domain"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_breath_navigate",
    description: "Open a live browser tab to browse and index a site. Default mode is headless; the runtime auto-opens a visible Chrome window for sign-in if the page returns auth_required (look for `login_window_opened:true` in the response — then wait for the user to sign in and retry unbrowse_breath_navigate). Only call after unbrowse_eval_resolve returns no_cached_match. Browse the site (snap, click, fill, submit), then call unbrowse_breath_close or unbrowse_breath_sync to index captured traffic. After close/sync, call unbrowse_build_review then unbrowse_build_publish.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target URL to open." },
        session_id: { type: "string", description: "Optional browse session id." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { openWorldHint: true },
  },
  {
    name: "unbrowse_eval_snap",
    description: "Get the current accessibility snapshot with stable element refs like e12. Use during a browse session (after unbrowse_breath_navigate) to see what's on page before interacting. Defaults to detail_level=\"minimal\" (under 1KB); pass \"summary\" for landmark breakdown or \"full\" for the raw tree. Pass session_id from the unbrowse_breath_navigate response when multiple browse sessions are concurrently live (parallel agents); the substrate raises session_id_required if more than one session exists and no id is given.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional snapshot filter, e.g. interactive." },
        session_id: { type: "string", description: "Optional browse session id." },
        detail_level: {
          type: "string",
          enum: ["minimal", "summary", "full"],
          description: "Response verbosity. minimal = root + counts (<1KB). summary = + landmarks + error_state (<8KB). full = raw a11y tree. Default minimal.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_breath_click",
    description: "Click a page element in the active browse session. Prerequisite: call unbrowse_eval_snap first to get @eN refs for clickable elements. Pass the ref (e.g. 'e5') as input.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from unbrowse_eval_snap, e.g. e5." },
        session_id: { type: "string", description: "Optional browse session id." },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_breath_fill",
    description: "Fill an input element with a value in the active browse session. Prerequisite: call unbrowse_eval_snap to get the input's @eN ref. After filling all inputs, call unbrowse_breath_submit (preferred) or unbrowse_breath_click on a submit button.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from unbrowse_eval_snap." },
        value: { type: "string", description: "Value to set." },
        session_id: { type: "string", description: "Optional browse session id." },
      },
      required: ["ref", "value"],
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_breath_type",
    description: "Type text into the currently focused element (sends real key events; triggers React/Vue onChange). Click an input via unbrowse_breath_click first to focus it. Use unbrowse_breath_fill instead when you just want to set a value programmatically.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type." },
        session_id: { type: "string", description: "Optional browse session id." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_breath_press",
    description: "Press a single keyboard key in the active browse session. Common keys: Enter, Tab, Escape, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Backspace, Delete, PageUp, PageDown, Home, End, F1..F12. Use this for navigation and form submission via Enter.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Keyboard key, e.g. Enter or Tab." },
        session_id: { type: "string", description: "Optional browse session id." },
      },
      required: ["key"],
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_breath_select",
    description: "Select an option from a <select> dropdown in the active browse session. Prerequisite: call unbrowse_eval_snap to get the select's @eN ref. The value matches either the option text or value attribute (e.g. 'Premium' or 'premium').",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from unbrowse_eval_snap." },
        value: { type: "string", description: "Option value to select." },
        session_id: { type: "string", description: "Optional browse session id." },
      },
      required: ["ref", "value"],
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_breath_scroll",
    description: "Scroll the current page in the active browse session.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction." },
        amount: { type: "number", description: "Optional scroll amount." },
        session_id: { type: "string", description: "Optional browse session id." },
      },
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_breath_submit",
    description: "Submit the active form during a browse session. After the page settles, continue with unbrowse_eval_snap to see results, then unbrowse_breath_close or unbrowse_breath_sync when done browsing.",
    inputSchema: {
      type: "object",
      properties: {
        form_selector: { type: "string", description: "Optional CSS selector for the form." },
        submit_selector: { type: "string", description: "Optional CSS selector for the submit button." },
        wait_for: { type: "string", description: "Optional URL/path fragment to wait for after submit." },
        assist_site_state: { type: "boolean", description: "Enable site-specific browser-state assist before submit. Default false." },
        same_origin_fetch_fallback: { type: "boolean", description: "Enable fetch+rehydrate fallback. Default false unless explicitly enabled." },
        timeout_ms: { type: "number", description: "Optional submit timeout in milliseconds." },
        session_id: { type: "string", description: "Optional browse session id." },
      },
      additionalProperties: false,
    },
    annotations: { openWorldHint: true },
  },
  {
    name: "unbrowse_eval_screenshot",
    description: "Capture a PNG screenshot of the current browse tab.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string", description: "Optional browse session id." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_eval_text",
    description: "Read the current page text from the active browse session.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string", description: "Optional browse session id." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_eval_markdown",
    description: "Read the current page converted to markdown from the active browse session.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string", description: "Optional browse session id." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_eval_cookies",
    description: "Inspect cookies visible to the current browse tab.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string", description: "Optional browse session id." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_breath_run_js",
    description: "Evaluate JavaScript in the active browse tab. Use sparingly; it can mutate page state.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "JavaScript expression to evaluate." },
        session_id: { type: "string", description: "Optional browse session id." },
      },
      required: ["expression"],
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_breath_sync",
    description: "Checkpoint the current capture and keep the tab open. Local index runs immediately. Marketplace publish is gated on unbrowse_build_review - you are opted in by default, so a reviewed skill publishes to the public marketplace and earns x402 rewards on execution. Rewards land in your wallet - run `unbrowse setup` to pair one if you have not already. Call unbrowse_eval_settings with share_pointers=false to keep this and future captures private.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string", description: "Optional browse session id." } },
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_breath_close",
    description: "Final step of a browse-to-index session. Closes the tab, checkpoints capture, and queues local index. Marketplace publish is gated on unbrowse_build_review - you are opted in by default, so a reviewed skill publishes to the public marketplace and earns x402 rewards on execution. Rewards land in your wallet - run `unbrowse setup` to pair one if you have not already. Call unbrowse_eval_settings with share_pointers=false BEFORE close to keep the capture private.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string", description: "Optional browse session id." } },
      additionalProperties: false,
    },
    annotations: {},
  },
  {
    name: "unbrowse_build_annotate",
    description: "Contribute constraints or best practices for an endpoint. Call this after executing an endpoint to share what you learned (required params, gotchas, tips) with other agents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        skill: { type: "string", description: "Skill ID" },
        endpoint: { type: "string", description: "Endpoint ID" },
        constraints: {
          type: "array",
          description: "Learned constraints (required params, deprecated fields, format rules)",
          items: { type: "object", properties: { param: { type: "string" }, rule: { type: "string" }, message: { type: "string" } }, required: ["param", "rule", "message"] },
        },
        annotations: {
          type: "array",
          description: "Free-text best practices, tips, or gotchas",
          items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
      },
      required: ["skill", "endpoint"],
    },
  },
  {
    name: "unbrowse_diagnose",
    description: "Capture visual + structured context for diagnosing an unbrowse failure. Takes a screenshot of the current page and returns it alongside the current resolve diagnostic. Use when resolve/execute fails and you need to see what the page actually looks like (auth wall, loading spinner, empty state).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional browse session id." },
        context: { type: "string", description: "Description of what was being attempted when it failed." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_eval_trace",
    description: "Get the full execution trace for the most recent resolve/execute call, including diagnostic confidence scores, endpoint scores, and visual context. Use to understand WHY a specific endpoint was or wasn't selected.",
    inputSchema: {
      type: "object",
      properties: {
        trace_id: { type: "string", description: "Optional specific trace ID. Defaults to most recent." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_validate",
    description: "Validate a captured skill's quality by taking screenshots of the page while exercising its endpoints. Helps diagnose if a skill's endpoints actually match the live page. Returns screenshots at key interaction points alongside endpoint response data.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "Skill ID to validate." },
        url: { type: "string", description: "Page URL to validate against." },
      },
      required: ["skill_id"],
      additionalProperties: false,
    },
    annotations: { openWorldHint: true },
  },
  {
    name: "billing_status",
    description: "Returns the caller's Stripe subscription status (plan, quota, current-period usage).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "billing_subscribe_url",
    description: "Returns a Stripe Checkout URL the user can open to subscribe to a paid plan.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "Optional plan id (Stripe price id, or tier shorthand: 'pro' / 'metered' / 'base')." },
        return_url: { type: "string", description: "Optional URL to redirect to after checkout completes." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "billing_portal_url",
    description: "Returns a Stripe customer-portal URL the user can open to manage their subscription.",
    inputSchema: {
      type: "object",
      properties: {
        return_url: { type: "string", description: "Optional URL to redirect to after the portal session ends." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "unbrowse_breath_run",
    description: "DEPRECATED alias for unbrowse_eval_resolve. Call unbrowse_eval_resolve directly. Will be removed in a future release.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "Natural-language task." },
        url: { type: "string", description: "Optional target URL." },
      },
      required: ["intent"],
      additionalProperties: true,
    },
  },
  {
    name: "unbrowse_breath_fetch",
    description: "Removed. Call unbrowse_eval_resolve instead.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target URL." },
      },
      required: ["url"],
      additionalProperties: true,
    },
  },
  {
    name: "unbrowse_eval_auth_inventory",
    description: "Per-domain AST of what the user can already authenticate against, sourced from local browser profile metadata (Chrome + Firefox cookies, history, bookmarks). Read-only; cookie values, history URL paths, and bookmark URLs are NEVER returned — only hostnames, cookie NAMES, integer counts/timestamps, and a likely-logged-in score. Bias the resolve ranker toward logged-in domains BEFORE driving any browser-open path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        domain: { type: "string", description: "Optional domain filter — return inventory for one hostname only." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_eval_spec_discover",
    description: "Probe spec-publishing endpoints (openapi/swagger/sitemap/robots/graphql) for a target site BEFORE the browse-capture-rank dance. If the site publishes its API surface as openapi.json/swagger.json or its URL graph as sitemap.xml, THAT is the ground-truth AST — skip the capture. Pointer-only output: endpoint METADATA (path, method, summary, parameter NAMES + types, response schema KEY NAMES). 3s budget per probe; cross-domain redirects refused; GraphQL introspection opt-in via --graphql.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: { type: "string", description: "Target site — `example.com`, `https://example.com`, or `https://example.com/foo` (path stripped). Required." },
        budget_ms: { type: "number", description: "Per-probe HTTP budget in milliseconds (default 3000)." },
        graphql: { type: "boolean", description: "Opt-in to GraphQL introspection probe (default false)." },
      },
      required: ["target"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "unbrowse_build_skill",
    description: "Register a captured skill manifest (a sequence of endpoints + selectors) into the local route cache so it can be replayed and published.",
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: { type: "string", description: "Natural-language description of what the skill does." },
        skill_id: { type: "string", description: "Optional explicit skill id to register under." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "unbrowse_build_template",
    description: "Declare a reusable fill/exec template binding form selectors to value pointers, so future runs populate fields from a named template.",
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: { type: "string", description: "What the template fills/executes." },
        url: { type: "string", description: "Target URL the template binds against." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "unbrowse_build_publish_bundle",
    description: "Publish a bundle of captured composite endpoints as one marketplace artifact.",
    inputSchema: {
      type: "object" as const,
      properties: {
        skill_id: { type: "string", description: "Skill id whose composite endpoints to bundle and publish." },
        intent: { type: "string", description: "Optional intent describing the bundle." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "unbrowse_build_skill_package",
    description: "Package a captured skill into a distributable, installable skill bundle.",
    inputSchema: {
      type: "object" as const,
      properties: {
        skill_id: { type: "string", description: "Skill id to package." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "unbrowse_build_cleanup_stale",
    description: "Prune stale/expired captured endpoints from the local route cache.",
    inputSchema: {
      type: "object" as const,
      properties: {
        domain: { type: "string", description: "Optional domain to limit the cleanup to." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "unbrowse_breath_fill_form",
    description: "End-to-end form fill: snap the form, enumerate candidates, populate per slot, then resolve and inject every field.",
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: { type: "string", description: "What the form is for / what to submit." },
        session_id: { type: "string", description: "Browse session id to fill within." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "unbrowse_breath_proxy_rotate",
    description: "Rotate the residential proxy session (sticky-IP refresh).",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Optional session id whose proxy to rotate." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "unbrowse_breath_session_park",
    description: "Park the current browse session — same teardown as close, plus persists the pointer-of-pointer chain for a later session-restore.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Session id to park (defaults to the active session)." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "unbrowse_breath_session_restore",
    description: "Restore a previously parked session — read the parked pointer, complete the wallet-signed challenge, spawn or attach to a browser, and rebuild the local session record.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Parked session id to restore." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "unbrowse_breath_get",
    description: "Cache-first one-call fetch by intent. Resolves against the local skill-cache and, on a miss, opens the browser, captures the site's real API calls and indexes them — so a repeat call for the same intent replays the cached endpoint without browsing. The default path for intent-based work.",
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: { type: "string", description: "Natural-language intent for the resource to fetch." },
        url: { type: "string", description: "Optional explicit URL to fetch." },
        header: { type: "string", description: "One HTTP request header as 'Name: value', used only for this read. Secret values are never echoed." },
        bearer_token: { type: "string", description: "Bearer credential used only for this read. The value is never echoed." },
        fresh: { type: "boolean", description: "Bypass cached resolution for this probe." },
        no_cache: { type: "boolean", description: "Alias for fresh; bypass cached resolution for this probe." },
        no_browse: { type: "boolean", description: "Stop on a cache miss instead of opening Chromium." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "unbrowse_breath_capture",
    description: "Drive a browse session to capture a site's internal API routes into the local cache.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to open and capture routes from." },
        intent: { type: "string", description: "Optional intent guiding the capture." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "unbrowse_breath_back",
    description: "Navigate the current session back one entry in history.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Session id to navigate (defaults to the active session)." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "unbrowse_breath_forward",
    description: "Navigate the current session forward one entry in history.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Session id to navigate (defaults to the active session)." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "unbrowse_breath_auth_login",
    description: "Drive an interactive login flow for a target site and bind the session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "Target site to log in to." },
        intent: { type: "string", description: "Optional intent describing the login goal." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "unbrowse_eval_status",
    description: "Current session + server health snapshot.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: true },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_eval_version",
    description: "CLI version + build_sha + walletPubkey + signed release manifest.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: true },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_eval_explain",
    description: "Explain how a given intent would resolve and execute, without acting.",
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: { type: "string", description: "Natural-language intent to explain the resolve/execute plan for." },
      },
      required: ["intent"],
      additionalProperties: true,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_eval_browsers",
    description: "List the installed local browsers available as cookie-import options: name, profile root, last-active time, and whether a cookie DB is present. Metadata only — never cookie values. Use before auth-dependent work to see which browser profiles exist.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_eval_research",
    description: "Research a question through Unbrowse's search, extraction, and grounded synthesis pipeline. Returns the answer with citations and source results.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Question or research query." },
        num_results: { type: "number", description: "Maximum number of source results to ground the answer (default 5)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_eval_extract",
    description: "Extract clean content from one or more URLs through Unbrowse's document-reading path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        urls: { type: "array", description: "URLs to read and extract.", items: { type: "string" } },
      },
      required: ["urls"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_eval_map",
    description: "Map a URL to its outgoing links using Unbrowse's cached document path.",
    inputSchema: {
      type: "object" as const,
      properties: { url: { type: "string", description: "URL whose outgoing links should be mapped." } },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_eval_crawl",
    description: "Crawl a seed URL and a bounded set of same-domain links, returning extracted pages.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "Seed URL to crawl." },
        max_pages: { type: "number", description: "Maximum number of same-domain pages to read (default 5)." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unbrowse_eval_inspect",
    description: "Inspect a captured endpoint's full request/response shape and metadata.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Endpoint id to inspect." },
        intent: { type: "string", description: "Optional intent to resolve an endpoint to inspect." },
      },
      additionalProperties: true,
    },
    annotations: { readOnlyHint: true },
  },
];
