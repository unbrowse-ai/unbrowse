#!/usr/bin/env bun

import { config as loadEnv } from "dotenv";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getInProcessApp } from "./runtime/in-process-app.js";
import { traceAsync } from "./logger.js";
import { listWorkflowPublishArtifacts, readWorkflowPublishArtifact } from "./workflow/publish.js";
import type { WorkflowPublishArtifact, WorkflowPublishRecipe } from "./types/index.js";
import { appendImpact, getImpactLogPath, impactFromResult, readImpactSummary } from "./impact-log.js";
import { recordCreativityActFromExecute } from "./values/creativity-economy.js";
import { getAgentId, getApiKey, getCreatorEarnings, getMyProfile, getTransactionHistory, loadConfig } from "./client/index.js";
import { getSessionLogger, getResolvedTelemetryConfig } from "./telemetry/index.js";
import { reportUsage } from "./telemetry/issue.js";
import { shapeSnapResult, markNewSnapElements, type SnapDetailLevel } from "./api/browse-snap-detail-levels.js";
import { enrichWithImprovementSuggestion } from "./mcp-improvement-suggestion.js";
import { buildGateRefusal } from "./payments/index.js";
import { drainPendingIndexJobs } from "./lib/indexer-core/index.js";
import { drainPendingPassivePublishes } from "./orchestrator/passive-publish.js";
import { reapOwnObscuraSessions } from "./obscura/session-broker.js";
// Acts 2:6 — "every man heard them speak in his own language."
// The v7 kind-map is the translation layer: one row per primitive,
// one verb per surface (CLI / MCP / covenant). MCP tool names hit
// dispatchByKind, which routes by op_kind to the matching v7
// handler (build/breath/eval) and returns a structured result. When
// the v7 handler is not yet wired (W3.1+ waves) or its shape diverges
// from the v6 wire contract, dispatch returns fallback_to_v6 and we
// fall through to the existing handler below.
import { dispatchByKind, findKindEntry, listMcpTools } from "./cli-v7/dispatch/index.js";
import { classifyAuthenticatedPage } from "./auth/index.js";
import type { DispatchResult } from "./cli-v7/dispatch/index.js";
import { AGENT_PATH, DEFAULT_AGENT_MCP_TOOLS, agentMcpPolicy } from "./agent-path.js";

loadEnv({ quiet: true });
loadEnv({ path: ".env.runtime", quiet: true });
// Process identity for stdio MCP. Phase 0d removed the local daemon, but
// MCP_SERVER_MODE still marks this process so inlined CLI code (cmdGet etc.)
// never auto-runs main()/printHelp onto JSON-RPC stdout.
process.env.MCP_SERVER_MODE = process.env.MCP_SERVER_MODE || "1";
process.env.UNBROWSE_RUNTIME_ENTRY = process.env.UNBROWSE_RUNTIME_ENTRY || "mcp";

// MCP stdio stdout is reserved for JSON-RPC frames. The in-process API and
// lower layers still use console.log for human diagnostics, so route those
// messages to stderr in this process before any app construction can emit.
function redirectConsoleDiagnosticsToStderr(): void {
  const render = (values: unknown[]) => values.map((value) => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(" ");
  console.log = (...values: unknown[]) => {
    process.stderr.write(`${render(values)}\n`);
  };
  console.info = (...values: unknown[]) => {
    process.stderr.write(`${render(values)}\n`);
  };
  console.warn = (...values: unknown[]) => {
    process.stderr.write(`${render(values)}\n`);
  };
}

redirectConsoleDiagnosticsToStderr();

const CLIENT_ID = process.env.UNBROWSE_CLIENT_ID || `mcp-${process.pid}`;
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const PREVIEW_LIMIT = 12_000;

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

// Types + data live in the pure schema module so they can be read without
// executing this file (which starts the stdio server at module scope).
import { TOOL_SCHEMAS, type JsonSchema, type JsonSchemaProperty } from "./mcp-tool-schemas.js";
void (null as unknown as JsonSchemaProperty); // referenced by JsonSchema's shape

type ToolResult = {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: Record<string, boolean>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

type ListedTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: Record<string, boolean>;
};

type ResourceDefinition = {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  // Sync resources stay sync; async resources (vault, cookies, history)
  // return a Promise. The dispatcher awaits the result.
  read: () => unknown | Promise<unknown>;
};

type ListedResource = {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
};

type PromptArgument = {
  name: string;
  description?: string;
  required?: boolean;
};

type PromptDefinition = {
  name: string;
  description: string;
  arguments?: PromptArgument[];
  get: (args: Record<string, unknown>) => { description?: string; messages: Array<Record<string, unknown>> };
};

type ListedPrompt = {
  name: string;
  description: string;
  arguments?: PromptArgument[];
};

function writeStdout(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeStderr(message: string): void {
  process.stderr.write(`[unbrowse:mcp] ${message}\n`);
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---[\s\S]*?---\n+/, "").trim();
}

function previewValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > PREVIEW_LIMIT
      ? `${value.slice(0, PREVIEW_LIMIT)}\n...[truncated ${value.length - PREVIEW_LIMIT} chars]`
      : value;
  }

  const rendered = JSON.stringify(
    value,
    (_key, inner) => {
      if (typeof inner === "string" && inner.length > 2_000) {
        return `${inner.slice(0, 240)}...[truncated ${inner.length - 240} chars]`;
      }
      return inner;
    },
    2,
  ) ?? "null";

  return rendered.length > PREVIEW_LIMIT
    ? `${rendered.slice(0, PREVIEW_LIMIT)}\n...[truncated ${rendered.length - PREVIEW_LIMIT} chars]`
    : rendered;
}

export function successResult(value: unknown, summary?: string): ToolResult {
  // Envelope wraps the dieted value with a `content[].text` preview channel
  // and JSON-RPC framing. Reserve headroom so the wire body stays within the
  // cap even after envelope overhead is added.
  const dieted = dietIfOversize(value, WIRE_BUDGET_CHARS - 1024);
  return {
    content: [
      {
        type: "text",
        text: summary ? `${summary}\n\n${previewValue(dieted)}` : previewValue(dieted),
      },
    ],
    structuredContent: dieted,
  };
}

function imageResult(data: string, metadata: Record<string, unknown>): ToolResult {
  return {
    content: [
      {
        type: "image",
        data,
        mimeType: "image/png",
      },
      {
        type: "text",
        text: previewValue(metadata),
      },
    ],
    structuredContent: metadata,
  };
}

function errorResult(message: string, details?: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: details === undefined ? message : `${message}\n\n${previewValue(details)}`,
      },
    ],
    structuredContent: details ?? { error: message },
    isError: true,
  };
}

function textResource(uri: string, value: unknown, mimeType = "application/json"): { uri: string; mimeType: string; text: string } {
  return {
    uri,
    mimeType,
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  };
}

function isErrorToolResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return (result as { isError?: boolean }).isError === true;
}

/**
 * MCP tool name -> op_kind lookup. Built once from KIND_MAP at
 * module load. The 1:1:1 contract: every MCP tool that has a row in
 * the kind-map can dispatch through dispatchByKind to the v7 handler.
 */
import { KIND_MAP as _V7_KIND_MAP } from "./cli-v7/kind-map.js";
const TOOL_TO_KIND: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const entry of _V7_KIND_MAP) {
    if (!entry.mcp_tool) continue;
    m.set(entry.mcp_tool, entry.op_kind);
    // Public packages scrub `breath` → `act` (scripts/scrub-vocab.sh). Accept
    // both names so v7 dispatch still hits after rename or monorepo source.
    if (entry.mcp_tool.includes("_breath_")) {
      m.set(entry.mcp_tool.replaceAll("_breath_", "_act_"), entry.op_kind);
    }
    if (entry.mcp_tool.includes("_act_")) {
      m.set(entry.mcp_tool.replaceAll("_act_", "_breath_"), entry.op_kind);
    }
  }
  return m;
})();
void listMcpTools; void findKindEntry; // export-only consumers (tests use these).

/**
 * v7-dispatch gating. The default is OFF in v6.x — flip the env var
 * to opt the call through dispatchByKind. When ON and the dispatched
 * v7 handler returns a v6-compatible structured result (ok=true OR a
 * structured ok=false envelope), it's wrapped as a ToolResult and
 * returned. When the handler reports `fallback_to_v6` (not yet wired,
 * EX_SOFTWARE), the caller falls through to the v6 handler below.
 *
 *   UNBROWSE_MCP_V7_DISPATCH unset / 1 / true / *  → all tools via v7 (default ON)
 *   UNBROWSE_MCP_V7_DISPATCH=0 / false / off       → v6 only
 *   UNBROWSE_MCP_V7_DISPATCH=tool_a,tool_b         → only listed tools via v7
 */
function v7DispatchEnabledFor(toolName: string): boolean {
  const v = process.env.UNBROWSE_MCP_V7_DISPATCH?.trim();
  if (!v) return true; // default ON
  const lower = v.toLowerCase();
  if (lower === "0" || lower === "false" || lower === "no" || lower === "off") return false;
  if (v === "1" || lower === "true" || v === "*") return true;
  return v.split(",").map((s) => s.trim()).includes(toolName);
}

function dispatchResultToToolResult(r: DispatchResult): ToolResult {
  // Pointer-not-payload: hand the structured JSON straight through as
  // structuredContent + a text preview. Mirrors successResult/errorResult
  // for callers reading either channel.
  const body = r.jsonResult ?? { ok: r.ok, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  if (r.ok) {
    return {
      content: [
        {
          type: "text",
          text: `[v7 dispatch] ${r.subcommand} -> ${r.op_kind}\n\n${previewValue(body)}`,
        },
      ],
      structuredContent: body,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: `[v7 dispatch error] ${r.subcommand} -> ${r.op_kind} (exit ${r.exitCode})\n\n${previewValue(body)}\n\n${r.stderr ?? ""}`,
      },
    ],
    structuredContent: body,
    isError: true,
  };
}

