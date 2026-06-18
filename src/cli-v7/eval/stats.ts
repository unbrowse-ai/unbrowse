/**
 * `unbrowse eval stats` — marketplace + earnings stats summary.
 *
 * 1:1 mapping (kind-map.ts row "eval stats"):
 *   CLI subcommand  : eval stats
 *   MCP tool        : unbrowse_stats
 *   Op kind   : eval:stats
 *   Verb            : eval
 *
 * Fetches `${UNBROWSE_API_URL || beta-api.unbrowse.ai}/v1/stats/summary`
 * and surfaces the raw response. Honors `--fresh` by attaching
 * `Cache-Control: no-cache` (so any CDN / KV cache between the CLI and
 * the worker is bypassed). Read-only; no audit POSTs.
 *
 * Stateless verification (Day-6 Dominion W6-EVAL-4, 2026-05-28):
 *   - `--fresh` sets `Cache-Control: no-cache`; the stats endpoint is
 *     a public read-only summary that doesn't gate on wallet identity,
 *     so the header is the only knob.
 *   - Every read emits a sig-keyed `eval_read` audit row (W24.6 — the
 *     prior env-gate was purged; stateless is the sole path).
 */
import type { ParsedV7Args } from "../args.js";
import {
  EX_GENERIC,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { DEFAULT_BACKEND_URL } from "../../version.js";
import { postStateless } from "../_stateless.js";
import { readImpactSummary, getImpactLogPath } from "../../impact-log.js";
import { getAgentId, getMyDashboard } from "../../client/index.js";

export interface YouViewLocal {
  total_cost_saved_uc: number;
  total_time_saved_ms: number;
  total_tokens_saved: number;
  total_runs: number;
}
export interface YouViewDash {
  contributions?: unknown[];
  economics?: { total_earned_usd?: number };
}

/** Pure shaping of the "you" view — cost/time saved from the LOCAL impact log (offline,
 *  no account); payouts + contributions count from the remote dashboard when present,
 *  else degrade to 0 (never null, never fabricated). authenticated = we had a dashboard.
 *  Extracted pure so the four-field contract + graceful degrade is unit-tested. */
export function shapeYouView(local: YouViewLocal, dash: YouViewDash | null, impactLogPath: string): Record<string, unknown> {
  return {
    cost_saved_usd: Math.round((local.total_cost_saved_uc / 1_000_000) * 1e6) / 1e6,
    time_saved_hours: Math.round((local.total_time_saved_ms / 3_600_000) * 1e4) / 1e4,
    tokens_saved: local.total_tokens_saved,
    total_runs: local.total_runs,
    contributions: dash?.contributions?.length ?? 0,
    payouts_usd: dash?.economics?.total_earned_usd ?? 0,
    authenticated: dash != null,
    impact_log_path: impactLogPath,
  };
}

/** Build the "you" view: read local impact + (when an agent_id exists) the remote
 *  dashboard, then shape. Remote failure degrades to local-only zeros. */
async function buildYouView(): Promise<Record<string, unknown>> {
  const local = readImpactSummary();
  let dash: YouViewDash | null = null;
  if (getAgentId()) {
    try {
      dash = await getMyDashboard();
    } catch {
      // remote unreachable / unauthenticated — keep local-only zeros, stay non-null
    }
  }
  return shapeYouView(local, dash, getImpactLogPath());
}

function resolveApiBase(): string {
  return (
    process.env.UNBROWSE_API_URL ??
    process.env.UNBROWSE_BACKEND_URL ??
    DEFAULT_BACKEND_URL
  );
}

export async function handler(
  parsed: ParsedV7Args,
  opts: OutputOptions,
): Promise<void> {
  const meta = lookupKindMap("eval", "stats")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval stats",
      {
        summary:
          "Your ledger + the network's: `you` (cost saved, time saved, contributions, payouts — local impact log + your dashboard) and `network` (everyone, from /v1/stats/summary).",
        usage: "unbrowse eval stats [--fresh] [--json]",
        flags: [
          {
            name: "--fresh",
            description: "Bypass CDN / KV cache (Cache-Control: no-cache).",
          },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const fresh = parsed.flags.fresh === true;

  try {
    const base = resolveApiBase();
    const url = `${base}/v1/stats/summary`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (fresh) headers["cache-control"] = "no-cache";

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    let body: unknown;
    let status = 0;
    try {
      const r = await fetch(url, { headers, signal: ctrl.signal });
      status = r.status;
      try {
        body = await r.json();
      } catch {
        body = { error: "non_json_response", status };
      }
    } finally {
      clearTimeout(t);
    }

    // W24.2 — sig-keyed eval-read audit row. readKind=stats is a pure
    // backend summary; no Chrome tab, no URL. byteCount is the summary
    // JSON size for forensic correlation.
    const post = await postStateless({
      namespace: "audit",
      route: "/v1/audit/eval-read",
      body: {
        readKind: "stats" as const,
        byteCount: JSON.stringify(body).length,
      },
      signableFields: [
        "sessionId",
        "urlHash",
        "readKind",
        "byteCount",
        "selectorHash",
        "nonce",
      ],
    });
    const auditEmit = {
      ok: post.ok,
      cacheKey: post.cacheKey,
      receiptId: post.receiptId,
      httpStatus: post.httpStatus,
      bindingMissing: post.bindingMissing,
      errorHint: post.errorHint,
    };

    const you = await buildYouView();

    emit(
      {
        ok: status >= 200 && status < 300,
        subcommand: "eval stats",
        op_kind: meta.op_kind,
        api_base: base,
        status_code: status,
        fresh,
        you,
        network: body,
        summary: body,
        // The economy + privacy story behind these numbers, surfaced for the agent —
        // per-use x402 micropayments + site-owner payouts (Unbrowse Maintenance
        // Network), and credentials bound to your wallet by zero-knowledge proof,
        // revealed only under signature (Crypto Was All You Needed). Public-tier
        // pointers — the WHAT, read the papers for the rest.
        docs: {
          how_it_pays: "https://unbrowse.ai/how-unbrowse-pays",
          economy: "per-use x402 micropayments; bind a wallet to a domain you own to earn the owner share — paper: Unbrowse Maintenance Network",
          privacy: "credentials are bound to your wallet by zero-knowledge proof and revealed only under signature — paper: Crypto Was All You Needed",
          papers: "https://unbrowse.ai/papers",
        },
        audit_emit: auditEmit,
      },
      opts,
    );
    process.exit(status >= 200 && status < 300 ? 0 : EX_GENERIC);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
