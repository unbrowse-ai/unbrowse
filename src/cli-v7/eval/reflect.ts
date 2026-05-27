/**
 * `unbrowse eval reflect` — reflect on user-facing outcome.
 *
 * 1:1 mapping (kind-map.ts row "eval reflect"):
 *   CLI subcommand  : eval reflect
 *   MCP tool        : unbrowse_reflect
 *   Covenant kind   : observe_reflect
 *   Verb            : eval
 *
 * Anonymous — only the outcome value is recorded (per the MCP server's
 * REFLECTION instruction in this repo's mcp.ts). Skip-for-diagnostics
 * applies to the calling agent, NOT to the surface here.
 *
 * Wire: POST `${UNBROWSE_API_URL}/v1/stats/reflect`
 * Body: `{ skill_id, endpoint_id, intent_status }`
 *   where intent_status ∈ { "achieved", "partial", "failed" }.
 *
 * OUTCOME-ONLY INVARIANT (load-bearing — see CLAUDE.md MCP server
 * REFLECTION block): this handler emits ONLY the outcome + the
 * (skill,endpoint) identity. No pointers. No resolved values. No
 * intent text. No session bodies. No URLs. The wallet/agent identity
 * is the `Authorization: Bearer <api-key>` header — server-side
 * `optionalAuth` resolves it to an agent_id without us ever
 * transmitting it in the body.
 */
import type { ParsedV7Args } from "../args.js";
import {
  EX_GENERIC,
  EX_USAGE,
  emit,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";

export type ReflectOutcome = "achieved" | "partial" | "failed";

const VALID_OUTCOMES: ReadonlySet<string> = new Set(["achieved", "partial", "failed"]);

/**
 * Normalize CLAUDE.md's MCP-side outcome vocabulary
 * (`achieved | failed | partial`) plus a couple of common synonyms
 * the backend's stats route accepts.
 */
export function normalizeOutcome(raw: string): ReflectOutcome | null {
  const lower = raw.toLowerCase();
  if (lower === "achieved" || lower === "success" || lower === "ok") return "achieved";
  if (lower === "partial") return "partial";
  if (lower === "failed" || lower === "failure" || lower === "fail") return "failed";
  return VALID_OUTCOMES.has(lower) ? (lower as ReflectOutcome) : null;
}

function defaultApiBase(): string {
  return (
    process.env.UNBROWSE_API_URL ??
    process.env.UNBROWSE_BACKEND_URL ??
    "https://beta-api.unbrowse.ai"
  );
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "reflect")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval reflect",
      {
        summary: meta.summary,
        usage: "unbrowse eval reflect --outcome <achieved|partial|failed> --skill <id> --endpoint <id> [--session-id <id>]",
        flags: [
          { name: "--outcome", description: "achieved | partial | failed.", value_expected: true },
          { name: "--skill", description: "Skill id whose reliability the reflect updates.", value_expected: true },
          { name: "--endpoint", description: "Endpoint id whose reliability the reflect updates.", value_expected: true },
          { name: "--session-id", description: "Session id (local trail only — not sent to backend).", value_expected: true },
        ],
        covenant_kind: meta.covenant_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const outcomeFlag = typeof parsed.flags.outcome === "string" ? parsed.flags.outcome : undefined;
  const skillFlag = typeof parsed.flags.skill === "string" ? parsed.flags.skill : undefined;
  const endpointFlag = typeof parsed.flags.endpoint === "string" ? parsed.flags.endpoint : undefined;

  if (!outcomeFlag || !skillFlag || !endpointFlag) {
    emit(
      {
        ok: false,
        subcommand: "eval reflect",
        covenant_kind: meta.covenant_kind,
        error: "missing_required",
        required: ["--outcome", "--skill", "--endpoint"],
        got: { outcome: outcomeFlag, skill: skillFlag, endpoint: endpointFlag },
      },
      opts,
    );
    process.exit(EX_USAGE);
  }

  const outcome = normalizeOutcome(outcomeFlag);
  if (!outcome) {
    emit(
      {
        ok: false,
        subcommand: "eval reflect",
        covenant_kind: meta.covenant_kind,
        error: "bad_outcome",
        hint: "Use --outcome achieved | partial | failed",
        got: outcomeFlag,
      },
      opts,
    );
    process.exit(EX_USAGE);
  }

  // Outcome-only body. NEVER includes session-id, URL, intent text,
  // resolved values, or any pointer payload. See the OUTCOME-ONLY
  // INVARIANT in the file header.
  const body = {
    skill_id: skillFlag,
    endpoint_id: endpointFlag,
    intent_status: outcome,
  };

  const apiBase = defaultApiBase();
  const url = `${apiBase.replace(/\/$/, "")}/v1/stats/reflect`;
  const apiKey = process.env.UNBROWSE_API_KEY;

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const respText = await res.text();
    let respBody: unknown = null;
    try {
      respBody = JSON.parse(respText);
    } catch {
      respBody = respText;
    }
    if (!res.ok) {
      emit(
        {
          ok: false,
          subcommand: "eval reflect",
          covenant_kind: meta.covenant_kind,
          error: "backend_non_2xx",
          status: res.status,
          response: respBody,
        },
        opts,
      );
      process.exit(EX_GENERIC);
    }
    emit(
      {
        ok: true,
        subcommand: "eval reflect",
        covenant_kind: meta.covenant_kind,
        posted: body,
        response: respBody,
      },
      opts,
    );
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(
      {
        ok: false,
        subcommand: "eval reflect",
        covenant_kind: meta.covenant_kind,
        error: "backend_unreachable",
        detail: message,
        api_base: apiBase,
      },
      opts,
    );
    process.exit(EX_GENERIC);
  }
}
