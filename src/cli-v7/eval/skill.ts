/**
 * `unbrowse eval skill <skill-id>` — one skill detail.
 *
 * 1:1 mapping (kind-map.ts row "eval skill"):
 *   CLI subcommand  : eval skill
 *   MCP tool        : unbrowse_skill
 *   Op kind   : eval:skill
 *   Verb            : eval
 *
 * Wraps the v6 backend `GET /v1/skills/:id` (see
 * backend/src/routes/skills.ts). Prints endpoint count, action_kinds,
 * last_executed. 404 maps to EX_USAGE (64) with an actionable
 * `next_step` per CLAUDE.md no-stubs discipline.
 */
import { createHash, randomBytes } from "node:crypto";

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
import { releaseAttestationHeaders } from "../_shared/cli-runtime.js";
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

interface SkillDetail {
  readonly skill_id: string;
  readonly domain?: string;
  readonly endpoint_count: number;
  readonly action_kinds: string[];
  readonly last_executed: number | string | null;
  readonly source: "marketplace";
  readonly raw: unknown;
}

function uniq(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).filter((v) => v && v.length > 0).sort();
}

function summarizeManifest(skillId: string, raw: Record<string, unknown>): SkillDetail {
  const endpoints = Array.isArray(raw.endpoints) ? raw.endpoints : [];
  const actionKinds = uniq(
    endpoints
      .map((e) => {
        const r = (e ?? {}) as Record<string, unknown>;
        return typeof r.action_kind === "string" ? r.action_kind : "";
      })
      .filter((s): s is string => typeof s === "string"),
  );
  const lastExecuted =
    typeof raw.last_executed === "number" || typeof raw.last_executed === "string"
      ? (raw.last_executed as number | string)
      : null;
  return {
    skill_id: skillId,
    domain: typeof raw.domain === "string" ? raw.domain : undefined,
    endpoint_count:
      typeof raw.endpoint_count === "number" ? raw.endpoint_count : endpoints.length,
    action_kinds: actionKinds,
    last_executed: lastExecuted,
    source: "marketplace",
    raw,
  };
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "skill")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval skill",
      {
        summary: "Detail one captured skill by id (endpoint count, action_kinds, last_executed).",
        usage: "unbrowse eval skill <skill-id> [--fresh]",
        positional: [
          { name: "skill-id", description: "Skill id from `unbrowse eval skills`.", required: true },
        ],
        flags: [
          { name: "--fresh", description: "Bypass CDN / KV cache." },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const skillId =
    parsed.positional[0] ??
    (typeof parsed.flags["skill-id"] === "string" ? parsed.flags["skill-id"] : undefined) ??
    (typeof parsed.flags.skill === "string" ? parsed.flags.skill : undefined);
  if (!skillId || typeof skillId !== "string" || skillId.trim().length === 0) {
    emitErr(new Error("skill_id_required: usage: unbrowse eval skill <skill-id>"), opts);
    process.exit(EX_USAGE);
  }

  const fresh = parsed.flags.fresh === true;
  const offlineForced = process.env.UNBROWSE_BACKEND_OFFLINE === "1";

  try {
    const base = resolveApiBase();
    let status = 0;
    let detail: SkillDetail | null = null;
    let backendError: string | null = null;

    // A2 — sig-keyed receipt for the read request. Sign the
    // canonicalized {op, skillId, nonce} fragment so the backend can
    // witness `eval_read` on `/v1/skills/:id`.
    const pubkeyBytes = await getWalletPubkey();
    const walletPubkey = bytesToHex(pubkeyBytes);
    const nonce = bytesToBase64(new Uint8Array(randomBytes(32)));
    const fragment = canonicalizeSignedFragment(
      { op: "get_skill", skillId, nonce },
      ["op", "skillId", "nonce"],
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
      const url = `${base.replace(/\/$/, "")}/v1/skills/${encodeURIComponent(skillId)}`;
      const headers: Record<string, string> = {
        accept: "application/json",
        ...signedHeaders,
        ...releaseAttestationHeaders(),
      };
      if (fresh) headers["cache-control"] = "no-cache";
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const r = await fetch(url, { headers, signal: ctrl.signal });
        status = r.status;
        if (r.ok) {
          const raw = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          detail = summarizeManifest(skillId, raw);
        } else if (status !== 404) {
          backendError = `backend_status:${status}`;
        }
      } catch (err) {
        backendError = (err as Error).message;
      } finally {
        clearTimeout(t);
      }
    }

    // John 15:2 — no local-pointer-store fallback. Returning a stale
    // ~/.unbrowse/skills/<id>.json as `source: "local"` would masquerade
    // as live truth when the agent only reads JSON. Honest answer:
    // backend_unreachable with an actionable next_step.

    // W24.2 — sig-keyed eval-read audit row. readKind=skill is a pure
    // backend read of `/v1/skills/:id`. Emit even on 404 so the
    // forensic trail records "agent looked for skill X and it didn't
    // exist" — that IS the act.
    const post = await postStateless({
      namespace: "audit",
      route: "/v1/audit/eval-read",
      body: {
        readKind: "skill" as const,
        byteCount: detail ? JSON.stringify(detail.raw).length : 0,
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

    if (!detail) {
      // 404-shaped honest empty-state with actionable next-step.
      const backendUnreachable =
        status === 0 || (status >= 500 && backendError !== null);
      emit(
        {
          ok: false,
          subcommand: "eval skill",
          op_kind: meta.op_kind,
          error: backendUnreachable
            ? "backend_unreachable"
            : "skill_not_found",
          skill_id: skillId,
          api_base: base,
          backend_status: status,
          backend_error: backendError,
          walletPubkey,
          cache_key: cacheKey,
          audit_kind: "eval_read",
          audit_emit: auditEmit,
          next_step: backendUnreachable
            ? "backend unreachable — check connectivity to " + base
            : "list skills via `unbrowse eval skills`, or capture one via `unbrowse breath go <url>` + `breath close --publish`",
        },
        opts,
      );
      // sysexits.h EX_DATAERR = 65 (matches the prompt's "404 → exit 65").
      process.exit(65);
    }

    emit(
      {
        ok: true,
        subcommand: "eval skill",
        op_kind: meta.op_kind,
        api_base: base,
        backend_status: status,
        skill_id: detail.skill_id,
        domain: detail.domain ?? null,
        endpoint_count: detail.endpoint_count,
        action_kinds: detail.action_kinds,
        last_executed: detail.last_executed,
        source: detail.source,
        walletPubkey,
        cache_key: cacheKey,
        audit_kind: "eval_read",
        audit_emit: auditEmit,
        raw: detail.raw,
      },
      opts,
    );
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