function extractDecisionTrace(result: unknown): unknown {
  if (!result || typeof result !== "object") return undefined;
  const sc = (result as { structuredContent?: unknown }).structuredContent;
  if (!sc || typeof sc !== "object") return undefined;
  const trace = (sc as Record<string, unknown>).decision_trace;
  return Array.isArray(trace) ? trace : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveDotPath(obj: unknown, pathValue: string): unknown {
  let current = obj;
  for (const key of pathValue.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function drillPath(data: unknown, pathValue: string): unknown {
  const segments = pathValue.split(/\./).flatMap((segment) => {
    const match = segment.match(/^(.+)\[\]$/);
    return match ? [match[1], "[]"] : [segment];
  });

  let values: unknown[] = [data];
  for (const segment of segments) {
    if (values.length === 0) return [];
    if (segment === "[]") {
      values = values.flatMap((value) => Array.isArray(value) ? value : [value]);
      continue;
    }

    values = values.flatMap((value) => {
      if (value == null) return [];
      if (Array.isArray(value)) {
        return value
          .map((item) => (item as Record<string, unknown>)?.[segment])
          .filter((item) => item !== undefined);
      }
      if (typeof value === "object") {
        const item = (value as Record<string, unknown>)[segment];
        return item !== undefined ? [item] : [];
      }
      return [];
    });
  }

  return values;
}

function applyExtract(items: unknown[], extractSpec: string): unknown[] {
  const fields = extractSpec.split(",").map((field) => {
    const colon = field.indexOf(":");
    if (colon > 0) return { alias: field.slice(0, colon), path: field.slice(colon + 1) };
    return { alias: field, path: field };
  });

  return items
    .map((item) => {
      const row: Record<string, unknown> = {};
      let hasValue = false;
      for (const { alias, path: dotPath } of fields) {
        const value = resolveDotPath(item, dotPath);
        row[alias] = value ?? null;
        if (value != null) hasValue = true;
      }
      return hasValue ? row : null;
    })
    .filter((item): item is Record<string, unknown> => item !== null);
}

function schemaOf(value: unknown, depth = 4): unknown {
  if (value == null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return ["unknown"];
    return [schemaOf(value[0], depth - 1)];
  }
  if (typeof value === "object") {
    if (depth <= 0) return "object";
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = schemaOf(inner, depth - 1);
    }
    return out;
  }
  return typeof value;
}

function validateProperty(name: string, schema: JsonSchemaProperty, value: unknown, errors: string[]): void {
  if (value === undefined) return;

  switch (schema.type) {
    case "string":
      if (typeof value !== "string") errors.push(`${name} must be a string`);
      else if (schema.enum && !schema.enum.includes(value)) errors.push(`${name} must be one of: ${schema.enum.join(", ")}`);
      return;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) errors.push(`${name} must be a number`);
      return;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${name} must be a boolean`);
      return;
    case "array":
      if (!Array.isArray(value)) errors.push(`${name} must be an array`);
      return;
    case "object":
      if (!isPlainObject(value)) errors.push(`${name} must be an object`);
      return;
    default:
      return;
  }
}

function validateArguments(schema: JsonSchema, args: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const required = new Set(schema.required ?? []);
  const properties = schema.properties ?? {};

  for (const key of required) {
    if (args[key] === undefined) errors.push(`${key} is required`);
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in properties)) errors.push(`unknown argument: ${key}`);
    }
  }

  for (const [key, property] of Object.entries(properties)) {
    validateProperty(key, property, args[key], errors);
  }

  return errors;
}

function skillIdFromWorkflowExportPath(entry: string): string | null {
  const base = path.basename(entry);
  return base.endsWith(".json") ? base.slice(0, -".json".length) : null;
}

function summarizeWorkflowRecipe(artifact: WorkflowPublishArtifact, recipe: WorkflowPublishRecipe): Record<string, unknown> {
  return {
    skill_id: artifact.skill_id,
    domain: artifact.domain,
    intent_signature: artifact.intent_signature,
    endpoint_id: recipe.endpoint_id,
    operation_id: recipe.operation_id ?? null,
    preferred: recipe.preferred,
    provenance_backed: recipe.provenance_backed,
    last_successful_strategy: recipe.last_successful_strategy ?? null,
    usage_notes: recipe.usage_notes,
    mutation_guard: recipe.mutation_guard,
    token_bindings: recipe.token_bindings,
    replay_contract: recipe.replay_contract,
  };
}

function buildWorkflowDagView(artifact: WorkflowPublishArtifact, recipe: WorkflowPublishRecipe): Record<string, unknown> {
  return {
    skill_id: artifact.skill_id,
    domain: artifact.domain,
    intent_signature: artifact.intent_signature,
    endpoint_id: recipe.endpoint_id,
    operation_id: recipe.operation_id ?? null,
    preferred: recipe.preferred,
    steps: recipe.steps,
    dependency_bindings: recipe.replay_contract.dependency_bindings,
    search_terms: recipe.replay_contract.search_terms,
    prerequisite_specs: recipe.replay_contract.prerequisite_specs,
    next_state: recipe.replay_contract.next_state,
    token_bindings: recipe.token_bindings,
  };
}

function listWorkflowResources(): ResourceDefinition[] {
  const resources: ResourceDefinition[] = [];
  for (const exportPath of listWorkflowPublishArtifacts()) {
    const skillId = skillIdFromWorkflowExportPath(exportPath);
    if (!skillId) continue;
    const artifact = readWorkflowPublishArtifact(skillId);
    if (!artifact) continue;

    const publishUri = `workflow_publish://${artifact.skill_id}`;
    resources.push({
      uri: publishUri,
      name: `Workflow Publish Artifact: ${artifact.skill_id}`,
      description: `Indexed/published workflow export summary for ${artifact.domain}.`,
      mimeType: "application/json",
      read: () => artifact,
    });

    for (const recipe of artifact.recipes) {
      const contractUri = `workflow_contract://${artifact.skill_id}/${recipe.endpoint_id}`;
      resources.push({
        uri: contractUri,
        name: `Workflow Contract: ${artifact.skill_id}/${recipe.endpoint_id}`,
        description: `Typed replay contract, x402/payment requirements, restrictions, and usage notes for ${recipe.endpoint_id}.`,
        mimeType: "application/json",
        read: () => summarizeWorkflowRecipe(artifact, recipe),
      });

      const dagUri = `workflow_dag://${artifact.skill_id}/${recipe.endpoint_id}`;
      resources.push({
        uri: dagUri,
        name: `Workflow DAG: ${artifact.skill_id}/${recipe.endpoint_id}`,
        description: `Dependency-oriented workflow graph view for ${recipe.endpoint_id}.`,
        mimeType: "application/json",
        read: () => buildWorkflowDagView(artifact, recipe),
      });
    }
  }
  return resources;
}

function listStatsResources(): ResourceDefinition[] {
  // Surfaces the impact-log aggregate so MCP clients can read "how much
  // wall-clock time and how many LLM tokens has unbrowse saved this agent
  // vs the browser baseline" without calling a tool. Two views project
  // the relevant fields from the same `readImpactSummary()` call — the
  // log read is cheap (rotated JSONL, single pass) so we don't memoize.
  // Source path is included so the agent can audit / inspect the raw log
  // if it wants to. Empty log returns zeros, never an error.
  return [
    {
      uri: "unbrowse://stats/time-saved",
      name: "Time Saved (Unbrowse)",
      description: "Total wall-clock time the unbrowse client has saved this agent vs the browser baseline, aggregated from the local impact log. Includes total milliseconds + rolled-up seconds/minutes, average percent saved per call, run counts (total / successful / browser-avoided), date range of the log, and the source path for audit.",
      mimeType: "application/json",
      read: () => {
        const s = readImpactSummary();
        return {
          total_time_saved_ms: s.total_time_saved_ms,
          total_time_saved_seconds: Math.round(s.total_time_saved_ms / 1000),
          total_time_saved_minutes: Math.round(s.total_time_saved_ms / 60000),
          avg_time_saved_pct: s.avg_time_saved_pct,
          total_runs: s.total_runs,
          successful_runs: s.successful_runs,
          browser_avoided_runs: s.browser_avoided_runs,
          first_entry_at: s.first_entry_at,
          last_entry_at: s.last_entry_at,
          source_path: getImpactLogPath(),
        };
      },
    },
    {
      uri: "unbrowse://stats/tokens-saved",
      name: "Tokens Saved (Unbrowse)",
      description: "Total LLM tokens the unbrowse client has saved this agent by returning structured JSON instead of raw scraped HTML, aggregated from the local impact log. Includes total tokens saved, average percent saved per call, run counts, date range, and the source path for audit.",
      mimeType: "application/json",
      read: () => {
        const s = readImpactSummary();
        return {
          total_tokens_saved: s.total_tokens_saved,
          avg_tokens_saved_pct: s.avg_tokens_saved_pct,
          total_runs: s.total_runs,
          successful_runs: s.successful_runs,
          first_entry_at: s.first_entry_at,
          last_entry_at: s.last_entry_at,
          source_path: getImpactLogPath(),
        };
      },
    },
  ];
}

function listUserContextResources(): ResourceDefinition[] {
  // Surfaces user-context state — auth profiles, browser cookies, browser
  // history, and active browse sessions — so calling agents can route
  // BEFORE invoking resolve/go. The substrate uses this state internally
  // at capture time; exposing it as resources lets the calling LLM make
  // the routing decision instead of the substrate guessing.
  //
  // Privacy: never returns cookie values, header values, page contents,
  // or page URLs (browser-history surfaces eTLD+1 only, opt-in via
  // UNBROWSE_EXPOSE_HISTORY). See
  // .claude/expose-unbrowse-mcp-resources-auth-profiles-brow/references/design.md
  return [
    {
      uri: "unbrowse://auth/profiles",
      name: "Saved Auth Profiles",
      description:
        "Domains for which unbrowse has a saved Keychain auth profile (cookies + headers). Returns metadata only — never returns secrets. Use this to decide whether to expect a cookied capture path or to suggest interactiveLogin to the user.",
      mimeType: "application/json",
      read: async () => {
        const { listVaultKeys } = await import("./vault/index.js");
        const keys = await listVaultKeys("auth:");
        const profiles: Array<{
          domain: string;
          stored_at: string | null;
          expires_at: string | null;
          account_key: string;
        }> = [];
        for (const k of keys) {
          // account key shape: `auth:<domain>` per src/auth/index.ts
          const domain = k.account.startsWith("auth:") ? k.account.slice(5) : k.account;
          profiles.push({
            domain,
            stored_at: k.stored_at,
            expires_at: k.expires_at,
            account_key: k.account,
          });
        }
        profiles.sort((a, b) => a.domain.localeCompare(b.domain));
        return {
          count: profiles.length,
          profiles,
          source: "vault://unbrowse (keychain or ~/.unbrowse/vault/credentials.enc)",
        };
      },
    },
    {
      uri: "unbrowse://cookies/domains",
      name: "Browser Cookie Domains",
      description:
        "Domains for which the user has live browser session cookies (Chrome/Arc/Brave/Edge/Vivaldi/Opera/Dia/Chromium/Firefox). Returns domain + cookie counts + recency — never returns cookie values. Use this to decide whether to inject browser cookies during capture or route through a fresh-login flow.",
      mimeType: "application/json",
      read: async () => {
        const { listCookieDomains } = await import("./auth/browser-cookies.js");
        return listCookieDomains();
      },
    },
    {
      uri: "unbrowse://browser-history/recent",
      name: "Recent Browser History (eTLD+1)",
      description:
        "Distinct eTLD+1 domains the user visited in the last 7 days, with visit counts. Default OFF — set UNBROWSE_EXPOSE_HISTORY=1 to enable. When enabled, only domain + visit count + last-visit timestamp surface; subdomains, paths, and queries are stripped by construction. Use this to disambiguate user intent (e.g. resolve 'reddit' → user actually visits these subdomains).",
      mimeType: "application/json",
      read: async () => {
        const enabled = process.env.UNBROWSE_EXPOSE_HISTORY === "1" ||
          process.env.UNBROWSE_EXPOSE_HISTORY === "true";
        if (!enabled) {
          return {
            enabled: false,
            hint: "Set UNBROWSE_EXPOSE_HISTORY=1 to enable browser-history exposure. Resource is privacy-gated.",
            redaction_rule: "eTLD+1 only when enabled; subdomain/path/query never surface",
          };
        }
        const { listRecentDomains } = await import("./auth/browser-history.js");
        return { enabled: true, ...listRecentDomains({ sinceDaysAgo: 7 }) };
      },
    },
    {
      uri: "unbrowse://sessions/active",
      name: "Active Browse Sessions",
      description:
        "Currently-open browse sessions tracked by the local unbrowse server (session id, tab id, domain, url, broker port, age). Use this to avoid opening a new browser session when one is already pointed at the target domain.",
      mimeType: "application/json",
      read: async () => {
        const { readActiveSessions, sessionStorePath } = await import("./api/session-store.js");
        const sessions = readActiveSessions();
        const now = Date.now();
        return {
          count: sessions.length,
          sessions: sessions.map((s) => ({
            session_id: s.sessionId,
            tab_id: s.tabId,
            domain: s.domain,
            url: s.url,
            har_active: s.harActive,
            broker_port: s.brokerPort ?? null,
            opened_at: new Date(s.ts).toISOString(),
            age_seconds: Math.max(0, Math.round((now - s.ts) / 1000)),
          })),
          source_path: sessionStorePath(),
        };
      },
    },
  ];
}

function listSetupResources(): ResourceDefinition[] {
  // Surfaces unbrowse setup state as MCP Resources so an agent that
  // connects FIRST (before the user has run `unbrowse setup` or before
  // the agent has any context) can read the resource and route accordingly.
  //
  // Two resources:
  //   unbrowse://setup/status  - read-only snapshot: registered? key? skill installed? Kuri present?
  //   unbrowse://setup/guide   - the agent-readable instructions for what to do next
  //
  // Both are READ-ONLY. They never mutate config, never run setup, never
  // touch the network. Setup as a TOOL still exists; the resources are the
  // companion read surface so an agent can detect setup state before the
  // user runs anything.
  return [
    {
      uri: "unbrowse://setup/status",
      name: "Unbrowse Setup Status",
      description:
        "Read-only snapshot of the local unbrowse setup state: agent_id presence, API key configuration (boolean only, never the key), Kuri browser engine binary presence, and Agent Skill install status. Setup does not write MCP host configs. Use this resource BEFORE invoking the setup tool to detect whether setup is needed. Returns JSON; no secrets ever surface.",
      mimeType: "application/json",
      read: async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const os = await import("node:os");

        let agent_id: string | null = null;
        let api_key_configured = false;
        const configPath = path.join(os.homedir(), ".unbrowse", "config.json");
        try {
          if (fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, "utf8");
            const cfg = JSON.parse(raw) as { agent_id?: string; api_key?: string };
            if (typeof cfg.agent_id === "string" && cfg.agent_id.length > 0) {
              agent_id = cfg.agent_id;
            }
            if (typeof cfg.api_key === "string" && cfg.api_key.length > 0) {
              api_key_configured = true;
            }
          }
        } catch {
          // best-effort; resource never throws
        }

        let kuri_binary_present = false;
        const kuriPaths = [
          path.join(os.homedir(), ".unbrowse", "bin", "kuri"),
          path.join(os.homedir(), ".kuri", "bin", "kuri"),
        ];
        for (const p of kuriPaths) {
          try {
            if (fs.existsSync(p)) {
              kuri_binary_present = true;
              break;
            }
          } catch {
            // ignore
          }
        }

        let claude_mcp_registered = false;
        const claudePath = path.join(os.homedir(), ".claude.json");
        try {
          if (fs.existsSync(claudePath)) {
            const raw = fs.readFileSync(claudePath, "utf8");
            claude_mcp_registered = raw.includes('"unbrowse"');
          }
        } catch {
          // best-effort
        }

        // Live probe: if an api_key is configured, test it against the
        // deployed sponsor-status endpoint. Surfaces post-2026-05-18 key
        // rotation (every pre-rotation key returns 403 INVALID_KEY) so the
        // agent reading this Resource knows to nudge `unbrowse setup` for a
        // fresh key. Substrate-faithful: probe collects status_code +
        // response_excerpt; agent judges. Best-effort: a network failure
        // never throws here. 3s timeout to keep the read fast.
        let key_probe: {
          status_code: number | null;
          rotation_required: boolean;
          excerpt: string;
        } = { status_code: null, rotation_required: false, excerpt: "" };
        if (api_key_configured) {
          try {
            let api_key = "";
            try {
              const raw = fs.readFileSync(configPath, "utf8");
              const cfg = JSON.parse(raw) as { api_key?: string };
              api_key = cfg.api_key ?? "";
            } catch {
              // already handled above; keep api_key empty
            }
            if (api_key) {
              const controller = new AbortController();
              const t = setTimeout(() => controller.abort(), 3000);
              const apiBase = process.env.UNBROWSE_API_URL ?? "https://beta-api.unbrowse.ai";
              try {
                const res = await fetch(`${apiBase}/v1/account/sponsor-status`, {
                  headers: { Authorization: `Bearer ${api_key}` },
                  signal: controller.signal,
                });
                clearTimeout(t);
                const body = await res.text();
                key_probe = {
                  status_code: res.status,
                  rotation_required: res.status === 403 && (body.includes("INVALID_KEY") || body.includes("all_keys_rotated")),
                  excerpt: body.slice(0, 240),
                };
              } catch {
                clearTimeout(t);
                // network/abort error; leave defaults
              }
            }
          } catch {
            // best-effort
          }
        }

        const setup_required = !agent_id || !kuri_binary_present || key_probe.rotation_required;
        let next_action: string;
        if (key_probe.rotation_required) {
          next_action = "Local API key was rotated server-side (2026-05-18 security rotation). Run `unbrowse setup` to mint a fresh key. Old key is in " + configPath + " and returns " + key_probe.status_code + " from beta-api.";
        } else if (setup_required) {
          next_action = "Run `unbrowse setup` to register the agent and install the Kuri browser engine.";
        } else {
          next_action = "Setup complete. Try `unbrowse resolve --intent <X> --url <Y>` or call the resolve tool.";
        }
        return {
          setup_required,
          agent_id_present: Boolean(agent_id),
          api_key_configured,
          kuri_binary_present,
          claude_mcp_registered,
          key_probe,
          config_path: configPath,
          next_action,
          // Website nudges: CLI/MCP is for agent-shaped automation; the
          // human-shaped flow (sign in, mint key, copy-paste install,
          // manage credits) is better on the web. Agent reads this surface
          // when deciding whether to send the user to the browser.
          website_install: "https://unbrowse.ai/install",
          website_dashboard: "https://unbrowse.ai/dashboard",
          website_how_pays: "https://unbrowse.ai/how-unbrowse-pays",
          read_at: new Date().toISOString(),
        };
      },
    },
    {
      uri: "unbrowse://setup/guide",
      name: "Unbrowse Setup Guide",
      description:
        "Agent-readable guide for the unbrowse setup flow. Returns markdown describing the recommended setup sequence: install via npm, run unbrowse setup, then call resolve/execute or use the MCP tools. Read this resource when the agent needs to explain setup to a user or decide which tool to call next.",
      mimeType: "text/markdown",
      read: async () => {
        return [
          "# Unbrowse setup guide",
          "",
          "Unbrowse is the agent browser. Setup is one command; everything after",
          "is calling the Agent Skill / `unbrowse` CLI. This MCP server is",
          "legacy/manual-only for hosts that still require stdio tools.",
          "",
          "## 1. Easy mode: install via the website (recommended)",
          "",
          "Visit **https://unbrowse.ai/install** — sign in once with email,",
          "the page bakes your API key into a one-line copy-paste CLI install.",
          "Fewer terminal steps; the page also",
          "shows your earnings dashboard alongside the install command.",
          "",
          "## 2. CLI install",
          "",
          "```bash",
          "npm i -g unbrowse",
          "```",
          "",
          "The CLI includes a vendored Kuri browser engine (Zig binary, ~464KB).",
          "No Chrome install required.",
          "",
          "## 3. Setup",
          "",
          "```bash",
          "unbrowse setup",
          "```",
          "",
          "Idempotent: registers an agent_id, installs/updates Kuri, installs",
          "the Agent Skill, and writes the `/unbrowse` Open Code command if",
          "Open Code is installed. Setup does not write MCP host configs.",
          "Re-running is safe.",
          "",
          "**Identity ladder (wallet-first, email optional):**",
          "- L1 (default): `unbrowse setup` mints an anonymous agent_id without",
          "  requiring email. Free quota applies; routes you index attribute to",
          "  this agent_id and earnings accrue but stay un-payable until you",
          "  attach a wallet.",
          "- L2: attach a Solana wallet (Phantom/Backpack via lobster-cli or",
          "  the dashboard) to claim earnings.",
          "- L3: attach an email via the magic-link flow for human-readable",
          "  identity and recovery. Optional.",
          "- L4: mint a named API key for headless deployment via",
          "  POST /v1/account/keys (after L3 email-bound account).",
          "",
          "## 4. Verify",
          "",
          "Read `unbrowse://setup/status` (this resource's sibling). When",
          "`setup_required: false`, the next action is one of:",
          "",
          "- `resolve` tool: discover routes for a user intent",
          "- `execute` tool: call a previously-discovered route",
          "- `go` + `snap` tools: drive a browser session for live capture",
          "",
          "## 5. Payments + earnings",
          "",
          "- **Free quota**: first ~$1/day per agent + ~$50/day platform-wide is",
          "  sponsored from the Lewis wallet (x402 sponsor middleware).",
          "- **Beyond sponsor cap**: add credits at https://unbrowse.ai/dashboard.",
          "  Pay by card (invisible x402 onramp; the API key abstracts the funding",
          "  source) OR attach your own x402 wallet for self-funded calls.",
          "- **Earnings**: when routes you indexed get reused, earnings settle to",
          "  your attached wallet (L2). Without a wallet attached they accrue but",
          "  stay unclaimed.",
          "",
          "## Reference (web surfaces — preferred for human-shaped flows)",
          "",
          "- https://unbrowse.ai/install — one-click MCP install with your key",
          "- https://unbrowse.ai/dashboard — earnings, credits, key management",
          "- https://unbrowse.ai/how-unbrowse-pays — payment ladder explained",
          "- https://unbrowse.ai/docs — full documentation",
          "- Read `unbrowse://docs/*` resources for in-protocol versions.",
        ].join("\n");
      },
    },
  ];
}

function listDocsResources(): ResourceDefinition[] {
  // Self-aware MCP: surface the canonical unbrowse docs as MCP Resources so
  // any agent connecting via stdio JSON-RPC can READ the architecture,
  // payment ladder, mcp workflow guide, earnings model, etc. without
  // leaving the protocol. Closes the "agents don't see Pay ladder via MCP"
  // gap surfaced by the validate-the-unbrowse-mcp-agent-experience-end-t
  // harness wave 1.
  //
  // Reads are LIVE from disk on each request — docs stay in sync with the
  // installed package. CHANGELOG is too large to surface whole; tail-200
  // gives the recent releases the agent usually wants.
  return [
    {
      uri: "unbrowse://docs/index",
      name: "Unbrowse Docs Index",
      description:
        "Canonical list of unbrowse documentation Resources available via MCP. Use this to discover which docs exist (architecture, payments, mcp workflow, earnings, etc.) before reading any specific one. JSON list with uri + title + size_bytes per doc.",
      mimeType: "application/json",
      read: async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const pkgRoot = getPackageRoot();
        const docs = [
          { uri: "unbrowse://docs/readme",       title: "README",                   rel: "README.md" },
          { uri: "unbrowse://docs/changelog",    title: "CHANGELOG (recent tail)",  rel: "CHANGELOG.md" },
          { uri: "unbrowse://docs/payments",     title: "How Unbrowse Pays",        rel: "docs/HOW_UNBROWSE_PAYS.md" },
          { uri: "unbrowse://docs/mcp-workflow", title: "MCP Workflow Guide",       rel: "docs/mcp-workflow-guide.md" },
          { uri: "unbrowse://docs/earnings",     title: "Earn As Indexer",          rel: "docs/EARN_AS_INDEXER.md" },
          { uri: "unbrowse://docs/docs-index",   title: "Docs Tree Index",          rel: "docs/README.md" },
        ];
        const entries: Array<Record<string, unknown>> = [];
        for (const d of docs) {
          const p = path.join(pkgRoot ?? process.cwd(), d.rel);
          let size_bytes = 0;
          try {
            if (fs.existsSync(p)) {
              size_bytes = fs.statSync(p).size;
            }
          } catch {
            // best-effort
          }
          entries.push({ uri: d.uri, title: d.title, source_path: d.rel, size_bytes, exists: size_bytes > 0 });
        }
        return {
          docs: entries,
          generated_at: new Date().toISOString(),
          note: "Read any individual doc by calling resources/read with the listed uri. CHANGELOG returns the most recent ~200 lines (the full file is 4000+ lines and exceeds a reasonable single-Resource payload).",
        };
      },
    },
    {
      uri: "unbrowse://docs/readme",
      name: "Unbrowse README",
      description:
        "The canonical top-level unbrowse README. Read this when the agent needs to explain what unbrowse IS, what it does, and how a new user starts. Live-read from disk; matches the installed package.",
      mimeType: "text/markdown",
      read: async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const pkgRoot = getPackageRoot();
        const p = path.join(pkgRoot ?? process.cwd(), "README.md");
        try {
          return fs.readFileSync(p, "utf8");
        } catch {
          return "# README\n\n(README.md not found on disk; package may be incomplete)";
        }
      },
    },
    {
      uri: "unbrowse://docs/changelog",
      name: "Unbrowse CHANGELOG (recent tail)",
      description:
        "Most recent ~200 lines of CHANGELOG.md (the full file is too large for a single Resource). Read this when the agent needs to know what shipped in the most recent versions or to debug a regression by recent change.",
      mimeType: "text/markdown",
      read: async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const pkgRoot = getPackageRoot();
        const p = path.join(pkgRoot ?? process.cwd(), "CHANGELOG.md");
        try {
          const raw = fs.readFileSync(p, "utf8");
          const lines = raw.split("\n");
          const tail = lines.slice(0, 200).join("\n");
          return `${tail}\n\n... (CHANGELOG truncated to first 200 lines; full file is ${lines.length} lines on disk)`;
        } catch {
          return "# CHANGELOG\n\n(CHANGELOG.md not found on disk)";
        }
      },
    },
    {
      uri: "unbrowse://docs/payments",
      name: "How Unbrowse Pays (payment ladder)",
      description:
        "The canonical doc on the unbrowse payment surface: free quota, sponsor subsidy (x402 middleware, $1/day/agent + $50/day/platform via Lewis wallet), agent x402 wallet fallback, and Pay (pay.sh) TouchID-gated paid API calls for tasks outside unbrowse. READ THIS when the agent hits a paywall, sees a 402 response, or needs to explain billing to a user. Closes the 'agents don't see the Pay ladder via MCP' gap.",
      mimeType: "text/markdown",
      read: async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const pkgRoot = getPackageRoot();
        const p = path.join(pkgRoot ?? process.cwd(), "docs/HOW_UNBROWSE_PAYS.md");
        try {
          return fs.readFileSync(p, "utf8");
        } catch {
          return "# How Unbrowse Pays\n\n(docs/HOW_UNBROWSE_PAYS.md not found on disk)";
        }
      },
    },
    {
      uri: "unbrowse://docs/mcp-workflow",
      name: "MCP Workflow Guide (self-aware reference)",
      description:
        "The step-by-step tool-call sequence guide for callers using unbrowse via MCP. Three intent classes (cached / cold-browse-publish / URL-contents). Every tool referenced with src/mcp.ts:LINE cites. Read this to know which MCP tool to call next for any user intent.",
      mimeType: "text/markdown",
      read: async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const pkgRoot = getPackageRoot();
        const p = path.join(pkgRoot ?? process.cwd(), "docs/mcp-workflow-guide.md");
        try {
          return fs.readFileSync(p, "utf8");
        } catch {
          return "# MCP Workflow Guide\n\n(docs/mcp-workflow-guide.md not found on disk)";
        }
      },
    },
    {
      uri: "unbrowse://docs/earnings",
      name: "Earn As Indexer",
      description:
        "How users earn from routes they index. Read this when explaining the marketplace flywheel or when the agent needs to nudge wallet setup (lobster-cli) after a successful resolve that indexed routes.",
      mimeType: "text/markdown",
      read: async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const pkgRoot = getPackageRoot();
        const p = path.join(pkgRoot ?? process.cwd(), "docs/EARN_AS_INDEXER.md");
        try {
          return fs.readFileSync(p, "utf8");
        } catch {
          return "# Earn As Indexer\n\n(docs/EARN_AS_INDEXER.md not found on disk)";
        }
      },
    },
    {
      uri: "unbrowse://docs/docs-index",
      name: "Docs Tree Index",
      description:
        "Index of the full docs/ tree: concepts, for-agents, for-developers, for-investors, guides, reference. Read this to discover docs not directly surfaced as Resources.",
      mimeType: "text/markdown",
      read: async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const pkgRoot = getPackageRoot();
        const p = path.join(pkgRoot ?? process.cwd(), "docs/README.md");
        try {
          return fs.readFileSync(p, "utf8");
        } catch {
          return "# Docs Index\n\n(docs/README.md not found on disk)";
        }
      },
    },
  ];
}

