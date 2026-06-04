/**
 * `unbrowse eval reflect` — reflect on user-facing outcome.
 *
 * 1:1 mapping (kind-map.ts row "eval reflect"):
 *   CLI subcommand  : eval reflect
 *   MCP tool        : unbrowse_reflect
 *   Op kind   : eval:reflect
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
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { postStateless } from "../_stateless.js";

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
        op_kind: meta.op_kind,
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
        op_kind: meta.op_kind,
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
        op_kind: meta.op_kind,
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

  // Outcome-only body routed through `postStateless` so the agent walks
  // away with a sig-keyed `cacheKey` pointer to the reflection. Backend
  // ignores the extra wallet-sig fields gracefully (existing route).
  try {
    const post = await postStateless({
      namespace: "audit",
      route: "/v1/stats/reflect",
      body,
      signableFields: ["skill_id", "endpoint_id", "intent_status", "nonce"],
      apiBaseUrl: apiBase,
    });
    if (post.ok) {
      emit(
        {
          ok: true,
          subcommand: "eval reflect",
          op_kind: meta.op_kind,
          posted: body,
          cacheKey: post.cacheKey,
          receiptId: post.receiptId ?? null,
          idempotent: post.idempotent,
          http_status: post.httpStatus,
        },
        opts,
      );
      process.exit(0);
    }
    if (post.bindingMissing) {
      emit(
        {
          ok: false,
          subcommand: "eval reflect",
          op_kind: meta.op_kind,
          error: "binding_missing",
          binding_missing: post.bindingMissing,
          cacheKey: post.cacheKey,
          http_status: post.httpStatus,
        },
        opts,
      );
      process.exit(EX_GENERIC);
    }
    emit(
      {
        ok: false,
        subcommand: "eval reflect",
        op_kind: meta.op_kind,
        error: post.errorHint ?? `http_${post.httpStatus}`,
        cacheKey: post.cacheKey,
        http_status: post.httpStatus,
      },
      opts,
    );
    process.exit(EX_GENERIC);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
