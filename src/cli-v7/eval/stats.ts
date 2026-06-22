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
 * the worker is bypassed). Read-only; no audit POSTs. (Wallet-first
 * auto-registration lives on the hot path — resolve + api 401/403 — not here,
 * so stats stays a fast reporter.)
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
import { readLocalWalletAddress } from "../../values/signer.js";

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
 *
 *  web3-native, web2-wrapped: the contribution ledger is bound to your self-custody
 *  `wallet` (the on-chain identity the owner-share + Proof-of-Indexing attribution pay
 *  out to); the money/tokens/time fields are the plain web2-friendly view of it. `wallet`
 *  is read no-mint (null until you have one) so merely checking stats never creates keys.
 *  Extracted pure so the field contract + graceful degrade is unit-tested. */
export function shapeYouView(
  local: YouViewLocal,
  dash: YouViewDash | null,
  impactLogPath: string,
  wallet?: string | null,
): Record<string, unknown> {
  return {
    // web2-friendly contribution ledger (money made / money saved / tokens / speed / time)
    money_made_usd: dash?.economics?.total_earned_usd ?? 0,
    money_saved_usd: Math.round((local.total_cost_saved_uc / 1_000_000) * 1e6) / 1e6,
    tokens_saved: local.total_tokens_saved,
    time_saved_hours: Math.round((local.total_time_saved_ms / 3_600_000) * 1e4) / 1e4,
    // "speed" — average wall-clock saved per run (ms); honest derive, 0 when no runs
    avg_time_saved_per_run_ms:
      local.total_runs > 0 ? Math.round(local.total_time_saved_ms / local.total_runs) : 0,
    total_runs: local.total_runs,
    contributions: dash?.contributions?.length ?? 0,
    // web3-native binding: the wallet these contributions + payouts settle to (no-mint read)
    wallet: wallet ?? null,
    authenticated: dash != null,
    impact_log_path: impactLogPath,
    // back-compat aliases (prior field names kept so existing readers don't break)
    cost_saved_usd: Math.round((local.total_cost_saved_uc / 1_000_000) * 1e6) / 1e6,
    payouts_usd: dash?.economics?.total_earned_usd ?? 0,
  };
}

/** Build the "you" view: read local impact + (when an agent_id exists) the remote
 *  dashboard, then shape. Remote failure degrades to local-only zeros. */
async function buildYouView(): Promise<Record<string, unknown>> {
  const local = readImpactSummary();
  let dash: YouViewDash | null = null;
  // Read-only + fast: `eval stats` reports, it does NOT register. Wallet-first
  // auto-registration happens on the hot path (resolve + api 401/403 via
  // ensureUsableKey/backfillWalletBinding), so by the time you check stats after
  // any resolve, the dashboard already reflects the wallet identity.
  if (getAgentId()) {
    try {
      dash = await getMyDashboard();
    } catch {
      // remote unreachable / unauthenticated — keep local-only zeros, stay non-null
    }
  }
  // web3-native binding, read no-mint: null until a wallet exists (checking stats
  // must never create key state). The web2 fields render the same either way.
  let wallet: string | null = null;
  try {
    wallet = readLocalWalletAddress();
  } catch {
    // no wallet pointer / unreadable — degrade to null, never crash the reporter
  }
  return shapeYouView(local, dash, getImpactLogPath(), wallet);
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
    } catch (e) {
      // The `network` summary is unreachable/aborted (slow link, offline, or
      // CPU/network contention pushing the cold fetch past the 10s abort). The
      // `you` view is LOCAL and offline-first, so DEGRADE — never crash to a
      // rc=1 empty stdout. Emit the local you-view with a null-ish network so
      // a reader (and the tracking-gate G1 witness) always gets the 4 fields.
      status = 0;
      body = { error: "stats_summary_unreachable", name: (e as Error)?.name ?? "Error" };
    } finally {
      clearTimeout(t);
    }

    // W24.2 — sig-keyed eval-read audit row. readKind=stats is a pure
    // backend summary; no Chrome tab, no URL. byteCount is the summary
    // JSON size for forensic correlation.
    // Best-effort telemetry: a failing/unsignable audit POST (offline, no
    // wallet, unreachable backend) must NEVER suppress the stats output, which
    // is the command's real product. Degrade, don't crash.
    let auditEmit: Record<string, unknown>;
    try {
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
      auditEmit = {
        ok: post.ok,
        cacheKey: post.cacheKey,
        receiptId: post.receiptId,
        httpStatus: post.httpStatus,
        bindingMissing: post.bindingMissing,
        errorHint: post.errorHint,
      };
    } catch (e) {
      auditEmit = { ok: false, error: "audit_emit_failed", name: (e as Error)?.name ?? "Error" };
    }

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