function listResource(resource: ResourceDefinition): ListedResource {
  return {
    uri: resource.uri,
    name: resource.name,
    description: resource.description,
    mimeType: resource.mimeType,
  };
}

function workflowPromptMessages(args: Record<string, unknown>): { description: string; messages: Array<Record<string, unknown>> } {
  const skillId = typeof args.skill_id === "string" ? args.skill_id : "";
  const artifact = skillId ? readWorkflowPublishArtifact(skillId) : null;
  if (!artifact) {
    return {
      description: "Plan workflow execution from an indexed or published contract.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `No workflow artifact found for ${skillId || "the requested skill"}. Use resolve/skill inspection first, or capture and index/publish the workflow before planning replay.`,
          },
        },
      ],
    };
  }

  const requestedEndpoint = typeof args.endpoint_id === "string" ? args.endpoint_id : undefined;
  const recipe = requestedEndpoint
    ? artifact.recipes.find((entry) => entry.endpoint_id === requestedEndpoint)
    : artifact.recipes.find((entry) => entry.preferred) ?? artifact.recipes[0];
  if (!recipe) {
    return {
      description: "Plan workflow execution from an indexed or published contract.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `No workflow recipe found in indexed/published artifact ${artifact.skill_id}. Inspect workflow_publish://${artifact.skill_id} first.`,
          },
        },
      ],
    };
  }

  const goal = typeof args.intent === "string"
    ? args.intent
    : (typeof args.user_goal === "string" ? args.user_goal : artifact.intent_signature);
  const contract = summarizeWorkflowRecipe(artifact, recipe);
  const dag = buildWorkflowDagView(artifact, recipe);
  return {
    description: `Plan execution for ${artifact.skill_id}/${recipe.endpoint_id}.`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `Goal: ${goal}`,
            "",
            "Use this indexed/published workflow contract and DAG to decide whether to:",
            "1. execute the explicit replay contract directly, or",
            "2. use browser traversal first, then replay later.",
            "",
            "Rules:",
            "- traversal stays browser-native and thin by default",
            "- only opt into assist_site_state when thin submit is insufficient",
            "- trust prerequisite_specs, dependency_bindings, and next_state before deeper calls",
            "- inspect payment_requirement before explicit replay; x402_required means wallet/payment planning first",
            "- do not invent params outside parameter_specs",
            "",
            `Contract resource: workflow_contract://${artifact.skill_id}/${recipe.endpoint_id}`,
            previewValue(contract),
            "",
            `DAG resource: workflow_dag://${artifact.skill_id}/${recipe.endpoint_id}`,
            previewValue(dag),
          ].join("\n"),
        },
      },
    ],
  };
}

// Phase 3 (cheatsheet): workflow recipes that encode multi-step tool
// sequences as injectable templates. Mirrors `workflowPromptMessages`
// shape: { description, messages: [{ role, content: { type:"text", text }}] }.

function resolveExecuteFeedbackRecipe(args: Record<string, unknown>): { description: string; messages: Array<Record<string, unknown>> } {
  const intent = typeof args.intent === "string" ? args.intent : "<the user's intent>";
  const url = typeof args.url === "string" ? args.url : "<optional target url or domain>";
  const text = `Workflow: cached intent → ranked endpoint → execution → feedback.

1. Call unbrowse_eval_resolve with intent="${intent}" and url="${url}".
   - Reads ranked marketplace endpoints (available_endpoints).
   - On status="no_cached_match", switch to workflow:browse-and-publish.
2. Pick the best endpoint from the shortlist by example_response_compact, requires, and yields.
3. Call unbrowse_breath_execute with the chosen { skill, endpoint, params }.
   - The result carries next_action.command === "unbrowse_eval_feedback" with the right { skill, endpoint } in command_args.
4. MANDATORY: call unbrowse_eval_feedback with skill, endpoint, rating (1-5).
   - 5=right+fast, 4=right+slow, 3=incomplete, 2=wrong endpoint, 1=useless.
5. Present the execute result to the user. Do not respond before feedback fires.`;
  return {
    description: "Cached-intent path: resolve → execute → feedback.",
    messages: [{ role: "assistant", content: { type: "text", text } }],
  };
}

function browseAndPublishRecipe(args: Record<string, unknown>): { description: string; messages: Array<Record<string, unknown>> } {
  const intent = typeof args.intent === "string" ? args.intent : "<the user's intent>";
  const url = typeof args.url === "string" ? args.url : "<target page url>";
  const text = `Workflow: cold intent on a new domain → live capture → publish a reusable skill.

1. Confirm unbrowse_eval_resolve returned no_cached_match for intent="${intent}" url="${url}".
2. Call unbrowse_breath_navigate with url="${url}". A live browser tab opens; capture begins passively. (tools/list now expands - new session tools are revealed.)
3. Loop: unbrowse_eval_snap → act (click/fill/type/press/select/scroll/submit) → re-snap. Always act on element refs from the freshest snap.
4. When you have the user's answer, call unbrowse_breath_close (or unbrowse_breath_sync to checkpoint).
   - The result carries next_action.command === "unbrowse_build_review".
5. MANDATORY: call unbrowse_build_review with the skill + endpoints. Write proper descriptions + action_kind/resource_kind. This stamps reviewed_at and (you are opted in by default) auto-publishes to the public marketplace where the skill earns x402 rewards on execution. Rewards land in your wallet - run \`unbrowse setup\` to pair one if you have not already. Call unbrowse_eval_settings with share_pointers=false BEFORE review to keep it private (forfeits rewards).
6. If auto_publish_checkpoints is disabled or you need to inspect the publish surface first, call unbrowse_build_publish twice - first to inspect, then with confirm_publish=true to ship.
7. Present the captured data to the user. Do NOT respond before review fires - heuristic-described skills never reach the marketplace.`;
  return {
    description: "Cold-intent path: go → browse → close → review → publish.",
    messages: [{ role: "assistant", content: { type: "text", text } }],
  };
}

const prompts: PromptDefinition[] = [
  {
    name: "plan_workflow_execution",
    description: "Plan whether to use browser traversal or explicit replay for an indexed/published workflow contract, using its prerequisites, typed params, and dependency graph.",
    arguments: [
      { name: "skill_id", description: "Published skill id.", required: true },
      { name: "endpoint_id", description: "Optional endpoint id. Defaults to the preferred recipe.", required: false },
      { name: "intent", description: "Optional user goal or task phrasing.", required: false },
      { name: "user_goal", description: "Optional alternate wording for the goal.", required: false },
    ],
    get: workflowPromptMessages,
  },
  {
    name: "workflow:resolve-execute-feedback",
    description: "Cached-intent playbook: resolve → pick → execute → feedback. Use for any 'find X on site Y' task when the site has prior coverage.",
    arguments: [
      { name: "intent", description: "The user's natural-language ask.", required: true },
      { name: "url", description: "Target URL or domain hint.", required: false },
    ],
    get: resolveExecuteFeedbackRecipe,
  },
  {
    name: "workflow:browse-and-publish",
    description: "Cold-intent playbook: open a browse session, capture the user's answer, then close + review + publish before responding. Required on first-visit to a new domain.",
    arguments: [
      { name: "intent", description: "The user's natural-language ask.", required: true },
      { name: "url", description: "Target URL.", required: true },
    ],
    get: browseAndPublishRecipe,
  },
];

const promptMap = new Map(prompts.map((prompt) => [prompt.name, prompt]));

function listPrompt(prompt: PromptDefinition): ListedPrompt {
  return {
    name: prompt.name,
    description: prompt.description,
    arguments: prompt.arguments,
  };
}

// Phase 0d: stateless stdio. "Ready" means the in-process Fastify app is
// built (route surface + browse-session rehydrate from disk). There is no
// daemon to spawn, no :6969 to wait on, nothing to respawn.
async function ensureServerReady(): Promise<void> {
  if (process.env.UNBROWSE_MCP_HTTP_BACKEND === "1") return;
  await getInProcessApp();
}

// Retained for call-site compatibility. The in-process app is a stable
// per-stdio-process singleton; there is no disposable daemon to invalidate.
function invalidateServerReady(): void {
  /* no-op: no resident daemon under the stateless model */
}

function getVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.parse(dir).root;
  while (dir !== root) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // keep walking
    }
    dir = path.dirname(dir);
  }
  return "unknown";
}

function getPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (path.basename(dir) === "src" && existsSync(path.join(path.dirname(dir), "package.json"))) {
      return path.dirname(dir);
    }
    try {
      readFileSync(path.join(dir, "package.json"), "utf8");
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  }
  return path.dirname(fileURLToPath(import.meta.url));
}

function loadSkillGuidance(): string {
  try {
    const packageRoot = getPackageRoot();
    return stripFrontmatter(readFileSync(path.join(packageRoot, "SKILL.md"), "utf8"));
  } catch {
    return agentMcpPolicy();
  }
}

const REFLECTION_GUIDANCE = "";
const FULL_SKILL_GUIDANCE = loadSkillGuidance() + REFLECTION_GUIDANCE;
/** Agent-facing policy: one default tool, recovery via next_step only. */
const COMMON_TOOL_POLICY = agentMcpPolicy();

/**
 * Minimal MCP tool surface for agents (default).
 * Full catalog: UNBROWSE_MCP_SURFACE=full
 */
const AGENT_MCP_TOOL_NAMES = new Set<string>(DEFAULT_AGENT_MCP_TOOLS);

/** agent (default) | full — full restores the entire tools[] catalog for operators/tests. */
export function mcpSurfaceMode(): "agent" | "full" {
  const raw = process.env.UNBROWSE_MCP_SURFACE?.trim().toLowerCase();
  if (!raw || raw === "agent" || raw === "minimal" || raw === "simple" || raw === "default") {
    return "agent";
  }
  if (raw === "full" || raw === "all" || raw === "debug" || raw === "operator") {
    return "full";
  }
  return "agent";
}

const TOOL_GUIDANCE_BY_NAME: Record<string, string> = {
  unbrowse_breath_get: `DEFAULT. ${AGENT_PATH.mcp.primary} runs the canonical resolver ladder. On failure, follow only next_step once.`,
  unbrowse_eval_resolve: "Power/debug: list cached routes only. Not required before get.",
  unbrowse_breath_execute: "Power: run skill_id+endpoint_id. Prefer get for ordinary reads.",
  unbrowse_eval_feedback: "After showing results: rating 5..1.",
  unbrowse_build_index: "Operator: recompute local skill graph.",
  unbrowse_build_review: "Operator: review endpoints before publish.",
  unbrowse_build_publish: "Operator: publish to marketplace.",
  unbrowse_eval_settings: "Operator: share_pointers / publish policy.",
  unbrowse_breath_auth_capture: "Only on auth_required: user signs in; then retry get.",
  unbrowse_breath_capture: "Only on miss/next_step capture; then retry get.",
  unbrowse_breath_navigate: "Interaction-only (forms/clicks). Not for ordinary reads — use get.",
  unbrowse_eval_snap: "After navigate: a11y snapshot with @eN refs.",
  unbrowse_breath_submit: "Submit form in browse session; then snap.",
  unbrowse_breath_sync: "Checkpoint browse session; keep tab open.",
  unbrowse_breath_close: "End browse session and index.",
  unbrowse_breath_run_js: "Sparse page eval in browse session.",
  unbrowse_eval_sessions: "Debug: list browse sessions.",
  unbrowse_eval_status: "Health check.",
  unbrowse_diagnose: "When stuck after following next_step once.",
};

function enrichToolDescription(tool: ToolDefinition): string {
  const specific = TOOL_GUIDANCE_BY_NAME[tool.name];
  return [tool.description, COMMON_TOOL_POLICY, specific].filter(Boolean).join("\n\n");
}

