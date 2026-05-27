/**
 * `unbrowse eval earnings` — x402 earnings summary for the current agent.
 *
 * 1:1 mapping (kind-map.ts row "eval earnings"):
 *   CLI subcommand  : eval earnings
 *   MCP tool        : unbrowse_earnings
 *   Covenant kind   : observe_earnings
 *   Verb            : eval
 *
 * Wraps the v6 backend `GET /v1/transactions/creator/:agentId` (see
 * backend/src/routes/transactions.ts:82) where `:agentId` is the SHA-256
 * of the x402 walletPubkey (matches the auth.ts agent identity binding).
 * Surfaces: total earned (sum of `price_usd` rows since `--since`),
 * per-domain breakdown (from `skill_id` → domain hint via the row
 * envelope), and the most-recent 10 fills.
 *
 * BACKEND-SHAPE NOTE: there is NO `/v1/account/earnings` endpoint —
 * the project spec mentioned that path but the actual creator earnings
 * surface lives at `/v1/transactions/creator/:agentId`. This handler
 * uses the real route. The agentId is derived from the local
 * walletPubkey using SHA-256 (the same hash the backend auth layer
 * applies to the bearer key); when a different binding is preferred
 * the agent can pass `--agent-id <id>` explicitly.
 *
 * Pointer discipline (contract 3c2dd353): no value bytes printed —
 * only price_usd numerics + skill/endpoint identifiers + timestamps.
 */
import { createHash } from "node:crypto";

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
import { getWalletPubkey } from "../../values/signer.js";

function resolveApiBase(): string {
  return (
    process.env.UNBROWSE_API_URL ??
    process.env.UNBROWSE_BACKEND_URL ??
    DEFAULT_BACKEND_URL
  );
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

/** Mirror backend/src/services/auth.ts agent-id derivation. */
function deriveAgentId(walletPubkeyHex: string): string {
  return createHash("sha256").update(walletPubkeyHex).digest("hex");
}

function domainFromSkillId(skillId: unknown, fallback: unknown): string | null {
  // skill_id is typically "<domain>:<hash>" or "<domain>/<path>" in v6.
  // Fallback to the row's own `domain` field if surfaced.
  if (typeof fallback === "string" && fallback.length > 0) return fallback;
  if (typeof skillId !== "string") return null;
  const colon = skillId.indexOf(":");
  if (colon > 0) return skillId.slice(0, colon);
  const slash = skillId.indexOf("/");
  if (slash > 0) return skillId.slice(0, slash);
  return null;
}

interface LedgerRow {
  transaction_id?: string;
  consumer_id?: string;
  creator_id?: string;
  skill_id?: string;
  endpoint_id?: string;
  price_usd?: number;
  domain?: string;
  recorded_at?: number | string;
  ts?: number | string;
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "earnings")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval earnings",
      {
        summary: "x402 earnings summary for the current agent (total + by_domain + recent).",
        usage: "unbrowse eval earnings [--since YYYY-MM-DD] [--agent-id <id>] [--fresh]",
        flags: [
          { name: "--since", description: "ISO8601/YYYY-MM-DD lower bound.", value_expected: true },
          { name: "--agent-id", description: "Override the derived agentId (sha256(walletPubkey)).", value_expected: true },
          { name: "--fresh", description: "Bypass CDN / KV cache." },
        ],
        covenant_kind: meta.covenant_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const sinceFlag = typeof parsed.flags.since === "string" ? parsed.flags.since : undefined;
  const sinceMs = sinceFlag ? Date.parse(sinceFlag) : NaN;
  const sinceCutoff = Number.isFinite(sinceMs) ? sinceMs : 0;
  const agentIdOverride =
    typeof parsed.flags["agent-id"] === "string" ? parsed.flags["agent-id"] : undefined;
  const fresh = parsed.flags.fresh === true;

  try {
    const pubkeyBytes = await getWalletPubkey();
    const walletPubkey = bytesToHex(pubkeyBytes);
    const agentId = agentIdOverride ?? deriveAgentId(walletPubkey);

    const base = resolveApiBase();
    const url = `${base.replace(/\/$/, "")}/v1/transactions/creator/${encodeURIComponent(agentId)}`;
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

    // The backend returns 404 with `{error: "No transactions found …"}` for
    // never-earned agents. Surface that as an honest zero-state, not a
    // failure (the caller asked "what have I earned" and the truth is
    // nothing-yet).
    const okStatus = status >= 200 && status < 300;
    const ledgerRaw =
      okStatus && body && typeof body === "object"
        ? (body as { ledger?: unknown }).ledger
        : null;
    const ledger: LedgerRow[] = Array.isArray(ledgerRaw)
      ? (ledgerRaw as LedgerRow[])
      : [];

    // Filter by `--since`, aggregate by domain, take the most-recent 10.
    const rowTs = (r: LedgerRow): number => {
      const v = r.recorded_at ?? r.ts;
      if (typeof v === "number") return v;
      if (typeof v === "string") {
        const t = Date.parse(v);
        return Number.isFinite(t) ? t : 0;
      }
      return 0;
    };
    const filtered = ledger.filter((r) => rowTs(r) >= sinceCutoff);
    let total = 0;
    const byDomain = new Map<string, { count: number; total_usd: number }>();
    for (const r of filtered) {
      const price = typeof r.price_usd === "number" && Number.isFinite(r.price_usd) ? r.price_usd : 0;
      total += price;
      const domain = domainFromSkillId(r.skill_id, r.domain) ?? "unknown";
      const cur = byDomain.get(domain) ?? { count: 0, total_usd: 0 };
      cur.count += 1;
      cur.total_usd += price;
      byDomain.set(domain, cur);
    }
    const byDomainOut = Array.from(byDomain.entries())
      .map(([domain, v]) => ({ domain, count: v.count, total_usd: round6(v.total_usd) }))
      .sort((a, b) => b.total_usd - a.total_usd);

    const recent = [...filtered]
      .sort((a, b) => rowTs(b) - rowTs(a))
      .slice(0, 10)
      .map((r) => ({
        transaction_id: r.transaction_id ?? null,
        skill_id: r.skill_id ?? null,
        endpoint_id: r.endpoint_id ?? null,
        domain: domainFromSkillId(r.skill_id, r.domain) ?? null,
        price_usd: typeof r.price_usd === "number" ? r.price_usd : 0,
        consumer_id: r.consumer_id ?? null,
        recorded_at: r.recorded_at ?? r.ts ?? null,
      }));

    emit(
      {
        ok: true,
        subcommand: "eval earnings",
        covenant_kind: meta.covenant_kind,
        api_base: base,
        agent_id: agentId,
        walletPubkey,
        since: sinceFlag ?? null,
        backend_status: status,
        total_usd: round6(total),
        total: round6(total),
        count: filtered.length,
        by_domain: byDomainOut,
        recent,
      },
      opts,
    );
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
