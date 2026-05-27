/**
 * `unbrowse eval resolve <intent>` — route cache + marketplace shortlist.
 *
 * 1:1 mapping (kind-map.ts row "eval resolve"):
 *   CLI subcommand  : eval resolve
 *   MCP tool        : unbrowse_resolve
 *   Covenant kind   : observe_resolve
 *   Verb            : eval
 *
 * Wraps the v6 backend `POST /v1/search/resolve` (see
 * backend/src/routes/search.ts:274). The backend route is the source of
 * truth for ranking + cache + marketplace lookups — this handler does
 * not re-implement any of it; it surfaces the ranked shortlist back to
 * the calling agent so the LLM picks which endpoint to execute (CLAUDE.md
 * "Agent UX North Star" invariant #1: two tool calls is the contract).
 *
 * Pointer discipline (contract 3c2dd353): the response carries endpoint
 * metadata + URLs (already public surface), never resolved auth headers
 * or captured response bodies. `walletPubkey` from the local signer is
 * the agent identity hint; the underlying signed-client gate lives in
 * the backend bearer/x-unbrowse-signature middleware, which a v7 wrap
 * over an unauth'd CLI cannot satisfy from here. We send walletPubkey +
 * signatureScheme as part of the body so the backend (W17) can route
 * future signed-resolve admission against the same identity that the
 * rest of v7 already surfaces (eval version / status).
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

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "resolve")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval resolve",
      {
        summary: "Ranked endpoint shortlist for an intent (route cache + marketplace).",
        usage: "unbrowse eval resolve <intent> [--url <ctx>] [--domain <d>] [--limit <N>] [--fresh]",
        positional: [
          { name: "intent", description: "Free-form intent string.", required: true },
        ],
        flags: [
          { name: "--url", description: "Context URL to anchor entity substitution.", value_expected: true },
          { name: "--domain", description: "Limit shortlist to this domain.", value_expected: true },
          { name: "--limit", description: "Max shortlist size (default: 10).", value_expected: true },
          { name: "--fresh", description: "Bypass CDN / KV cache (Cache-Control: no-cache)." },
        ],
        covenant_kind: meta.covenant_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const intent = parsed.positional[0];
  if (!intent || typeof intent !== "string" || intent.trim().length === 0) {
    emitErr(new Error("intent_required: usage: unbrowse eval resolve <intent>"), opts);
    process.exit(EX_USAGE);
  }

  const urlFlag = typeof parsed.flags.url === "string" ? parsed.flags.url : undefined;
  const domainFlag = typeof parsed.flags.domain === "string" ? parsed.flags.domain : undefined;
  const limitFlag = typeof parsed.flags.limit === "string"
    ? Number.parseInt(parsed.flags.limit, 10)
    : NaN;
  const limit = Number.isFinite(limitFlag) && limitFlag > 0 ? limitFlag : 10;
  const fresh = parsed.flags.fresh === true;

  try {
    const pubkeyBytes = await getWalletPubkey();
    const walletPubkey = bytesToHex(pubkeyBytes);

    const base = resolveApiBase();
    const url = `${base.replace(/\/$/, "")}/v1/search/resolve`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (fresh) headers["cache-control"] = "no-cache";
    // Bearer if the agent has one in env — the backend route requires
    // bearerAuth, so without a key we will see 401 and surface that
    // honestly (CLAUDE.md no-stubs: fail closed with empty-state +
    // actionable next-step).
    const apiKey = process.env.UNBROWSE_API_KEY;
    if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;

    const payload = {
      intent,
      // Backend route accepts surrogateUrl (the context URL anchor).
      ...(urlFlag ? { surrogateUrl: urlFlag } : {}),
      ...(domainFlag ? { domain: domainFlag } : {}),
      domain_k: 5,
      global_k: limit,
      // v7 identity hint — backend may use this to route signed-resolve
      // admission in a later wave. Safe to print (public key).
      walletPubkey,
      signatureScheme: "ed25519-v7.0",
    };

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    let body: unknown;
    let status = 0;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      status = r.status;
      try {
        body = await r.json();
      } catch {
        body = { error: "non_json_response", status };
      }
    } finally {
      clearTimeout(t);
    }

    // Normalize the shortlist for the agent. The backend returns
    // { domain_results, global_results, ... } — flatten to a single
    // ranked list while preserving the raw envelope under `raw`.
    const domainResults = Array.isArray((body as { domain_results?: unknown[] })?.domain_results)
      ? (body as { domain_results: unknown[] }).domain_results
      : [];
    const globalResults = Array.isArray((body as { global_results?: unknown[] })?.global_results)
      ? (body as { global_results: unknown[] }).global_results
      : [];
    const shortlist = [...domainResults, ...globalResults].slice(0, limit);

    const ok = status >= 200 && status < 300;
    emit(
      {
        ok,
        subcommand: "eval resolve",
        covenant_kind: meta.covenant_kind,
        api_base: base,
        status_code: status,
        intent,
        ctx_url: urlFlag ?? null,
        domain: domainFlag ?? null,
        limit,
        fresh,
        walletPubkey,
        count: shortlist.length,
        shortlist,
        ...(ok
          ? {}
          : {
              next_step:
                status === 401 || status === 403
                  ? "set UNBROWSE_API_KEY (run `unbrowse register --email …`) — resolve requires a bearer key"
                  : `backend returned ${status}; retry or check ${base}/health`,
            }),
        raw: body,
      },
      opts,
    );
    process.exit(ok ? 0 : EX_GENERIC);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
