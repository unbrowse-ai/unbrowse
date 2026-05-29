/**
 * `unbrowse eval skills` — list captured skills.
 *
 * 1:1 mapping (kind-map.ts row "eval skills"):
 *   CLI subcommand  : eval skills
 *   MCP tool        : unbrowse_skills
 *   Op kind   : eval:skills
 *   Verb            : eval
 *
 * Wraps the v6 backend `GET /v1/skills?view=card` (see
 * backend/src/routes/skills.ts:58) — card view is the only auth-free
 * shape and carries enough pointer metadata (domain, endpoint count,
 * last-executed) for the agent to pick. When the backend is unreachable
 * (W24.6) — refuses the local pointer-store fallback as masquerade;
 * honest empty-state with actionable next_step.
 *
 * Pointer discipline (contract 3c2dd353): rows carry skill_id + domain
 * + counts only. The full endpoint manifest only loads via
 * `eval skill <id>` so list calls stay light.
 */
import { createHash, randomBytes } from "node:crypto";

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
import { getWalletPubkey, signBytes } from "../../values/signer.js";
import { safeZero } from "../../values/memzero.js";
import { canonicalizeSignedFragment, postStateless } from "../_stateless.js";

function resolveApiBase(): string {
  return (
    process.env.UNBROWSE_API_URL ??
    process.env.UNBROWSE_BACKEND_URL ??
    DEFAULT_BACKEND_URL
  );
}

function bytesToHex(b: Uint8Array): string {
  let h = "";
  for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, "0");
  return h;
}

function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

interface RemoteSkillRow {
  readonly source: "marketplace";
  readonly skill_id?: string;
  readonly id?: string;
  readonly domain?: string;
  readonly endpoint_count?: number;
  readonly last_executed?: number | string | null;
  // Keep the original card payload so the agent has the full row.
  readonly raw: unknown;
}

type SkillRow = RemoteSkillRow;