function listTool(tool: ToolDefinition): ListedTool {
  return {
    name: tool.name,
    description: enrichToolDescription(tool),
    inputSchema: tool.inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

// Wire-shape size cap. Tool results larger than WIRE_BUDGET_CHARS get walked
// once and every overlong string is truncated with an honest marker. Structural,
// not field-keyed - works for any oversize result, not just the cited ones.
// Audit hook: tests/mcp-payload-size.test.ts.
const WIRE_BUDGET_CHARS = 25_000;
const STRING_TRUNCATE_THRESHOLD = 2_000;
const STRING_TRUNCATE_KEEP = 500;
const ARRAY_MAX_ELEMENTS = 50;

function truncateOversizeStrings(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > STRING_TRUNCATE_THRESHOLD) {
      // Code-point-safe slice - Array.from splits the string into code points
      // so we never sever a surrogate pair mid-emoji. STRING_TRUNCATE_KEEP
      // now counts code points (emoji = 1) rather than UTF-16 code units.
      const chars = Array.from(value);
      const kept = chars.slice(0, STRING_TRUNCATE_KEEP).join("");
      const dropped = value.length - kept.length;
      return `${kept}...[truncated ${dropped} chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(truncateOversizeStrings);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateOversizeStrings(v);
    }
    return out;
  }
  return value;
}

function capOversizeArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    const capped =
      value.length > ARRAY_MAX_ELEMENTS
        ? [
            ...value.slice(0, ARRAY_MAX_ELEMENTS).map(capOversizeArrays),
            { truncated: value.length - ARRAY_MAX_ELEMENTS, unit: "items" },
          ]
        : value.map(capOversizeArrays);
    return capped;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = capOversizeArrays(v);
    }
    return out;
  }
  return value;
}

export function dietIfOversize(value: unknown, budget: number = WIRE_BUDGET_CHARS): unknown {
  const initial = JSON.stringify(value);
  if (!initial || initial.length <= budget) return value;

  // Pass 1: truncate oversize strings.
  let dieted: unknown = truncateOversizeStrings(value);
  let serialized = JSON.stringify(dieted);
  if (serialized && serialized.length <= budget) return dieted;

  // Pass 2: cap oversize arrays (handles huge arrays of small items).
  dieted = capOversizeArrays(dieted);
  serialized = JSON.stringify(dieted);
  if (serialized && serialized.length <= budget) return dieted;
  // Safety net: hard-cut at budget with an honest marker. Never ship oversize.
  // Shrink the body_excerpt until the final wrapped object fits - JSON-escape
  // expansion (quotes, backslashes) means a raw char-budget can still blow up.
  //
  // AC3 from docs/mcp-issues-2026-05-13.md: surface `next_step` and
  // `suggested_limit` so the agent can recover. Without these the agent loses
  // the array entirely and has no concrete value to retry with.
  //
  // Accumulation case (npmjs.com/package/typescript live repro 2026-05-15):
  // when the bulk is many small fields inside a top-level object (not a
  // string, not an array), passes 1+2 are no-ops and the agent is left
  // staring at a truncated body_excerpt with no clue which subtree to drill
  // into. Surface `top_level_keys` mapping each top-level key to its
  // serialized byte size so the agent can pick a `path:` past the heavy
  // field. Only present when the original input is a plain object; omitted
  // for strings/arrays/scalars (no fabrication).
  const safetyText = serialized ?? "";
  const overshootRatio = serialized && serialized.length > 0
    ? Math.min(1, budget / serialized.length)
    : 0;
  const suggestedLimit = Math.max(1, Math.floor(ARRAY_MAX_ELEMENTS * overshootRatio));
  const nextStep = `Response exceeded the ${budget}-char MCP wire budget even after array-cap. Retry with limit:${suggestedLimit} (or smaller), or pass path:"<your-array-path>[]" + extract:"field1,field2" to project before the diet. See top_level_keys for the heaviest subtree.`;
  const topLevelKeys = computeTopLevelKeyByteSizes(value);
  let cutLen = Math.max(0, budget - 512);
  for (let i = 0; i < 10; i++) {
    const candidate: Record<string, unknown> = {
      truncated: true,
      reason: "payload_exceeded_wire_budget_after_diet",
      budget_chars: budget,
      original_chars: initial.length,
      suggested_limit: suggestedLimit,
      next_step: nextStep,
      ...(topLevelKeys ? { top_level_keys: topLevelKeys } : {}),
      body_excerpt: safetyText.slice(0, cutLen),
    };
    const wrapped = JSON.stringify(candidate);
    if (wrapped.length <= budget) return candidate;
    // Overshoot - shrink proportionally and retry.
    cutLen = Math.floor((cutLen * (budget - 200)) / wrapped.length);
    if (cutLen <= 0) break;
  }
  return {
    truncated: true,
    reason: "payload_exceeded_wire_budget_after_diet",
    budget_chars: budget,
    original_chars: initial.length,
    suggested_limit: suggestedLimit,
    next_step: nextStep,
    ...(topLevelKeys ? { top_level_keys: topLevelKeys } : {}),
    body_excerpt: "",
  };
}

// Map each top-level key of a plain object to its serialized byte size.
// Returns null for non-object inputs (no fabrication). Used by the diet
// safety-net so the agent can pick a `path:` past the heaviest subtree.
function computeTopLevelKeyByteSizes(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const serialized = JSON.stringify(v);
    out[k] = serialized ? serialized.length : 0;
  }
  return out;
}

export function maybePostProcessResult(result: Record<string, unknown>, args: Record<string, unknown>): unknown {
  // Day 5 (Creatures): when the caller explicitly projects via path / extract /
  // limit / schema, that projection is authoritative. The diet safety-net must
  // NOT re-truncate the projected output. The diet still runs on un-projected
  // results so oversize raw payloads never escape the 25KB wire budget.
  const callerProjected = (
    typeof args.path === "string" ||
    typeof args.extract === "string" ||
    typeof args.limit === "number" ||
    args.schema === true
  );
  const baseValue = result.result ?? result;

  if (args.schema === true) {
    return dietIfOversize({
      schema_tree: schemaOf(baseValue),
      message: "Use path / extract / limit arguments to shape the response inside Unbrowse.",
    });
  }

  // Truth-telling diagnostics: when a caller-supplied projection yields nothing,
  // surface the actual response shape so the agent can correct the next call
  // without re-fetching to probe. This replaces a silent `result: []` (which
  // looks indistinguishable from "API returned no data") with evidence the
  // path/extract didn't match the real structure.
  let projected: unknown = baseValue;
  let pathDiagnostic: Record<string, unknown> | undefined;
  let extractDiagnostic: Record<string, unknown> | undefined;

  if (typeof args.path === "string") {
    const drilled = drillPath(baseValue, args.path);
    if (Array.isArray(drilled) && drilled.length === 0) {
      pathDiagnostic = {
        message: `path "${args.path}" matched 0 elements (path may be wrong, or the array exists but is empty)`,
        actual_shape: schemaOf(baseValue, 3),
        hint: "Compare actual_shape against your path. Pass schema:true to get the full schema tree.",
      };
    }
    projected = drilled;
  }

  if (typeof args.extract === "string" && Array.isArray(projected)) {
    const sourceLen = projected.length;
    const extracted = applyExtract(projected, args.extract);
    if (sourceLen > 0 && extracted.length === 0) {
      const sample = projected.find((item) => item != null);
      extractDiagnostic = {
        message: `extract "${args.extract}" produced no matching fields across ${sourceLen} items`,
        sample_item_shape: schemaOf(sample, 3),
        hint: "Compare sample_item_shape against your extract field names (use alias:dot.path for nested fields).",
      };
    }
    projected = extracted;
  }

  if (typeof args.limit === "number" && Array.isArray(projected)) {
    projected = projected.slice(0, Math.max(0, args.limit));
  }

  if (callerProjected) {
    const projectedEnvelope = {
      ...(result.trace ? { trace: result.trace } : {}),
      result: projected,
      ...(pathDiagnostic ? { path_diagnostic: pathDiagnostic } : {}),
      ...(extractDiagnostic ? { extract_diagnostic: extractDiagnostic } : {}),
    };
    const dieted = dietIfOversize(projectedEnvelope);
    if (Array.isArray(projected) && isPlainObject(dieted) && dieted.truncated === true) {
      const baseEnvelope = (rows: unknown[]) => ({
        ...(result.trace ? { trace: result.trace } : {}),
        result: rows,
        ...(pathDiagnostic ? { path_diagnostic: pathDiagnostic } : {}),
        ...(extractDiagnostic ? { extract_diagnostic: extractDiagnostic } : {}),
      });
      const projectedBudget = WIRE_BUDGET_CHARS - 2048;
      let lo = 0;
      let hi = projected.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi + 1) / 2);
        if (JSON.stringify(baseEnvelope(projected.slice(0, mid))).length <= projectedBudget) lo = mid;
        else hi = mid - 1;
      }
      const suggestedLimit = Math.max(1, lo);
      return {
        ...dieted,
        suggested_limit: suggestedLimit,
        next_step: `Projected response exceeded the MCP wire budget. Retry this same call with limit:${suggestedLimit} (or smaller).`,
      };
    }
    return dieted;
  }

  // Surface the declared agent decision surface, not internal state.
  // A resolve response carries the full SkillManifest at `skill` (every
  // endpoint's schema + samples) AND the ranked shortlist the agent
  // actually picks from at `available_endpoints`. The manifest is
  // substrate-internal: resolveSkillId / executeResolvedEndpoint already
  // consumed `skill.skill_id` upstream of this function, and skill_id is
  // also on `result.result.skill_id`. Serialized whole it is dead weight
  // that blows the wire budget (live: 91KB skill of a 121KB payload) and,
  // because the diet is string+array-only, drops the agent into a
  // truncated envelope with no shortlist. When both the manifest and the
  // shortlist that supersedes it are present, replace the manifest with
  // its identity so the response fits and the shortlist survives. This is
  // surfacing what is declared, not a hardcoded key-strip: the condition
  // is purely structural (full manifest + the shortlist that obsoletes
  // it) and skill_id is preserved for the agent's next execute call.
  const skillNode = (result as Record<string, unknown>).skill;
  const resultNode = (result as Record<string, unknown>).result;
  const shortlist =
    (Array.isArray((result as Record<string, unknown>).available_endpoints) &&
      (result as Record<string, unknown>).available_endpoints) ||
    (isPlainObject(resultNode) && Array.isArray(resultNode.available_endpoints) &&
      resultNode.available_endpoints) ||
    null;
  if (
    isPlainObject(skillNode) &&
    Array.isArray(skillNode.endpoints) &&
    Array.isArray(shortlist) &&
    shortlist.length > 0
  ) {
    const skillId =
      (typeof skillNode.skill_id === "string" && skillNode.skill_id) ||
      (isPlainObject(resultNode) && typeof resultNode.skill_id === "string" && resultNode.skill_id) ||
      undefined;
    const compactResult: Record<string, unknown> = {
      ...(result as Record<string, unknown>),
      skill: skillId ? { skill_id: skillId } : undefined,
    };
    if (compactResult.skill === undefined) delete compactResult.skill;
    return dietIfOversize(compactResult);
  }

  return dietIfOversize(result);
}

export function addExecuteNextStepHints(
  result: Record<string, unknown>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const nested = isPlainObject(result.result) ? result.result : result;
  const skillId = typeof args.skill === "string" ? args.skill : resolveSkillId(result);
  const endpointId = typeof args.endpoint === "string" ? args.endpoint : undefined;

  const hints: Record<string, unknown> = {
    next_step: "MANDATORY: call unbrowse_eval_feedback with the skill and endpoint ids and a rating (5=right+fast, 4=right+slow, 3=incomplete, 2=wrong endpoint, 1=useless).",
    reflect_when_done: "When the user-facing goal is complete (achieved, failed, partial), call unbrowse_eval_reflect once with intent_status. Helps surface slow/broken paths to maintainers. Anonymous.",
  };
  if (skillId) hints.feedback_skill = skillId;
  if (endpointId) hints.feedback_endpoint = endpointId;

  // Surface learned constraints so agents see them
  const constraints = isPlainObject(nested) && Array.isArray(nested.constraints) ? nested.constraints : undefined;
  if (constraints?.length) {
    hints.known_constraints = constraints;
  }

  // Surface community annotations
  const annotations = isPlainObject(nested) && Array.isArray(nested.annotations) ? nested.annotations : undefined;
  if (annotations?.length) {
    hints.community_notes = annotations;
  }

  // Detect if this skill has unreviewed/generic descriptions - nudge review+publish
  const desc = isPlainObject(nested) && typeof nested.description === "string" ? nested.description : "";
  const looksGeneric = !desc || desc.startsWith("Captured ") || desc.startsWith("Returns results");
  if (looksGeneric) {
    hints.first_use_review_needed = true;
    hints.review_step = "After feedback, call unbrowse_build_review to write proper endpoint descriptions, then unbrowse_build_publish to share to marketplace.";
  }

  // Prompt agent to contribute what it learned
  if (skillId && endpointId) {
    hints.contribute = "If you learned something about this endpoint (required params, gotchas, best practices), call unbrowse_build_annotate to share it with other agents.";
  }

  const next_action: Record<string, unknown> = {
    title: "Record feedback for this execution",
    command: "unbrowse_eval_feedback",
    command_args: {
      ...(skillId ? { skill: skillId } : {}),
      ...(endpointId ? { endpoint: endpointId } : {}),
    },
    why: "Closes the trust loop and weights this endpoint in future resolves.",
  };

  return { ...result, next_action, _workflow_hints: hints };
}

export function addCaptureNextStepHints(
  result: unknown,
  _args: Record<string, unknown>,
): unknown {
  if (!isPlainObject(result)) return result;
  const nested = isPlainObject(result.result) ? result.result : result;
  const skillId = isPlainObject(nested) && typeof nested.skill_id === "string" ? nested.skill_id : undefined;

  const hints: Record<string, unknown> = {
    next_step: "Call unbrowse_build_review to describe each captured endpoint. You are opted in by default; after review: skill publishes publicly to the marketplace and earns x402 rewards on execution. Rewards land in your wallet - run `unbrowse setup` to pair one if you have not already. To opt out, call unbrowse_eval_settings with share_pointers=false BEFORE review (keeps captures private, forfeits rewards). For sensitive domains only, use publish_blacklist instead.",
    marketplace_default: "public publish + x402 rewards (opted in by default)",
    opt_out_command: "unbrowse_eval_settings with share_pointers=false",
    reflect_when_done: "When the user-facing goal is complete (achieved, failed, partial), call unbrowse_eval_reflect once with intent_status. Helps surface slow/broken paths to maintainers. Anonymous.",
  };
  if (skillId) {
    hints.skill_id = skillId;
    hints.review_command = `unbrowse_build_review with skill="${skillId}"`;
  }

  const next_action: Record<string, unknown> = {
    title: "Review the captured endpoints",
    command: "unbrowse_build_review",
    command_args: skillId ? { skill: skillId } : {},
    why: "Required before public marketplace publish. After review, your skill auto-publishes (you are opted in by default) and earns x402 rewards when other agents execute it. Rewards land in your wallet - pair one via `unbrowse setup` if needed. Skip review = stays local.",
  };

  return { ...result, next_action, _workflow_hints: hints };
}

export function addGoNextStepHints(
  result: unknown,
  _args: Record<string, unknown>,
): unknown {
  if (!isPlainObject(result)) return result;
  const nested = isPlainObject(result.result) ? result.result : result;
  const sessionId =
    isPlainObject(nested) && typeof nested.session_id === "string"
      ? nested.session_id
      : undefined;
  const page = isPlainObject(nested.page) ? nested.page : undefined;
  const pageText = page && typeof page.text === "string" ? page.text : undefined;
  const injected = typeof nested.cookies_injected === "number" ? nested.cookies_injected : 0;
  const preserved = typeof nested.cookies_preserved === "number" ? nested.cookies_preserved : 0;
  const existingAuthOutcome = typeof nested.auth_outcome === "string" ? nested.auth_outcome : undefined;
  const observedAuthOutcome = existingAuthOutcome ?? classifyAuthenticatedPage({
    pageText,
    hadPresentedCredentials: injected > 0 || preserved > 0,
    currentUrl: typeof nested.final_url === "string"
      ? nested.final_url
      : typeof nested.url === "string" ? nested.url : undefined,
  });

  // The session-scoped tools just became callable (tools/list_changed
  // fired in setBrowseSessionOpen). Surface them straight from the
  // SESSION_TOOL_NAMES declaration so this list can never drift from what
  // tools/list now exposes. The substrate reports what is callable; it
  // does not prescribe a procedure for the caller to follow.
  const session_tools_now_available = [...SESSION_TOOL_NAMES];

  const hints: Record<string, unknown> = {
    next_step:
      "A live browse session is open. The tools in session_tools_now_available are callable now: unbrowse_eval_snap to read the page, click/fill/type/select/press/scroll/submit to interact, run_js/text/markdown/screenshot to extract. When you are done, call unbrowse_breath_close (or unbrowse_breath_sync). That call triggers the capture, enrichment and index pipeline. If close is never called, nothing is indexed and the route stays unresolvable.",
    session_tools_now_available,
    index_step:
      "unbrowse_breath_close ends the session and indexes the captured traffic; unbrowse_breath_sync checkpoints the index without ending the session.",
    reflect_when_done:
      "When the user-facing goal is complete (achieved, failed, partial), call unbrowse_eval_reflect once with intent_status. Helps surface slow/broken paths to maintainers. Anonymous.",
  };
  if (sessionId) hints.session_id = sessionId;

  const next_action: Record<string, unknown> = {
    title: "Inspect the live page",
    command: "unbrowse_eval_snap",
    command_args: sessionId ? { session_id: sessionId } : {},
    why:
      "A browse session is open; snapshot it to see element refs before interacting. unbrowse_breath_close indexes the captured traffic when you are done.",
  };

  return {
    ...result,
    operational_ok: result.ok !== false && result.error !== true && typeof result.error !== "string",
    auth_outcome: observedAuthOutcome,
    auth_ok: observedAuthOutcome === "authenticated" ? true
      : observedAuthOutcome === "auth_required" || observedAuthOutcome === "session_expired" ? false
      : null,
    auth_required: observedAuthOutcome === "auth_required",
    session_expired: observedAuthOutcome === "session_expired",
    next_action,
    _workflow_hints: hints,
  };
}

async function api(method: string, route: string, body?: unknown): Promise<unknown> {
  let url = route;
  let payload = body;
  if (method === "GET" && body && typeof body === "object") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        params.set(key, String(value));
      }
    }
    const query = params.toString();
    if (query) url += `${url.includes("?") ? "&" : "?"}${query}`;
    payload = undefined;
  }

  if (process.env.UNBROWSE_MCP_HTTP_BACKEND === "1") {
    const base = (
      process.env.UNBROWSE_API_URL ??
      process.env.UNBROWSE_BACKEND_URL ??
      process.env.UNBROWSE_URL ??
      ""
    ).replace(/\/+$/, "");
    if (!base) throw new Error("UNBROWSE_MCP_HTTP_BACKEND=1 requires UNBROWSE_API_URL, UNBROWSE_BACKEND_URL, or UNBROWSE_URL");
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(payload ? { "content-type": "application/json" } : {}),
        "x-unbrowse-client-id": CLIENT_ID,
      },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return res.json();
    const text = await res.text();
    if (res.ok) return { ok: true, text };
    return { error: `HTTP ${res.status}`, status: res.status, body: text };
  }

  // Phase 0d: no HTTP, no :6969 daemon. Dispatch in-process via Fastify
  // inject against the same route surface server.ts would listen on. Kuri
  // (the separate CDP broker) holds the only live state.
  const app = await getInProcessApp();
  const res = await traceAsync("mcp", undefined, `inject:${method} ${route}`, () => app.inject({
    method: method as "GET" | "POST",
    url,
    headers: {
      ...(payload ? { "content-type": "application/json" } : {}),
      "x-unbrowse-client-id": CLIENT_ID,
    },
    payload: payload !== undefined ? JSON.stringify(payload) : undefined,
  }));

  const ct = res.headers["content-type"];
  const ctStr = Array.isArray(ct) ? ct.join(";") : String(ct ?? "");
  if (ctStr.includes("application/json")) {
    return res.json();
  }
  const text = res.body;
  if (res.statusCode >= 200 && res.statusCode < 300) return { ok: true, text };
  if (res.statusCode === 402) {
    // Parity with the CLI 402 path: do not swallow payment-required as a bare
    // HTTP error. Surface the backend's Flex payment terms plus the same
    // structured, actionable gate the client surfaces, so the calling agent
    // can register an account or pay via x402 (Faremeter Flex / configured
    // facilitator) and retry, instead of dead-ending on a string.
    // One shared Flex settlement seam (the same module the CLI 402 path uses).
    // The paid retry is injected through THIS in-process app so it keeps the
    // exact route + client-id shaping the original 402 came through; the
    // authorize/sign/submit/splits-verbatim money logic lives in flex-pay.ts.
    try {
      const { settleViaFlex } = await import("./payments/flex-pay.js");
      let terms: unknown;
      const prHeader =
        res.headers["payment-required"] ?? res.headers["x-payment-required"];
      if (typeof prHeader === "string") {
        try {
          terms = JSON.parse(Buffer.from(prHeader, "base64").toString("utf8"));
        } catch {
          /* not a base64 terms header; fall through */
        }
      }
      if (terms === undefined) {
        try {
          terms = JSON.parse(text);
        } catch {
          /* 402 body is not JSON terms */
        }
      }
      const flex = await settleViaFlex(url, terms, {
        body: payload,
        retry: async (paymentHeader: string) => {
          const r = await app.inject({
            method: method as "GET" | "POST",
            url,
            headers: {
              ...(payload ? { "content-type": "application/json" } : {}),
              "x-unbrowse-client-id": CLIENT_ID,
              "X-PAYMENT": paymentHeader,
            },
            payload: payload !== undefined ? JSON.stringify(payload) : undefined,
          });
          if (r.statusCode < 200 || r.statusCode >= 300) {
            throw new Error(`flex retry HTTP ${r.statusCode}`);
          }
          return r.json();
        },
      });
      if (flex) return flex.data;
    } catch (flexErr) {
      console.warn(
        `[x402] mcp flex settle failed: ${(flexErr as Error).message}`,
      );
    }
    return {
      error: "payment_required",
      status_code: 402,
      payment_required: true,
      body: text,
      next_step: buildGateRefusal(),
    };
  }
  return { error: `HTTP ${res.statusCode}: ${text}` };
}

function resolveNestedError(value: Record<string, unknown>): string | undefined {
  const nested = value.result;
  if (isPlainObject(nested) && typeof nested.error === "string") return nested.error;
  return typeof value.error === "string" ? value.error : undefined;
}

function resolveSkillId(value: Record<string, unknown>): string | undefined {
  const nestedSkill = value.skill;
  if (isPlainObject(nestedSkill) && typeof nestedSkill.skill_id === "string") return nestedSkill.skill_id;
  return typeof value.skill_id === "string" ? value.skill_id : undefined;
}

export function addResolveMissGuidance(
  result: Record<string, unknown>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const nested = isPlainObject(result.result) ? result.result : undefined;
  const status = typeof nested?.status === "string" ? nested.status : undefined;
  const error = resolveNestedError(result);
  const missStatuses = new Set(["no_cached_match", "no_match", "not_found"]);
  const statusIsMiss = status !== undefined && missStatuses.has(status);
  const errorIsMiss = error !== undefined && missStatuses.has(error);
  if (!statusIsMiss && !errorIsMiss) return result;

  const url = typeof args.url === "string" ? args.url : (typeof nested?.url === "string" ? nested.url : undefined);
  const domain = typeof args.domain === "string" ? args.domain : (typeof nested?.domain === "string" ? nested.domain : undefined);
  const target = url ?? domain ?? "<exact page url>";
  const relevant_options = [
    {
      mode: "canonical_action_dag",
      when: "Use the one-call action path; it owns discovery, execution, and default marketplace publication.",
      next_tools: ["unbrowse_breath_get"],
    },
    {
      mode: "auth_then_retry",
      when: "The site is gated and the browser flow needs a logged-in session first.",
      next_tools: [
        "unbrowse_breath_auth_capture",
        "unbrowse_breath_navigate",
        "unbrowse_eval_snap",
      ],
    },
  ];
  return {
    ...result,
    result: {
      ...(nested ?? {}),
      next_step:
        `No cached route yet. Call unbrowse_breath_get for ${target}; it owns the canonical DAG: direct -> browser discovery on miss -> execute -> marketplace publish (unless share_pointers=false) -> subsequent direct replay.`,
      suggested_tool_sequence: ["unbrowse_breath_get"],
      action_dag: [
        { id: "direct", depends_on: [] },
        { id: "discover", depends_on: ["direct:miss"] },
        { id: "execute", depends_on: ["direct:hit", "discover"] },
        { id: "publish", depends_on: ["execute:success"], default: true, opt_out: "share_pointers=false" },
        { id: "subsequent_direct", depends_on: ["publish:settled"] },
      ],
      relevant_options,
      discovery_mode: "automatic_on_direct_miss",
      resolve_mode: "cache_only",
    },
    // Only emit next_action when we can populate a dispatchable command.
    // unbrowse_breath_navigate requires `url`; if we only have a domain or nothing,
    // omit next_action rather than promise an undispatchable call.
    ...(url ? {
      next_action: {
        title: "Run the canonical action DAG",
        command: "unbrowse_breath_get",
        command_args: {
          url,
          ...(typeof args.intent === "string" ? { intent: args.intent } : {}),
        },
        why: "No cached route yet; the one-call path will discover, execute, and publish automatically.",
      },
    } : {}),
  };
}

export function addResolveHitGuidance(
  result: Record<string, unknown>,
  _args: Record<string, unknown>,
): Record<string, unknown> {
  if (isPlainObject(result.next_action)) return result;
  const nested = isPlainObject(result.result) ? result.result : result;
  const endpoints = Array.isArray(nested.available_endpoints)
    ? nested.available_endpoints
    : undefined;
  const top = endpoints?.[0];
  if (!isPlainObject(top) || typeof top.endpoint_id !== "string") return result;

  const skill = nested.skill;
  const skillId = isPlainObject(skill) && typeof skill.skill_id === "string"
    ? skill.skill_id
    : resolveSkillId(nested);
  if (!skillId) return result;

  const desc = typeof top.description === "string" ? top.description : "";
  const why = desc.length > 120 ? `${desc.slice(0, 117)}...` : desc;
  return {
    ...result,
    next_action: {
      title: "Execute the top resolved endpoint",
      command: "unbrowse_breath_execute",
      command_args: {
        skill: skillId,
        endpoint: top.endpoint_id,
      },
      why: why || "A cached route matched the intent; execute the top ranked endpoint.",
    },
  };
}

/**
 * Token-minimal resolve shortlist (browser-use flash_mode pattern).
 *
 * When `args.flash` is set, every available_endpoints[] candidate is reduced
 * to its dispatch keys (endpoint_id + skill_id) plus a single one-line
 * `flash_evidence` string, dropping the heavy fields (example_response_compact,
 * sample_values, input_params, requires, yields schema). The agent still has
 * exactly what it needs to pick a candidate and call unbrowse_breath_execute, at a
 * fraction of the shortlist token cost. The full rich shortlist stays the
 * default; flash is strictly opt-in. A non-array shortlist or flash=false is
 * returned unchanged.
 */
export function applyFlashMode(
  result: Record<string, unknown>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (args.flash !== true) return result;
  const list = result.available_endpoints;
  if (Array.isArray(list)) {
    const flashed = list.map((raw) => {
      const c = isPlainObject(raw) ? raw : {};
      const endpoint_id = typeof c.endpoint_id === "string" ? c.endpoint_id : undefined;
      const skill_id = typeof c.skill_id === "string" ? c.skill_id : undefined;
      const desc = typeof c.description === "string" ? c.description.trim() : "";
      const url = typeof c.url === "string" ? c.url : "";
      const score = typeof c.score === "number" ? c.score : undefined;
      const evid: string[] = [];
      if (desc) evid.push(desc);
      if (score !== undefined) evid.push(`score ${score.toFixed(2)}`);
      if (url) evid.push(url);
      let flash_evidence = evid.join(" | ");
      if (flash_evidence.length > 200) flash_evidence = `${flash_evidence.slice(0, 197)}...`;
      return { endpoint_id, skill_id, flash_evidence };
    });
    return { ...result, available_endpoints: flashed, flash_mode: true };
  }
  // Exa / probe-fallback shape (intent-only resolves with no marketplace
  // endpoints). The candidates live under the nested result payload and each
  // carries a multi-hundred-char highlights_excerpt — exactly the bulk a flash
  // caller wants dropped. Reduce each candidate to url + title + score + a short
  // one-line flash_evidence, keeping the answer (data/source_*), next_step, and
  // suggested_commands intact so the agent can still pick a candidate and fetch
  // it. Without this, flash=true was silently ignored on the most common
  // intent-only path and the agent got the full ~3KB rich shape.
  const inner = isPlainObject(result.result) ? result.result : undefined;
  if (inner && Array.isArray(inner.exa_candidates)) {
    const flashedCandidates = inner.exa_candidates.map((raw) => {
      const c = isPlainObject(raw) ? raw : {};
      const url = typeof c.url === "string" ? c.url : undefined;
      const title = typeof c.title === "string" ? c.title : undefined;
      const score = typeof c.score === "number" ? c.score : undefined;
      let flash_evidence = typeof c.highlights_excerpt === "string"
        ? c.highlights_excerpt.replace(/\s+/g, " ").trim()
        : "";
      if (flash_evidence.length > 160) flash_evidence = `${flash_evidence.slice(0, 157)}...`;
      return { url, title, score, flash_evidence };
    });
    return {
      ...result,
      result: { ...inner, exa_candidates: flashedCandidates },
      flash_mode: true,
    };
  }
  // Direct-document shape (cold page-content fallback). The payload carries BOTH
  // a plaintext text_excerpt AND a full markdown render of the page — the
  // markdown is the heavy duplicate (e.g. ~13KB of link-laden markdown for a
  // 34KB HN page). A flash caller wants the minimal answer, so keep
  // title/url/text_excerpt (bounded)/extraction/tables and drop the verbose
  // markdown + html_bytes + content_type. Without this, flash=true returned the
  // full multi-KB markdown on every cold page resolve.
  if (
    inner &&
    typeof inner.markdown === "string" &&
    typeof inner.text_excerpt === "string" &&
    isPlainObject(inner.extraction) &&
    inner.extraction.source === "direct-document"
  ) {
    let excerpt = inner.text_excerpt;
    if (excerpt.length > 2000) excerpt = `${excerpt.slice(0, 1997)}...`;
    const trimmed: Record<string, unknown> = {
      title: inner.title,
      url: inner.url,
      text_excerpt: excerpt,
      extraction: inner.extraction,
    };
    if (Array.isArray(inner.tables) && inner.tables.length > 0) trimmed.tables = inner.tables;
    return { ...result, result: trimmed, flash_mode: true };
  }
  return result;
}

async function executeResolvedEndpoint(result: Record<string, unknown>, args: Record<string, unknown>, endpointId?: string): Promise<Record<string, unknown>> {
  const skillId = resolveSkillId(result);
  if (!skillId) return { error: "resolve returned endpoints but no skill_id" };

  const available = Array.isArray(result.available_endpoints) ? result.available_endpoints : [];
  const selected = endpointId
    ? endpointId
    : (available[0] && isPlainObject(available[0]) && typeof available[0].endpoint_id === "string"
      ? available[0].endpoint_id
      : undefined);

  if (!selected) return { error: "no executable endpoint available" };
  const selectedEndpoint = available.find((endpoint) => isPlainObject(endpoint) && endpoint.endpoint_id === selected);
  // third_party_terms: no longer blocks - Unbrowse acts as the user's browser.

  return api("POST", `/v1/skills/${skillId}/execute`, {
    intent: args.intent,
    params: {
      endpoint_id: selected,
      ...(isPlainObject(args.params) ? args.params : {}),
    },
    projection: { raw: args.raw !== false },
    ...(typeof args.url === "string" ? { context_url: args.url } : {}),
    ...(args.dry_run === true ? { dry_run: true } : {}),
    ...(args.confirm_third_party_terms === true ? { confirm_third_party_terms: true } : {}),
  }) as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Impact visibility - every tool result includes a "saved X" line so agents
// see concrete value (time, tokens, cost, browser-avoided) on every call.
// ---------------------------------------------------------------------------

function formatImpactUsd(uc: number): string {
  const usd = uc / 1_000_000;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

function formatImpactDuration(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 10_000) return `${Math.round(ms / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/** Build a one-line impact summary, or "" if nothing meaningful happened. */
function summarizeImpact(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const impact = (result as Record<string, unknown>).impact as Record<string, unknown> | undefined;
  if (!impact) return "";
  const timeMs = typeof impact.time_saved_ms === "number" ? impact.time_saved_ms : 0;
  const tokens = typeof impact.tokens_saved === "number" ? impact.tokens_saved : 0;
  const timePct = typeof impact.time_saved_pct === "number" ? impact.time_saved_pct : 0;
  const tokensPct = typeof impact.tokens_saved_pct === "number" ? impact.tokens_saved_pct : 0;
  const costUc = typeof impact.cost_saved_uc === "number" ? impact.cost_saved_uc : 0;
  const browserAvoided = impact.browser_avoided === true;
  if (timeMs <= 0 && tokens <= 0 && costUc <= 0 && !browserAvoided) return "";
  const parts: string[] = [];
  if (timeMs > 0) parts.push(`${formatImpactDuration(timeMs)} saved (${timePct}% faster)`);
  if (tokens > 0) parts.push(`${tokens.toLocaleString("en-US")} tokens saved (${tokensPct}% less context)`);
  if (costUc > 0) parts.push(`${formatImpactUsd(costUc)} saved`);
  if (browserAvoided) parts.push("browser avoided");
  return `Impact: ${parts.join(" • ")}`;
}

/** Append impact to the local log (fire-and-forget). Called from resolve/execute handlers. */
function recordImpactForTool(
  command: "resolve" | "execute",
  result: unknown,
  args: Record<string, unknown>,
): void {
  const entry = impactFromResult(command, result, {
    intent: typeof args.intent === "string" ? args.intent : undefined,
    domain: typeof args.domain === "string" ? args.domain : undefined,
    skill_id: typeof args.skill === "string" ? args.skill : undefined,
    endpoint_id: typeof args.endpoint === "string" ? args.endpoint : undefined,
  });
  if (entry) appendImpact(entry);
}

// Module-level in-flight request id slot. Read by process.on handlers to
// route uncaughtException/unhandledRejection back to the right JSON-RPC id.
// Set by handleRequest before dispatching; cleared in a finally. Single-flight
// stdio loop means there's never more than one in flight, so a single slot is
// sufficient. Module-level (not closure in main()) so handleRequest, defined
// outside main, can read/write it. In-process test imports do not touch this
// slot - no leak risk in practice.
let currentRequestId: number | string | null = null;

// Last accessibility snapshot per browse session, keyed by session_id. Lets
// unbrowse_eval_snap mark elements new since the prior snap of the same session
// (browser-use new-element indicator). Process-lifetime Map: a browse session
// lives inside one MCP process, and distinct session_ids never cross-read.
const lastSnapshotBySession = new Map<string, string>();

const toolHandlers: Record<string, ToolDefinition["handler"]> = {
  "unbrowse_eval_resolve": async (args) => {
      await ensureServerReady();

      const body: Record<string, unknown> = {
        intent: args.intent,
        projection: { raw: args.raw !== false },
      };

      if (typeof args.url === "string") {
        body.params = { url: args.url };
        body.context = { url: args.url };
      }
      if (typeof args.endpoint_id === "string") {
        body.params = { ...(isPlainObject(body.params) ? body.params : {}), endpoint_id: args.endpoint_id };
      }
      if (isPlainObject(args.params)) {
        body.params = { ...(isPlainObject(body.params) ? body.params : {}), ...args.params };
      }
      if (args.dry_run === true) body.dry_run = true;
      if (args.confirm_third_party_terms === true) body.confirm_third_party_terms = true;
      if (args.force_capture === true) body.force_capture = true;

      let result = await api("POST", "/v1/intent/resolve", body) as Record<string, unknown>;

      const authError = resolveNestedError(result);
      if (authError === "auth_required") {
        const loginUrl = isPlainObject(result.result) && typeof result.result.login_url === "string"
          ? result.result.login_url
          : args.url;
        return errorResult(
          `Authentication required. Call unbrowse_breath_auth_capture with ${loginUrl ?? "the site login URL"} to sign in, then retry.`,
          result,
        );
      }

      if (args.execute === true && Array.isArray(result.available_endpoints)) {
        result = await executeResolvedEndpoint(result, args, typeof args.endpoint_id === "string" ? args.endpoint_id : undefined);
      }

      result = addResolveMissGuidance(result, args);
      result = applyFlashMode(result, args);
      const nestedError = resolveNestedError(result);
      recordImpactForTool("resolve", result, args);
      if (nestedError) return errorResult(nestedError, result);
      const processed = maybePostProcessResult(result, args);
      const impactLine = summarizeImpact(result);
      return successResult(processed, impactLine ? `Resolve result. ${impactLine}` : "Resolve result.");
    },
  "unbrowse_breath_execute": async (args) => {
      await ensureServerReady();
      const body: Record<string, unknown> = { params: {}, projection: { raw: args.raw !== false } };
      if (typeof args.endpoint === "string") (body.params as Record<string, unknown>).endpoint_id = args.endpoint;
      if (isPlainObject(args.params)) body.params = { ...(body.params as Record<string, unknown>), ...args.params };
      if (typeof args.url === "string") {
        body.context_url = args.url;
        (body.params as Record<string, unknown>).url = args.url;
      }
      if (typeof args.intent === "string") body.intent = args.intent;
      if (args.dry_run === true) body.dry_run = true;
      if (args.confirm_unsafe === true) body.confirm_unsafe = true;
      if (args.confirm_third_party_terms === true) body.confirm_third_party_terms = true;

      const result = await api("POST", `/v1/skills/${args.skill}/execute`, body) as Record<string, unknown>;
      const nestedError = resolveNestedError(result);
      recordImpactForTool("execute", result, args);
      recordCreativityActFromExecute(result, {
        intent: typeof args.intent === "string" ? args.intent : undefined,
        skill_id: typeof args.skill === "string" ? args.skill : undefined,
        endpoint_id: typeof args.endpoint === "string" ? args.endpoint : undefined,
      });
      if (nestedError) return errorResult(nestedError, result);
      const processed = maybePostProcessResult(result, args);
      const withHints = addExecuteNextStepHints(isPlainObject(processed) ? processed as Record<string, unknown> : { result: processed }, args);
      // AC5 lane-07: surface a fix-surface pointer when execute returned a known
      // failure mode. Mapping is read from coverage.jsonl, not hard-coded here.
      const enriched = enrichWithImprovementSuggestion(withHints);
      const impactLine = summarizeImpact(result);
      return successResult(
        enriched,
        impactLine
          ? `Execution result. ${impactLine}. See _workflow_hints for required next steps.`
          : "Execution result. See _workflow_hints for required next steps.",
      );
    },
  "unbrowse_eval_stats": async (args) => {
      await ensureServerReady();
      const local = readImpactSummary();
      const agentId = getAgentId();

      type EarningsLedger = { total_earned_uc: number; total_earned_usd: number; transaction_count: number; last_transaction_at?: string } | null;
      type SpendingLedger = { total_spent_uc: number; total_spent_usd: number; transaction_count: number; last_transaction_at?: string } | null;

      let profile: Awaited<ReturnType<typeof getMyProfile>> | null = null;
      let earnings: { ledger: EarningsLedger; transactions: unknown[] } | null = null;
      let spending: { ledger: SpendingLedger; transactions: unknown[] } | null = null;
      const remoteErrors: Record<string, string> = {};

      if (agentId) {
        const results = await Promise.allSettled([
          getMyProfile(),
          getCreatorEarnings(agentId),
          getTransactionHistory(agentId),
        ]);
        if (results[0].status === "fulfilled") profile = results[0].value;
        else remoteErrors.profile = (results[0].reason as Error)?.message ?? String(results[0].reason);
        if (results[1].status === "fulfilled") earnings = results[1].value as { ledger: EarningsLedger; transactions: unknown[] };
        else remoteErrors.earnings = (results[1].reason as Error)?.message ?? String(results[1].reason);
        if (results[2].status === "fulfilled") spending = results[2].value as { ledger: SpendingLedger; transactions: unknown[] };
        else remoteErrors.spending = (results[2].reason as Error)?.message ?? String(results[2].reason);
      } else {
        remoteErrors.profile = "No agent_id in local config. Run `unbrowse setup` to register.";
      }

      const earnedUsd = earnings?.ledger?.total_earned_usd ?? 0;
      const spentUsd = spending?.ledger?.total_spent_usd ?? 0;
      const savedUsd = local.total_cost_saved_uc / 1_000_000;

      const includeRecent = args.include_recent === true;
      const payload = {
        agent_id: agentId,
        profile,
        impact: {
          total_runs: local.total_runs,
          successful_runs: local.successful_runs,
          browser_avoided_runs: local.browser_avoided_runs,
          total_time_saved_ms: local.total_time_saved_ms,
          total_time_saved_human: formatImpactDuration(local.total_time_saved_ms),
          total_tokens_saved: local.total_tokens_saved,
          total_cost_saved_usd: Number(savedUsd.toFixed(6)),
          avg_time_saved_pct: local.avg_time_saved_pct,
          avg_tokens_saved_pct: local.avg_tokens_saved_pct,
          by_source: local.by_source,
          first_entry_at: local.first_entry_at,
          last_entry_at: local.last_entry_at,
          log_path: getImpactLogPath(),
        },
        earnings: {
          total_earned_usd: earnedUsd,
          total_earned_uc: earnings?.ledger?.total_earned_uc ?? 0,
          transaction_count: earnings?.ledger?.transaction_count ?? 0,
          last_transaction_at: earnings?.ledger?.last_transaction_at ?? null,
          ...(includeRecent && earnings?.transactions ? { recent: earnings.transactions.slice(0, 10) } : {}),
        },
        spending: {
          total_spent_usd: spentUsd,
          total_spent_uc: spending?.ledger?.total_spent_uc ?? 0,
          transaction_count: spending?.ledger?.transaction_count ?? 0,
          last_transaction_at: spending?.ledger?.last_transaction_at ?? null,
          ...(includeRecent && spending?.transactions ? { recent: spending.transactions.slice(0, 10) } : {}),
        },
        net_usd: earnedUsd - spentUsd,
        ...(Object.keys(remoteErrors).length > 0 ? { remote_errors: remoteErrors } : {}),
      };

      const headline: string[] = [];
      if (local.total_runs > 0) {
        const bits: string[] = [];
        if (local.total_time_saved_ms > 0) bits.push(`${formatImpactDuration(local.total_time_saved_ms)} saved`);
        if (local.total_tokens_saved > 0) bits.push(`${local.total_tokens_saved.toLocaleString("en-US")} tokens saved`);
        if (savedUsd > 0) bits.push(`${formatImpactUsd(local.total_cost_saved_uc)} saved`);
        if (local.browser_avoided_runs > 0) bits.push(`${local.browser_avoided_runs} browser calls avoided`);
        if (bits.length > 0) headline.push(`Lifetime impact (${local.total_runs} runs): ${bits.join(" • ")}`);
      }
      if (agentId && !remoteErrors.earnings && !remoteErrors.spending) {
        headline.push(`Marketplace: +$${earnedUsd.toFixed(4)} earned, -$${spentUsd.toFixed(4)} spent, net ${earnedUsd - spentUsd >= 0 ? "+" : ""}$${(earnedUsd - spentUsd).toFixed(4)}`);
      }
      return successResult(payload, headline.length > 0 ? headline.join(" • ") : "Unbrowse stats (no runs recorded yet).");
    },
  "unbrowse_search_endpoints": async (args) => {
      await ensureServerReady();
      const body: Record<string, unknown> = { intent: args.intent };
      if (typeof args.k === "number") body.k = args.k;
      if (typeof args.domain === "string") body.domain = args.domain;
      return successResult(await api("POST", "/v1/search/endpoints", body), "Endpoint search results.");
    },
  "unbrowse_eval_search": async (args) => {
      await ensureServerReady();
      const body: Record<string, unknown> = { intent: args.intent };
      if (typeof args.k === "number") body.k = args.k;
      if (typeof args.web === "boolean") body.web = args.web;
      // /v1/search is the free discovery route: the backend resolves the route
      // graph and adds best-effort Exa web enrichment (funded by the platform via
      // an API key). Payment is on EXECUTION of a returned paid route, not here —
      // api() handles any 402 on unbrowse_breath_execute by delegating to the wallet seam.
      return successResult(await api("POST", "/v1/search", body), "Search results.");
    },
  "unbrowse_eval_feedback": async (args) => {
      await ensureServerReady();
      const body: Record<string, unknown> = {
        skill_id: args.skill,
        endpoint_id: args.endpoint,
        rating: args.rating,
      };
      if (typeof args.outcome === "string") body.outcome = args.outcome;
      if (isPlainObject(args.diagnostics)) body.diagnostics = args.diagnostics;
      return successResult(await api("POST", "/v1/feedback", body), "Feedback submitted.");
    },
  "unbrowse_eval_reflect": async (args) => {
      const status = String(args.intent_status) as "achieved" | "failed" | "partial";
      const notes = typeof args.notes_hash === "string" ? args.notes_hash : undefined;
      const logger = getSessionLogger();
      logger.recordReflection(status, notes);
      const payload: Record<string, unknown> = { ok: true, recorded: true, intent_status: status, telemetry_enabled: logger.enabled };
      // Reliability attribution: when the agent names the (skill, endpoint)
      // it just executed against, the reflect outcome is sent UP and the
      // SERVER applies the Bayesian-smoothed aggregate over cross-user
      // EndpointStats (it also runs the auto-deprecation gate). Reliability +
      // staleness are population computations a single client cannot see, so
      // the client never derives them: it adopts the server-authoritative
      // value into the local snapshot so the very next resolve surfaces it as
      // evidence. Degraded fallback only when the marketplace is unreachable:
      // a local last-known estimate, clearly labeled, never a hard-fail.
      const skillId = typeof args.skill_id === "string" ? args.skill_id : undefined;
      const endpointId = typeof args.endpoint_id === "string" ? args.endpoint_id : undefined;
      if (skillId && endpointId) {
        try {
          const { recordReflectionOutcome } = await import("./client/index.js");
          const { domainSkillCache, readSkillSnapshot } = await import("./orchestrator/index.js");
          // Find the live local snapshot path so the adopted server value
          // takes effect on the very next resolve.
          let snapshotPath: string | undefined;
          for (const v of domainSkillCache.values()) {
            if (v.skillId === skillId && v.localSkillPath) { snapshotPath = v.localSkillPath; break; }
          }
          const snapshot = readSkillSnapshot(snapshotPath);
          const ep = snapshot?.endpoints.find((e) => e.endpoint_id === endpointId);
          const before = ep && typeof ep.reliability_score === "number" ? ep.reliability_score : 0.5;
          const server = await recordReflectionOutcome(skillId, endpointId, status);
          if (server) {
            // Server-authoritative: adopt the recomputed cross-user aggregate.
            if (ep) {
              ep.reliability_score = server.reliability_score;
              if (typeof server.verification_status === "string" && server.verification_status) {
                (ep as { verification_status?: string }).verification_status = server.verification_status;
              }
              if (snapshotPath) {
                const { writeFileSync } = await import("node:fs");
                writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
              }
            }
            payload.reliability_update = {
              skill_id: skillId,
              endpoint_id: endpointId,
              before,
              after: server.reliability_score,
              outcome: status,
              source: "server_authoritative",
              verification_status: server.verification_status,
              stale: server.stale,
              total_observations: server.total_observations,
              ...(server.auto_deprecated_at ? { auto_deprecated_at: server.auto_deprecated_at } : {}),
            };
          } else if (ep) {
            // Marketplace unreachable: degraded local estimate from the
            // last-known value so resolve still has a signal. NOT
            // authoritative; superseded the next time the server is reached.
            const { applyReliabilityUpdate } = await import("./marketplace/reliability.js");
            const estimate = applyReliabilityUpdate(before, status);
            ep.reliability_score = estimate;
            if (snapshotPath) {
              const { writeFileSync } = await import("node:fs");
              writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
            }
            payload.reliability_update = {
              skill_id: skillId,
              endpoint_id: endpointId,
              before,
              after: estimate,
              outcome: status,
              source: "degraded_local_estimate",
            };
          } else {
            payload.reliability_update = {
              skill_id: skillId,
              endpoint_id: endpointId,
              outcome: status,
              source: snapshot ? "server_authoritative" : "degraded_local_estimate",
              note: snapshot ? "endpoint_not_found_in_snapshot" : "skill_snapshot_not_found_locally",
            };
          }
        } catch (e) {
          payload.reliability_update = { skill_id: skillId, endpoint_id: endpointId, error: (e as Error)?.message ?? "reliability_update_failed" };
        }
      }
      // AC5 lane-07: failed/partial reflections get an improvement_suggestion
      // when the caller carries a failure_mode hint. No hard-coded mapping:
      // the ledger declares what each failure means.
      const enriched = enrichWithImprovementSuggestion(payload);
      return successResult(enriched, "Reflection recorded.");
    },
  "unbrowse_build_index": async (args) => {
      await ensureServerReady();
      return successResult(await api("POST", `/v1/skills/${args.skill}/index`, {}), "Local index recomputed.");
    },
  "unbrowse_build_review": async (args) => {
      await ensureServerReady();
      return successResult(
        await api("POST", `/v1/skills/${args.skill}/review`, { endpoints: args.endpoints }),
        "Review metadata applied and local contracts re-indexed.",
      );
    },
  "unbrowse_build_publish": async (args) => {
      await ensureServerReady();
      const body: Record<string, unknown> = {};
      if (args.confirm_publish === true) body.confirm_publish = true;
      if (Array.isArray(args.endpoints)) body.endpoints = args.endpoints;
      return successResult(
        await api("POST", `/v1/skills/${args.skill}/publish`, body),
        Array.isArray(args.endpoints)
          ? "Publish step applied."
          : "Publish review surface.",
      );
    },
  "unbrowse_publish_suggestions": async (args) => {
      await ensureServerReady();
      if (args.apply === true) {
        if (!Array.isArray(args.skill_ids) || args.skill_ids.length === 0) {
          return successResult(
            { ok: false, error: "skill_ids[] required when apply=true" },
            "Provide skill_ids[] to apply publish suggestions.",
          );
        }
        return successResult(
          await api("POST", "/v1/skills/publish-suggestions/apply", { skill_ids: args.skill_ids }),
          "Applied publish suggestions: publish attempted for each skill_id (no reviewed_at stamped — only unbrowse_build_review sets that).",
        );
      }

      const query: string[] = [];
      if (typeof args.min_executions === "number") query.push(`min_executions=${args.min_executions}`);
      if (typeof args.min_success_rate === "number") query.push(`min_success_rate=${args.min_success_rate}`);
      if (typeof args.limit === "number") query.push(`limit=${args.limit}`);
      const path = `/v1/skills/publish-suggestions${query.length ? "?" + query.join("&") : ""}`;
      return successResult(
        await api("GET", path),
        "Local skills with proven usage but no `reviewed_at` stamp. Call again with apply=true and skill_ids[] to publish.",
      );
    },
  "unbrowse_eval_earnings": async (args) => {
      await ensureServerReady();
      const path = args.verbose === true ? "/v1/account/earnings?verbose=true" : "/v1/account/earnings";
      return successResult(
        await api("GET", path),
        "Earnings + contribution usage for the calling agent.",
      );
    },
  "unbrowse_eval_settings": async (args) => {
      await ensureServerReady();
      const hasMutation = args.auto_publish === true
        || args.auto_publish === false
        || args.auto_review === true
        || args.auto_review === false
        || args.passive_index === true
        || args.passive_index === false
        || args.share_pointers === true
        || args.share_pointers === false
        || args.attach_existing_chrome === true
        || args.attach_existing_chrome === false
        || Array.isArray(args.publish_blacklist)
        || Array.isArray(args.publish_promptlist)
        || args.clear_publish_blacklist === true
        || args.clear_publish_promptlist === true
        || args.mutation_policy === "ask"
        || args.mutation_policy === "deny"
        || args.mutation_policy === "whitelist"
        || Array.isArray(args.mutation_whitelist);

      if (!hasMutation) {
        return successResult(await api("GET", "/v1/settings"), "Local marketplace/publish settings. share_pointers=true + auto_review=true is the default (fully opted in): every capture auto-publishes to the marketplace and earns rewards.");
      }

      const body: Record<string, unknown> = {};
      if (args.auto_publish === true || args.auto_publish === false) {
        body.auto_publish_checkpoints = args.auto_publish;
      }
      if (args.auto_review === true || args.auto_review === false) {
        body.auto_review = args.auto_review;
      }
      if (args.passive_index === true || args.passive_index === false) {
        body.passive_index = args.passive_index;
      }
      if (args.share_pointers === true || args.share_pointers === false) {
        body.share_pointers = args.share_pointers;
      }
      if (args.attach_existing_chrome === true || args.attach_existing_chrome === false) {
        body.attach_existing_chrome = args.attach_existing_chrome;
      }
      if (Array.isArray(args.publish_blacklist)) body.publish_domain_blacklist = args.publish_blacklist;
      if (Array.isArray(args.publish_promptlist)) body.publish_domain_promptlist = args.publish_promptlist;
      if (args.clear_publish_blacklist === true) body.clear_publish_domain_blacklist = true;
      if (args.clear_publish_promptlist === true) body.clear_publish_domain_promptlist = true;
      if (args.mutation_policy === "ask" || args.mutation_policy === "deny" || args.mutation_policy === "whitelist") body.mutation_policy = args.mutation_policy;
      if (Array.isArray(args.mutation_whitelist)) body.mutation_whitelist = args.mutation_whitelist;

      return successResult(await api("POST", "/v1/settings", body), "Local marketplace/publish settings updated.");
    },
  "unbrowse_breath_auth_capture": async (args) => {
      await ensureServerReady();

      // Fall back to browser cookie extraction + interactive login
      const result = await api("POST", "/v1/auth/login", { url: args.url }) as Record<string, unknown>;
      const nestedError = resolveNestedError(result);
      return nestedError ? errorResult(nestedError, result) : successResult(result, "Login completed via browser cookies.");
    },
  "unbrowse_eval_skills": async () => {
      await ensureServerReady();
      return successResult(await api("GET", "/v1/skills"), "Known skills.");
    },
  "unbrowse_eval_skill": async (args) => {
      await ensureServerReady();
      return successResult(await api("GET", `/v1/skills/${args.id}`), "Skill manifest.");
    },
  "unbrowse_eval_sessions": async (args) => {
      await ensureServerReady();
      const limit = typeof args.limit === "number" ? args.limit : 10;
      return successResult(await api("GET", `/v1/sessions/${args.domain}?limit=${limit}`), "Session logs.");
    },
  "unbrowse_breath_navigate": async (args) => {
      await ensureServerReady();
      const result = await api("POST", "/v1/browse/go", {
        url: args.url,
        ...(typeof args.session_id === "string" ? { session_id: args.session_id } : {}),
      });
      const withHints = addGoNextStepHints(result, args);
      const wrapped = successResult(withHints, "Live browse session opened.");
      // Only increment the open-session counter when go actually opened a
      // session. api() returns the JSON body verbatim, so a failed go (e.g.
      // recoverable_browse_failure, auth_required handoff with no session)
      // would otherwise inflate the counter without a balancing close,
      // wedging the no_browse_session_open gate forever.
      const opened = !!(result && typeof result === "object" && (result as { session_id?: unknown }).session_id);
      if (opened) setBrowseSessionOpen(true);
      return wrapped;
    },
  "unbrowse_eval_snap": async (args) => {
      await ensureServerReady();
      const body: Record<string, unknown> = {};
      if (typeof args.filter === "string") body.filter = args.filter;
      if (typeof args.session_id === "string") body.session_id = args.session_id;
      const raw = (await api("POST", "/v1/browse/snap", body)) as {
        snapshot?: unknown;
        session_id?: unknown;
        tab_id?: unknown;
        current_url?: unknown;
        page_title?: unknown;
        warning?: unknown;
        next_step?: unknown;
      };
      // Mark elements that appeared since the prior snapshot of this browse
      // session (browser-use new-element indicator). Diff is keyed on the
      // real session_id so concurrent sessions never cross-contaminate; the
      // stored prior is the CLEAN snapshot, never the marked one.
      let new_element_count: number | undefined;
      const snapSid = typeof raw.session_id === "string"
        ? raw.session_id
        : (typeof args.session_id === "string" ? args.session_id : undefined);
      if (snapSid && typeof raw.snapshot === "string") {
        const cleanSnapshot = raw.snapshot;
        const delta = markNewSnapElements(cleanSnapshot, lastSnapshotBySession.get(snapSid));
        raw.snapshot = delta.snapshot;
        if (!delta.first_snapshot) new_element_count = delta.new_element_count;
        lastSnapshotBySession.set(snapSid, cleanSnapshot);
      }
      const level: SnapDetailLevel | undefined =
        args.detail_level === "minimal" || args.detail_level === "summary" || args.detail_level === "full"
          ? args.detail_level
          : undefined;
      const shaped = shapeSnapResult(raw as Record<string, unknown>, level);
      const value = new_element_count !== undefined
        ? { ...(shaped.value as Record<string, unknown>), new_element_count }
        : shaped.value;
      return successResult(value, shaped.summary);
    },
  "unbrowse_breath_click": async (args) => {
      await ensureServerReady();
      return successResult(await api("POST", "/v1/browse/click", {
        ref: args.ref,
        ...(typeof args.session_id === "string" ? { session_id: args.session_id } : {}),
      }), "Click sent.");
    },
  "unbrowse_breath_fill": async (args) => {
      await ensureServerReady();
      return successResult(await api("POST", "/v1/browse/fill", {
        ref: args.ref,
        value: args.value,
        ...(typeof args.session_id === "string" ? { session_id: args.session_id } : {}),
      }), "Field filled.");
    },
  "unbrowse_breath_type": async (args) => {
      await ensureServerReady();
      return successResult(await api("POST", "/v1/browse/type", {
        text: args.text,
        ...(typeof args.session_id === "string" ? { session_id: args.session_id } : {}),
      }), "Text typed.");
    },
  "unbrowse_breath_press": async (args) => {
      await ensureServerReady();
      return successResult(await api("POST", "/v1/browse/press", {
        key: args.key,
        ...(typeof args.session_id === "string" ? { session_id: args.session_id } : {}),
      }), "Key press sent.");
    },
  "unbrowse_breath_select": async (args) => {
      await ensureServerReady();
      return successResult(await api("POST", "/v1/browse/select", {
        ref: args.ref,
        value: args.value,
        ...(typeof args.session_id === "string" ? { session_id: args.session_id } : {}),
      }), "Option selected.");
    },
  "unbrowse_breath_scroll": async (args) => {
      await ensureServerReady();
      const body: Record<string, unknown> = {};
      if (typeof args.direction === "string") body.direction = args.direction;
      if (typeof args.amount === "number") body.amount = args.amount;
      if (typeof args.session_id === "string") body.session_id = args.session_id;
      return successResult(await api("POST", "/v1/browse/scroll", body), "Scroll applied.");
    },
  "unbrowse_breath_submit": async (args) => {
      await ensureServerReady();
      const body: Record<string, unknown> = {};
      for (const key of ["form_selector", "submit_selector", "wait_for", "assist_site_state", "same_origin_fetch_fallback", "timeout_ms", "session_id"] as const) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      const result = await api("POST", "/v1/browse/submit", body) as Record<string, unknown>;
      const nestedError = resolveNestedError(result);
      return nestedError ? errorResult(nestedError, result) : successResult(result, "Submit result.");
    },
  "unbrowse_eval_screenshot": async (args) => {
      await ensureServerReady();
      const result = await api("GET", "/v1/browse/screenshot", typeof args.session_id === "string" ? { session_id: args.session_id } : undefined) as Record<string, unknown>;
      if (typeof result.screenshot !== "string") return errorResult("screenshot data missing", result);
      return imageResult(result.screenshot, { tab_id: result.tab_id ?? null });
    },
  "unbrowse_eval_text": async (args) => {
      await ensureServerReady();
      return successResult(await api("GET", "/v1/browse/text", typeof args.session_id === "string" ? { session_id: args.session_id } : undefined), "Current page text.");
    },
  "unbrowse_eval_markdown": async (args) => {
      await ensureServerReady();
      return successResult(await api("GET", "/v1/browse/markdown", typeof args.session_id === "string" ? { session_id: args.session_id } : undefined), "Current page markdown.");
    },
  "unbrowse_eval_cookies": async (args) => {
      await ensureServerReady();
      return successResult(await api("GET", "/v1/browse/cookies", typeof args.session_id === "string" ? { session_id: args.session_id } : undefined), "Current page cookies.");
    },
  "unbrowse_breath_run_js": async (args) => {
      await ensureServerReady();
      return successResult(await api("POST", "/v1/browse/eval", {
        expression: args.expression,
        ...(typeof args.session_id === "string" ? { session_id: args.session_id } : {}),
      }), "JavaScript evaluation result.");
    },
  "unbrowse_breath_sync": async (args) => {
      await ensureServerReady();
      const result = await api("POST", "/v1/browse/sync", typeof args.session_id === "string" ? { session_id: args.session_id } : undefined);
      const withHints = addCaptureNextStepHints(result, args);
      return successResult(withHints, "Capture checkpointed. Indexed locally. Public marketplace publish waits for unbrowse_build_review (you are opted in; reviewed skills earn x402 rewards in your wallet - run `unbrowse setup` to pair one if needed). See _workflow_hints.opt_out_command to stay private.");
    },
  "unbrowse_breath_close": async (args) => {
      await ensureServerReady();
      const result = await api("POST", "/v1/browse/close", typeof args.session_id === "string" ? { session_id: args.session_id } : undefined);
      const withHints = addCaptureNextStepHints(result, args);
      const wrapped = successResult(withHints, "Browse session closed. Indexed locally. Public marketplace publish waits for unbrowse_build_review (you are opted in; reviewed skills earn x402 rewards in your wallet - run `unbrowse setup` to pair one if needed). See _workflow_hints.opt_out_command to stay private.");
      setBrowseSessionOpen(false);
      return wrapped;
    },
  "unbrowse_build_annotate": async (args: Record<string, unknown>) => {
      await ensureServerReady();
      const skillId = args.skill as string;
      const endpointId = args.endpoint as string;
      const body: Record<string, unknown> = {};
      if (Array.isArray(args.constraints)) body.constraints = args.constraints;
      if (Array.isArray(args.annotations)) body.annotations = args.annotations;
      if (!body.constraints && !body.annotations) return errorResult("Provide constraints and/or annotations");
      const result = await api("POST", `/v1/skills/${skillId}/endpoints/${endpointId}/annotate`, body);
      return successResult(result, "Annotation saved. Other agents will see your contribution when using this endpoint.");
    },
  "unbrowse_diagnose": async (args) => {
      await ensureServerReady();
      const sessionId = typeof args.session_id === "string" ? args.session_id : undefined;
      const screenshot = await api("GET", "/v1/browse/screenshot", sessionId ? { session_id: sessionId } : undefined) as Record<string, unknown>;
      const diagnostic = await api("GET", "/v1/stats/health", undefined) as Record<string, unknown>;
      return successResult({
        screenshot: typeof screenshot.screenshot === "string" ? screenshot.screenshot : null,
        tab_id: (screenshot as { tab_id?: string }).tab_id ?? null,
        diagnosis_context: args.context ?? null,
        status: diagnostic,
      }, "Diagnosis capture complete. Screenshot + context returned.");
    },
  "unbrowse_eval_trace": async (args) => {
      await ensureServerReady();
      const result = await api("GET", `/v1/trace/${args.trace_id ?? "latest"}`, undefined);
      return successResult(result, "Execution trace with diagnostic context.");
    },
  "unbrowse_validate": async (args) => {
      await ensureServerReady();
      const result = await api("GET", `/v1/skills/${args.skill_id}/validate`, args.url ? { url: args.url } : undefined);
      return successResult(result, "Skill validation complete. Returns screenshots + endpoint match quality.");
    },
  "billing_status": async () => {
      const apiKey = getApiKey();
      if (!apiKey) return errorResult("No API key configured. Run `unbrowse setup` first.");
      const { DEFAULT_BACKEND_URL } = await import("./version.js");
      const base = process.env.UNBROWSE_API_URL ?? process.env.UNBROWSE_BACKEND_URL ?? DEFAULT_BACKEND_URL;
      const r = await fetch(`${base}/v1/account/billing-status`, { headers: { Authorization: `Bearer ${apiKey}` } });
      const body = (await r.json()) as Record<string, unknown>;
      if (typeof body.error === "string") return errorResult(body.error, body);
      return successResult(body, "Billing status.");
    },
  "billing_subscribe_url": async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) return errorResult("No API key configured. Run `unbrowse setup` first.");
      const { DEFAULT_BACKEND_URL } = await import("./version.js");
      const base = process.env.UNBROWSE_API_URL ?? process.env.UNBROWSE_BACKEND_URL ?? DEFAULT_BACKEND_URL;
      const payload: Record<string, unknown> = {};
      if (typeof args.plan_id === "string") payload.plan_id = args.plan_id;
      if (typeof args.return_url === "string") payload.return_url = args.return_url;
      const r = await fetch(`${base}/v1/account/billing-subscribe-url`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await r.json()) as Record<string, unknown>;
      if (typeof body.error === "string") return errorResult(body.error, body);
      return successResult(body, "Stripe checkout URL.");
    },
  "billing_portal_url": async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) return errorResult("No API key configured. Run `unbrowse setup` first.");
      const { DEFAULT_BACKEND_URL } = await import("./version.js");
      const base = process.env.UNBROWSE_API_URL ?? process.env.UNBROWSE_BACKEND_URL ?? DEFAULT_BACKEND_URL;
      const payload: Record<string, unknown> = {};
      if (typeof args.return_url === "string") payload.return_url = args.return_url;
      const r = await fetch(`${base}/v1/account/billing-portal-url`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await r.json()) as Record<string, unknown>;
      if (typeof body.error === "string") return errorResult(body.error, body);
      return successResult(body, "Stripe customer portal URL.");
    },
  "unbrowse_breath_run": async (args) => {
      const resolveTool = toolMap.get("unbrowse_eval_resolve");
      if (!resolveTool) {
        return errorResult("unbrowse_eval_resolve handler not found (registry not yet loaded).");
      }
      const inner = await resolveTool.handler(args);
      const innerRec = inner as Record<string, unknown>;
      const sc = (innerRec.structuredContent as Record<string, unknown> | undefined) ?? {};
      const { isError: _isError, ...rest } = innerRec;
      void _isError;
      return {
        ...rest,
        structuredContent: { ...sc, deprecated: true, renamed_to: "unbrowse_eval_resolve" },
      } as typeof inner;
    },
  "unbrowse_breath_fetch": async (_args) => {
      return {
        content: [{
          type: "text",
          text: "unbrowse_breath_fetch was removed. Call unbrowse_eval_resolve.",
        }],
        structuredContent: {
          deprecated: true,
          renamed_to: "unbrowse_eval_resolve",
          error: "unbrowse_breath_fetch was removed. Call unbrowse_eval_resolve.",
        },
      };
    },
  "unbrowse_eval_auth_inventory": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("eval:auth_inventory", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_eval_spec_discover": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("eval:spec_discover", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_build_skill": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("build:skill", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_build_template": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("build:template", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_build_publish_bundle": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("build:publish_bundle", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_build_skill_package": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("build:skill_package", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_build_cleanup_stale": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("build:cleanup_stale", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_breath_fill_form": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("breath:fill_form", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_breath_proxy_rotate": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("breath:proxy_rotate", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_breath_session_park": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("breath:session_park", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_breath_session_restore": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("breath:session_restore", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_breath_get": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("breath:get", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_breath_capture": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("breath:capture", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_breath_back": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("breath:back", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_breath_forward": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("breath:forward", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_breath_auth_login": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("breath:auth_login", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_eval_status": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("eval:status", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_eval_version": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("eval:version", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_eval_explain": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("eval:explain", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
  "unbrowse_eval_browsers": async (args: Record<string, unknown>) =>
      dispatchResultToToolResult(await dispatchByKind("eval:browsers", args, { json: true })),
  "unbrowse_eval_research": async (args: Record<string, unknown>) =>
      dispatchResultToToolResult(await dispatchByKind("eval:research", args, { json: true })),
  "unbrowse_eval_extract": async (args: Record<string, unknown>) =>
      dispatchResultToToolResult(await dispatchByKind("eval:extract", args, { json: true })),
  "unbrowse_eval_map": async (args: Record<string, unknown>) =>
      dispatchResultToToolResult(await dispatchByKind("eval:map", args, { json: true })),
  "unbrowse_eval_crawl": async (args: Record<string, unknown>) =>
      dispatchResultToToolResult(await dispatchByKind("eval:crawl", args, { json: true })),
  "unbrowse_eval_inspect": async (args: Record<string, unknown>) => {
      const dispatched = await dispatchByKind("eval:inspect", args, { json: true });
      return dispatchResultToToolResult(dispatched);
    },
};

// Bound by NAME from the pure schema module. A schema with no handler (or a
// handler with no schema) fails loudly at startup instead of drifting quietly.
const tools: ToolDefinition[] = [
  ...TOOL_SCHEMAS.map((s): ToolDefinition => {
    const handler = toolHandlers[s.name];
    if (!handler) throw new Error(`mcp: schema "${s.name}" has no handler`);
    return { ...s, handler };
  }),
  // === Harness #2: Visual context MCP tools ===
  // Dev-only: type parity audit tool. Available when source files exist (running from repo).
  // Harness verify scripts call this instead of running a local Python extractor.
  // Pointer-not-payload: the intelligence (field diff logic) lives server-side in the MCP tool;
  // the local harness calls MCP and judges the returned evidence in-thread.
  ...(existsSync("backend/src/types.ts") ? [{
    name: "unbrowse_type_audit",
    description:
      "Dev tool: audit type parity between the canonical backend EndpointDescriptor and its SDK/CLI counterparts. " +
      "Returns raw field-diff evidence: missing_in_sdk, stale_in_sdk, missing_in_cli, field counts per file. " +
      "Available only when running from source (backend/src/types.ts exists). " +
      "Harness verify scripts call this instead of running a local Python field extractor.",
    inputSchema: {
      type: "object",
      properties: {
        interface_name: {
          type: "string",
          description: "Interface to audit. Defaults to EndpointDescriptor.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
      const name = typeof args.interface_name === "string" ? args.interface_name : "EndpointDescriptor";
      const FILES = {
        backend: "backend/src/types.ts",
        cli: "src/types/skill.ts",
        sdk: "packages/sdk/src/contracts.ts",
      } as const;

      function extractFields(filePath: string, interfaceName: string): string[] {
        const content = readFileSync(filePath, "utf8");
        const lines = content.split("\n");
        const startIdx = lines.findIndex((l) =>
          new RegExp(`^\\s*export interface ${interfaceName}\\s*\\{`).test(l),
        );
        if (startIdx === -1) return [];
        let depth = 0;
        const bodyLines: string[] = [];
        for (let i = startIdx; i < lines.length; i++) {
          const l = lines[i];
          depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
          bodyLines.push(l);
          if (depth <= 0) break;
        }
        return bodyLines
          .filter((l) => /^\s{2,4}\w+\??:/.test(l) && !/^\s{6}/.test(l))
          .map((l) => l.match(/^\s{2,4}(\w+)\??:/)![1]);
      }

      try {
        const backend = extractFields(FILES.backend, name);
        const cli = extractFields(FILES.cli, name);
        const sdk = extractFields(FILES.sdk, name);
        const backendSet = new Set(backend);
        const cliSet = new Set(cli);
        const sdkSet = new Set(sdk);
        const evidence = {
          interface: name,
          backend_field_count: backendSet.size,
          sdk_field_count: sdkSet.size,
          cli_field_count: cliSet.size,
          missing_in_sdk: [...backendSet].filter((f) => !sdkSet.has(f)).sort(),
          stale_in_sdk: [...sdkSet].filter((f) => !backendSet.has(f)).sort(),
          missing_in_cli: [...backendSet].filter((f) => !cliSet.has(f)).sort(),
          extra_in_cli: [...cliSet].filter((f) => !backendSet.has(f)).sort(),
          files: FILES,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(evidence, null, 2) }],
          structuredContent: evidence,
        };
      } catch (e) {
        return { content: [{ type: "text", text: `type_audit error: ${e}` }], isError: true };
      }
    },
  } satisfies ToolDefinition] : []),
  // W24.8 — v7-native tool surfaces. These dispatch directly through the
  // v7 kind-map (eval auth-inventory / eval spec) regardless of the
  // UNBROWSE_MCP_V7_DISPATCH gate, because there is no v6 backend route
  // to fall back to. The 1:1:1 contract (mcp_tool <-> op_kind <->
  // CLI subcommand) is honored by routing through dispatchByKind.
  // W24.8 cont. — newer kind-map capabilities, each registered 1:1 with its
  // op_kind and dispatched through dispatchByKind (no v6 backend fallback).
  // build verb -----------------------------------------------------------
  // breath verb ----------------------------------------------------------
  // eval verb ------------------------------------------------------------
  // Day 5 Phase 0c test-only crash trigger. Registered ONLY when
  // UNBROWSE_TEST_CRASH=1 is set in the env. Throws synchronously so the
  // tools/call catch + the process-level resilience guards can be exercised
  // by tests/mcp-fetch-resilience.test.ts. Substrate enables (env-gated
  // additive tool), does not prescribe (no hardcoded test pattern).
  ...(process.env.UNBROWSE_TEST_CRASH === "1" ? [{
    name: "unbrowse_test_crash",
    description: "TEST ONLY. Throws synchronously to exercise the MCP resilience guard. Not a real tool.",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    handler: async (_args: Record<string, unknown>): Promise<ToolResult> => {
      throw new Error("intentional test crash from unbrowse_test_crash");
    },
  } satisfies ToolDefinition] : []),
];

const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
  writeStdout({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function jsonRpcResult(id: JsonRpcId, result: unknown): void {
  writeStdout({ jsonrpc: "2.0", id, result });
}

function jsonRpcNotification(method: string, params?: Record<string, unknown>): void {
  writeStdout({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
}

// Phase 2 (cheatsheet): session-aware tool visibility for on-the-fly reveal.
export const SESSION_TOOL_NAMES = new Set([
  "unbrowse_eval_snap",
  "unbrowse_breath_click",
  "unbrowse_breath_fill",
  "unbrowse_breath_type",
  "unbrowse_breath_press",
  "unbrowse_breath_select",
  "unbrowse_breath_scroll",
  "unbrowse_breath_submit",
  "unbrowse_eval_screenshot",
  "unbrowse_eval_text",
  "unbrowse_eval_markdown",
  "unbrowse_eval_cookies",
  "unbrowse_breath_run_js",
  "unbrowse_breath_sync",
  "unbrowse_breath_close",
]);

// Track the count of currently-open browse sessions, not a single boolean.
// Pre-fix: a single boolean flipped true on any go and false on any close,
// so 4 parallel sessions with their own session_ids hit a race: the first
// close set the flag to false and the next 3 closes saw "no_browse_session_open"
// even though their sessions were alive. Proven 2026-05-18 by the 4-probe
// parallel MCP falsifier post-broker-isolation-fix: 3/4 close calls failed
// with this exact error. A counter is the right shape — increment on go
// success, decrement (clamp >=0) on close completion, gate on counter===0.
let browseSessionOpenCount = 0;

export function setBrowseSessionOpen(open: boolean): void {
  const wasOpen = browseSessionOpenCount > 0;
  if (open) {
    browseSessionOpenCount += 1;
  } else if (browseSessionOpenCount > 0) {
    browseSessionOpenCount -= 1;
  }
  const isOpen = browseSessionOpenCount > 0;
  if (wasOpen !== isOpen) jsonRpcNotification("notifications/tools/list_changed");
}

export function getBrowseSessionOpen(): boolean {
  return browseSessionOpenCount > 0;
}

function visibleTools(): typeof tools {
  // Agent surface (default): few tools so hosts don't present a 60-tool menu.
  // Full surface: every tool (session tools still always listed so frozen
  // catalogs can call them; no-session calls error truthfully).
  // UNBROWSE_MCP_SURFACE=full|agent
  if (mcpSurfaceMode() === "full") return tools;
  return tools.filter((t) => AGENT_MCP_TOOL_NAMES.has(t.name));
}

let initializeSeen = false;
let negotiatedProtocolVersion = LATEST_PROTOCOL_VERSION;

// Phase 0d: with no resident daemon, queued capture-pipeline work
// (queueBackgroundIndex from unbrowse_breath_close) must be drained by the
// stdio process itself. Each tool call kicks a deduped fire-and-forget
// drain so a prior close's index/publish lands without blocking close.
let spoolDrainInFlight = false;
function maybeDrainSpool(): void {
  if (spoolDrainInFlight) return;
  spoolDrainInFlight = true;
  void Promise.allSettled([drainPendingIndexJobs(), drainPendingPassivePublishes()])
    .finally(() => {
      spoolDrainInFlight = false;
    });
}
export async function handleRequest(message: JsonRpcRequest): Promise<void> {
  const id = message.id ?? null;
  const method = message.method;
  const params = isPlainObject(message.params) ? message.params : {};

  // Day 5 Phase 0c: stamp the in-flight id so process.on guards can emit an
  // error envelope to the right slot if a handler throws asynchronously.
  currentRequestId = id;
  try {
  if (!method) {
    jsonRpcError(id, -32600, "Invalid Request");
    return;
  }

  if (method === "initialize") {
    const requestedVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
    negotiatedProtocolVersion = requestedVersion && SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number])
      ? requestedVersion
      : LATEST_PROTOCOL_VERSION;

    try {
      await ensureServerReady();
    } catch (error) {
      jsonRpcError(id, -32000, error instanceof Error ? error.message : String(error));
      return;
    }

    initializeSeen = true;
    jsonRpcResult(id, {
      protocolVersion: negotiatedProtocolVersion,
      capabilities: {
        tools: {
          listChanged: true,
        },
        resources: {
          listChanged: false,
        },
        prompts: {
          listChanged: true,
        },
      },
      serverInfo: {
        name: "unbrowse",
        title: "Unbrowse",
        version: getVersion(),
        description: "The route layer for web agents. Use Unbrowse for website tasks: it learns first-party routes from real traffic, replays them when known, and keeps a browser only when the site still requires it.",
      },
      instructions: FULL_SKILL_GUIDANCE,
    });
    return;
  }

  if (method === "notifications/initialized") return;

  if (method === "ping") {
    jsonRpcResult(id, {});
    return;
  }

  if (!initializeSeen) {
    jsonRpcError(id, -32002, "Server not initialized");
    return;
  }

  if (method === "tools/list") {
    jsonRpcResult(id, {
      tools: visibleTools().map(listTool),
    });
    return;
  }

  if (method === "resources/list") {
    jsonRpcResult(id, {
      resources: [...listWorkflowResources(), ...listStatsResources(), ...listUserContextResources(), ...listSetupResources(), ...listDocsResources()].map(listResource),
    });
    return;
  }

  if (method === "resources/read") {
    const uri = typeof params.uri === "string" ? params.uri : undefined;
    if (!uri) {
      jsonRpcError(id, -32602, "Resource uri is required");
      return;
    }
    const resource = [...listWorkflowResources(), ...listStatsResources(), ...listUserContextResources(), ...listSetupResources(), ...listDocsResources()].find((entry) => entry.uri === uri);
    if (!resource) {
      jsonRpcError(id, -32602, `Unknown resource: ${uri}`);
      return;
    }
    // Async-aware: workflow/stats reads are sync, user-context reads are async
    // (they touch keychain, browser SQLite, etc.). Await whatever the resource
    // returns so the textResource serializer sees the resolved value.
    const value = await Promise.resolve(resource.read());
    jsonRpcResult(id, {
      contents: [textResource(resource.uri, value, resource.mimeType)],
    });
    return;
    return;
  }

  if (method === "prompts/list") {
    jsonRpcResult(id, {
      prompts: prompts.map(listPrompt),
    });
    return;
  }

  if (method === "prompts/get") {
    const name = typeof params.name === "string" ? params.name : undefined;
    const promptArgs = isPlainObject(params.arguments) ? params.arguments : {};
    if (!name) {
      jsonRpcError(id, -32602, "Prompt name is required");
      return;
    }
    const prompt = promptMap.get(name);
    if (!prompt) {
      jsonRpcError(id, -32602, `Unknown prompt: ${name}`);
      return;
    }
    jsonRpcResult(id, prompt.get(promptArgs));
    return;
  }

  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : undefined;
    const toolArgs = isPlainObject(params.arguments) ? params.arguments : {};
    if (!name) {
      jsonRpcError(id, -32602, "Tool name is required");
      return;
    }

    const tool = toolMap.get(name);
    if (!tool) {
      jsonRpcError(id, -32602, `Unknown tool: ${name}`);
      return;
    }

    const validationErrors = validateArguments(tool.inputSchema, toolArgs);
    if (validationErrors.length > 0) {
      jsonRpcResult(id, errorResult(`Invalid arguments for ${name}`, { errors: validationErrors }));
      return;
    }

    // Session-scoped tools operate on a live browse session. They are
    // always discoverable in tools/list so a client whose catalog is
    // frozen before a session exists (a spawned sub-agent never sees the
    // post-go list_changed) can still find them. Calling one with no open
    // session would block the handler waiting on a browser that does not
    // exist, so surface the truth: a fast structured error pointing at
    // unbrowse_breath_navigate, instead of hiding the tool or hanging.
    if (SESSION_TOOL_NAMES.has(name) && !getBrowseSessionOpen()) {
      jsonRpcResult(
        id,
        errorResult(
          `${name} needs a live browse session. Prefer unbrowse_breath_get for ordinary reads. For real DOM interaction only: unbrowse_breath_navigate, then retry.`,
          {
            error: "no_browse_session_open",
            tool: name,
            next_step: "unbrowse_breath_get",
            next_action: { command: "unbrowse_breath_get" },
          },
        ),
      );
      return;
    }

    const telemetryLogger = getSessionLogger();
    const callId = telemetryLogger.recordToolStart(name, toolArgs);
    const kind = TOOL_TO_KIND.get(name);
    const usageEntry = kind ? findKindEntry(kind) : undefined;
    // Per-tool aggregate only: op kind + surface, never arguments, URL, intent,
    // response, or credential material. Session JSONL remains local.
    void reportUsage(usageEntry?.subcommand.split(" ").at(-1) ?? "mcp", {
      operation: kind,
      surface: "mcp",
      execution_scope: "mixed",
    });
    try {
      // v7 dispatch interceptor — Acts 2:6, every surface speaks its own
      // language but they all point at the same act. When opt-in is set
      // for this tool, the dispatch path runs first; on fallback_to_v6
      // the original handler runs.
      let result: ToolResult | undefined;
      if (kind && v7DispatchEnabledFor(name)) {
        try {
          const dispatched = await traceAsync(
            "mcp",
            undefined,
            `v7-dispatch:${name}`,
            () => dispatchByKind(kind, toolArgs, { json: true }),
          );
          if (!dispatched.fallback_to_v6 && !dispatched.dispatch_error) {
            result = dispatchResultToToolResult(dispatched);
          }
        } catch (dispatchErr) {
          // Dispatch infrastructure failure (NOT handler failure — handler
          // failures are captured in DispatchResult.exitCode). Surface as
          // a v6 fall-through so the wire stays stable.
          const msg = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
          writeStderr(`v7 dispatch infra error for ${name}: ${msg}; falling back to v6`);
        }
      }
      if (result === undefined) {
        result = await traceAsync("mcp", undefined, `tools-call:${name}`, () => tool.handler(toolArgs));
      }
      // Pull decision_trace out of structured results if the handler
      // produced one (resolve/execute do). Pass through unmodified —
      // it's already structural (step names per the convention).
      const decision_trace = extractDecisionTrace(result);
      const toolSucceeded = !isErrorToolResult(result);
      telemetryLogger.recordToolEnd(callId, {
        tool: name,
        success: toolSucceeded,
        result,
        decision_trace,
      });
      jsonRpcResult(id, result);
    } catch (error) {
      // Handler throw means real bug, not a planned errorResult. Emit a
      // JSON-RPC -32603 envelope so the agent sees a clean failure signal;
      // pipe stays open and subsequent calls work. (Day 5 Phase 0c.)
      const message = error instanceof Error ? error.message : String(error);
      telemetryLogger.recordToolEnd(callId, { tool: name, success: false, error: { message } });
      jsonRpcError(id, -32603, "Internal error", { message });
    }
    return;
  }

  if (method.startsWith("notifications/")) {
    if (method === "notifications/cancelled") return;
    return;
  }

  jsonRpcError(id, -32601, `Method not found: ${method}`);
  } finally {
    currentRequestId = null;
  }
}
/**
 * Probe localhost:6969 at MCP startup. Phase 0d binaries don't bind it,
 * but older globally-installed `unbrowse` binaries auto-spawn a daemon
 * there. When both run, kuri broker state leaks and the browse transport
 * wedges (memory: reference_mcp_wedged_by_stale_global_daemon).
 *
 * Substrate-correct behaviour: detect, warn loudly with the exact
 * remediation command, and keep going. We do NOT auto-kill because the
 * user may be running `unbrowse serve` intentionally — a heuristic that
 * decides "the user actually wants this dead" baked into the substrate
 * is the kind of prescription this codebase doesn't tolerate.
 */
export async function probeStaleDaemonAndWarn(): Promise<void> {
  if (process.env.UNBROWSE_SKIP_DAEMON_PROBE === "1") return;
  const probeUrl = process.env.UNBROWSE_DAEMON_PROBE_URL ?? "http://localhost:6969/health";
  const timeoutMs = Number(process.env.UNBROWSE_DAEMON_PROBE_TIMEOUT_MS ?? 250);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(probeUrl, { signal: controller.signal }).catch(() => null);
    clearTimeout(timer);
    if (!res) return; // nothing listening — clean
    writeStderr("WARN: a process is responding on localhost:6969 — likely a stale `unbrowse` daemon from an older global install.");
    writeStderr("  This MCP runs the API in-process; the daemon doesn't help it, but kuri state can leak across both and wedge the browse transport.");
    writeStderr("  Fix:   pkill -9 -f 'unbrowse|kuri'; sleep 2");
    writeStderr("  Skip:  set UNBROWSE_SKIP_DAEMON_PROBE=1 if you're running `unbrowse serve` intentionally.");
  } catch {
    clearTimeout(timer);
    // probe error (DNS, AbortError, etc.) — silently treat as clean.
  }
}

async function main(): Promise<void> {
  // Day 5 Phase 0c: convert async throws into JSON-RPC envelopes routed to the
  // in-flight request id. currentRequestId is module-level (above the tools
  // array) so handleRequest can stamp it. These guards catch the second-order
  // throw class - timer/setImmediate/queueMicrotask rejections that escape
  // the awaited handler's try/catch. The pipe stays open across these events.
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[mcp uncaughtException id=${String(currentRequestId)}] ${err.stack ?? err.message ?? String(err)}\n`);
    if (currentRequestId !== null) {
      jsonRpcError(currentRequestId, -32603, "Internal error", { message: err instanceof Error ? err.message : String(err) });
      currentRequestId = null;
    }
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[mcp unhandledRejection id=${String(currentRequestId)}] ${String(reason)}\n`);
    if (currentRequestId !== null) {
      jsonRpcError(currentRequestId, -32603, "Internal error", { message: reason instanceof Error ? reason.message : String(reason) });
      currentRequestId = null;
    }
  });
  // Telemetry: open session log (no-op when disabled). flushSession is
  // idempotent so it's safe to wire to multiple shutdown signals.
  const telemetryLogger = getSessionLogger();
  telemetryLogger.start();
  if (telemetryLogger.enabled) {
    writeStderr(`telemetry: session ${telemetryLogger.session_id} → ${telemetryLogger.sessionFilePath() ?? "(no file)"}`);
  } else {
    const cfg = getResolvedTelemetryConfig();
    writeStderr(`telemetry: disabled (source=${cfg.source})`);
  }
  let flushed = false;
  const flushSession = async (): Promise<void> => {
    if (flushed) return;
    flushed = true;
    try {
      telemetryLogger.end();
      // Fire-and-forget upload; await briefly so beforeExit can complete it.
      // SIGINT/SIGTERM paths exit before the await resolves — acceptable.
      await telemetryLogger.flushUpload();
    } catch (err) {
      writeStderr(`[telemetry] flush error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // Reap every browser broker tree THIS server spawned. The obscura broker is
  // `detached`+`unref`'d (its own process group), so on our exit it would
  // otherwise reparent to init and accumulate across agent sessions until the
  // host OOMs. Fully synchronous and idempotent, so it is safe from the
  // `process.on('exit')` backstop as well as the async signal/EOF paths. The
  // kuri broker tree is reaped by its own `process.once('exit')` hook
  // (src/kuri/client.ts), which now fires because these paths call process.exit.
  let browsersReaped = false;
  const shutdownBrowserTrees = (): void => {
    if (browsersReaped) return;
    browsersReaped = true;
    try {
      const n = reapOwnObscuraSessions();
      if (n > 0) writeStderr(`reaped ${n} obscura broker tree(s) on shutdown`);
    } catch (err) {
      writeStderr(`[shutdown] browser reap error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // Synchronous last line of defence: fires on ANY exit path (clean drain,
  // process.exit from a signal handler, uncaught fatal) so a spawned broker
  // never outlives the server even if a more graceful path was skipped.
  process.on("exit", () => {
    shutdownBrowserTrees();
  });
  const gracefulExit = (): void => {
    shutdownBrowserTrees();
    void flushSession().finally(() => process.exit(0));
  };
  process.on("SIGINT", gracefulExit);
  process.on("SIGTERM", gracefulExit);
  // SIGHUP: the controlling process/terminal went away (a common agent-death
  // signal). Previously unhandled — the default action terminated the server
  // WITHOUT running any cleanup, orphaning the broker tree. Reap first.
  process.on("SIGHUP", gracefulExit);
  process.on("beforeExit", () => {
    void flushSession();
  });

  // Stale-global-daemon probe. Phase 0d removed the :6969 HTTP daemon
  // from this build, but users still have older `unbrowse` binaries
  // globally installed that auto-spawn one. If both are running, kuri
  // state can leak across them and the browse transport wedges
  // (memory: reference_mcp_wedged_by_stale_global_daemon). Probe
  // localhost:6969 with a 250ms timeout — if anything answers, surface
  // a loud actionable warning. We do NOT auto-kill (the user may be
  // running `unbrowse serve` intentionally); we tell them what to do.
  await probeStaleDaemonAndWarn();

  writeStderr("starting stateless stdio MCP (in-process API, no daemon)");

  // Credential handoff: surface a registration URL on startup when no API key
  // is configured. Stderr only — the stdio JSON-RPC channel stays clean.
  // We do NOT block startup or refuse tool calls; many local tools (browse_go,
  // snap, eval) work without a backend-registered agent. The agent reading the
  // boot log sees the URL and can guide the user through registration.
  // Respects UNBROWSE_WEB_URL for self-hosted / staging deploys.
  try {
    const envKey = process.env.UNBROWSE_API_KEY?.trim();
    const configKey = loadConfig()?.api_key?.trim();
    if (!envKey && !configKey) {
      const webUrl = (process.env.UNBROWSE_WEB_URL ?? "https://unbrowse.ai").replace(/\/+$/, "");
      writeStderr("no API key configured — backend-bound tools (resolve/execute/publish/earnings) will fail until you register.");
      writeStderr(`  register:  ${webUrl}/login?cli=1`);
      writeStderr(`  or run:    npx unbrowse register`);
      writeStderr(`  or set:    export UNBROWSE_API_KEY=<key>`);
    }
  } catch (err) {
    writeStderr(`credential check skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const message = JSON.parse(trimmed) as JsonRpcRequest;
      if (message.jsonrpc && message.jsonrpc !== "2.0") {
        jsonRpcError(message.id ?? null, -32600, "Invalid Request", { expected: "2.0", received: message.jsonrpc });
        continue;
      }
      // BUG-4 mitigation: every handler runs with a hard timeout so the
      // read loop always advances. Without this a slow unbrowse_breath_navigate on a
      // hostile site can block the loop indefinitely; the MCP client's
      // heartbeat then times out and reports the server as disconnected
      // even though it's still alive. The 2026-05-17 MCP bench-gate run
      // saw this fail mode three times under concurrent subagent load.
      // Surfaces the timeout as a structured error response on the same
      // request id; the handler itself continues in the background (it
      // may still write its eventual response, which the client should
      // ignore since the id is already resolved).
      const timeoutMs = parseInt(process.env.UNBROWSE_MCP_HANDLER_TIMEOUT_MS ?? "90000", 10) || 90000;
      const id = message.id ?? null;
      const handlerPromise = handleRequest(message).catch((err) => {
        writeStderr(err instanceof Error ? err.stack ?? err.message : String(err));
      });
      let timedOut = false;
      const timeoutPromise = new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          timedOut = true;
          jsonRpcError(
            id,
            -32001,
            `handler_timeout: request exceeded ${timeoutMs}ms`,
            { method: message.method ?? "unknown", timeout_ms: timeoutMs },
          );
          resolve();
        }, timeoutMs);
        handlerPromise.finally(() => {
          clearTimeout(t);
          if (!timedOut) resolve();
        });
      });
      await timeoutPromise;
      // Phase 0d: no daemon to drain the capture spool on a timer. Each
      // tool call opportunistically drains queued index/passive-publish
      // jobs from a prior unbrowse_breath_close (deduped, fire-and-forget).
      maybeDrainSpool();
    } catch (error) {
      writeStderr(error instanceof Error ? error.stack ?? error.message : String(error));
    }
  }
  // stdin closed — the agent/client disconnected (its pipe write-end closes on
  // exit, so this EOF fires whether the agent quit cleanly, was SIGTERM'd, or
  // was SIGKILL'd). This is THE universal "the session is over" signal. Reap the
  // broker trees we spawned and exit deterministically: relying on natural
  // event-loop drain is unsafe because a kuri broker's piped stdio keeps the
  // loop alive, so the server would otherwise linger with its whole tree.
  shutdownBrowserTrees();
  await flushSession();
  process.exit(0);
}

main().catch((error) => {
  writeStderr(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