async function fetchRemoteSkills(opts: {
  base: string;
  limit?: number;
  includeDeprecated: boolean;
  domain?: string;
  fresh: boolean;
  signedHeaders?: Record<string, string>;
}): Promise<{ rows: RemoteSkillRow[]; status: number; ok: boolean }> {
  const params = new URLSearchParams({ view: "card" });
  if (opts.limit && opts.limit > 0) params.set("limit", String(opts.limit));
  if (opts.includeDeprecated) params.set("include_deprecated", "1");
  const url = `${opts.base.replace(/\/$/, "")}/v1/skills?${params.toString()}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(opts.signedHeaders ?? {}),
  };
  if (opts.fresh) headers["cache-control"] = "no-cache";

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    const status = r.status;
    if (!r.ok) {
      return { rows: [], status, ok: false };
    }
    const body = (await r.json().catch(() => ({}))) as { skills?: unknown };
    const list = Array.isArray(body.skills) ? body.skills : [];
    let rows: RemoteSkillRow[] = list.map((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      return {
        source: "marketplace",
        skill_id: typeof e.skill_id === "string" ? e.skill_id : undefined,
        id: typeof e.id === "string" ? e.id : undefined,
        domain: typeof e.domain === "string" ? e.domain : undefined,
        endpoint_count:
          typeof e.endpoint_count === "number" ? e.endpoint_count : undefined,
        last_executed:
          typeof e.last_executed === "number" || typeof e.last_executed === "string"
            ? (e.last_executed as number | string)
            : null,
        raw: e,
      };
    });
    if (opts.domain) {
      const d = opts.domain.toLowerCase();
      rows = rows.filter((r) => (r.domain ?? "").toLowerCase() === d);
    }
    return { rows, status, ok: true };
  } finally {
    clearTimeout(t);
  }
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "skills")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval skills",
      {
        summary: "List captured skills (marketplace card view; local fallback).",
        usage: "unbrowse eval skills [--domain D] [--limit N] [--include-deprecated] [--fresh]",
        flags: [
          { name: "--domain", description: "Filter by domain.", value_expected: true },
          { name: "--limit", description: "Max rows.", value_expected: true },
          { name: "--include-deprecated", description: "Include stale/deprecated skills." },
          { name: "--fresh", description: "Bypass CDN / KV cache." },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const domainFlag =
    typeof parsed.flags.domain === "string" ? parsed.flags.domain : undefined;
  const limitFlag = typeof parsed.flags.limit === "string"
    ? Number.parseInt(parsed.flags.limit, 10)
    : NaN;
  const limit = Number.isFinite(limitFlag) && limitFlag > 0 ? limitFlag : undefined;
  const includeDeprecated = parsed.flags["include-deprecated"] === true;
  const fresh = parsed.flags.fresh === true;
  const offlineForced = process.env.UNBROWSE_BACKEND_OFFLINE === "1";

  try {
    const base = resolveApiBase();
    let rows: SkillRow[] = [];
    let backendUnreachable = false;
    let backendStatus = 0;
    let backendError: string | null = null;

    // A2 — sign the read request body so backend can witness when the
    // signed-list-skills admission gate ships. Signature is computed once
    // and propagated as headers to the GET request.
    const pubkeyBytes = await getWalletPubkey();
    const walletPubkey = bytesToHex(pubkeyBytes);
    const nonce = bytesToBase64(new Uint8Array(randomBytes(32)));
    const fragment = canonicalizeSignedFragment(
      {
        op: "list_skills",
        domain: domainFlag ?? null,
        limit: limit ?? null,
        includeDeprecated,
        nonce,
      },
      ["op", "domain", "limit", "includeDeprecated", "nonce"],
    );
    const signed = await signBytes(new TextEncoder().encode(fragment));
    const signatureHex = bytesToHex(signed.signature);
    const cacheKey = createHash("sha256").update(signed.signature).digest("hex").slice(0, 32);
    safeZero(signed.signature);
    const signedHeaders: Record<string, string> = {
      "x-wallet-pubkey": walletPubkey,
      "x-stateless-nonce": nonce,
      "x-stateless-signature": signatureHex,
    };

    if (!offlineForced) {
      try {
        const remote = await fetchRemoteSkills({
          base,
          limit,
          includeDeprecated,
          domain: domainFlag,
          fresh,
          signedHeaders,
        });
        backendStatus = remote.status;
        if (remote.ok) {
          rows = remote.rows;
        } else {
          backendUnreachable = true;
        }
      } catch (err) {
        backendError = (err as Error).message;
        backendUnreachable = true;
      }
    } else {
      backendUnreachable = true;
    }

    // W24.2 — sig-keyed eval-read audit row. readKind=skills is a
    // backend list query — no Chrome tab. byteCount is the rows
    // payload size at the point of emit.
    const post = await postStateless({
      namespace: "audit",
      route: "/v1/audit/eval-read",
      body: {
        readKind: "skills" as const,
        byteCount: JSON.stringify(rows).length,
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

    if (backendUnreachable) {
      // John 15:2 — the local ~/.unbrowse/skills/ dir is NOT a substitute
      // for the marketplace. Returning stale local pointer payloads
      // dressed as `source: "local"` would masquerade as live truth (the
      // agent's caller LLM doesn't read stderr). Honest answer: ok:false
      // with actionable next_step.
      emit(
        {
          ok: false,
          subcommand: "eval skills",
          op_kind: meta.op_kind,
          api_base: base,
          backend_status: backendStatus,
          backend_error: backendError,
          count: 0,
          skills: [],
          walletPubkey,
          cache_key: cacheKey,
          audit_kind: "eval_read",
          audit_emit: auditEmit,
          next_step:
            "backend unreachable — check connectivity to " + base,
        },
        opts,
      );
      process.exit(EX_GENERIC);
    }

    emit(
      {
        ok: true,
        subcommand: "eval skills",
        op_kind: meta.op_kind,
        api_base: base,
        backend_status: backendStatus,
        backend_error: backendError,
        count: rows.length,
        skills: rows,
        walletPubkey,
        cache_key: cacheKey,
        audit_kind: "eval_read",
        audit_emit: auditEmit,
      },
      opts,
    );
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
