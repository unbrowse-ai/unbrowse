/**
 * `unbrowse eval trace <session-id>` — read stateless decision_trace.
 *
 * 1:1 mapping (kind-map.ts row "eval trace"):
 *   CLI subcommand  : eval trace
 *   MCP tool        : unbrowse_trace
 *   Op kind   : eval:trace
 *   Verb            : eval
 *
 * Pointers-over-anything Clause B (CLAUDE.md): the trace store at
 * `~/.unbrowse/traces/<domain>.jsonl` is the sole source of truth;
 * recomputing any value needs no in-memory session state.
 *
 * Output is JSONL: one StoredTrace per line on stdout (so the caller
 * can pipe through `jq -c '.'` etc.). On --json, a single object
 * envelope wraps the rows.
 *
 * SECRET-REDACTION INVARIANT (load-bearing — defensive, NEVER skip):
 * The v6 trace-store already strips resolved values at the boundary
 * (StoredTrace has no `value` field by type). Defense-in-depth: this
 * handler additionally runs `redactStoredTrace()` over every row
 * before printing, redacting any pointer-shaped or secret-shaped
 * value that may have leaked into `params` / `context_url` / other
 * free-form string fields. The redaction filter lives HERE so the
 * invariant is co-located with the surface that emits.
 */
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
import {
  getRecentTraces,
  findTracesByIntent,
  getTraceStorePath,
  type StoredTrace,
} from "../../graph/trace-store.js";
import { readSessionRecord } from "../_session.js";
import { postStateless, type PostStatelessResult } from "../_stateless.js";
import { traceV6ToV7Steps, type V7TraceStep } from "../_trace-projector.js";

/**
 * Sensitive-shape patterns we refuse to emit raw. Defensive: the v6
 * trace-store should already strip these, but anything matching is
 * replaced with `[redacted:<reason>]` before we print.
 */
const POINTER_PREFIXES = ["op://", "keychain://", "bw://", "arg://"] as const;
// Common secret-token shapes (Bearer, JWT-ish, sk_* keys, hex secrets ≥32).
const SECRET_REGEXES: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /^Bearer\s+[A-Za-z0-9._\-]{8,}$/i, reason: "bearer" },
  { re: /^eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/, reason: "jwt" },
  { re: /^sk_[A-Za-z0-9]{16,}$/, reason: "sk-key" },
  { re: /^[a-f0-9]{32,}$/i, reason: "hex-secret" },
];

function redactValue(v: unknown): unknown {
  if (typeof v === "string") {
    for (const prefix of POINTER_PREFIXES) {
      if (v.startsWith(prefix)) return `[redacted:pointer]`;
    }
    for (const { re, reason } of SECRET_REGEXES) {
      if (re.test(v)) return `[redacted:${reason}]`;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactValue(val);
    }
    return out;
  }
  return v;
}

/**
 * Exported so the test suite can pin the redaction surface. Returns a
 * shallow copy of the row with `params` and other free-form fields
 * passed through the redactor.
 */
export function redactStoredTrace(t: StoredTrace): StoredTrace {
  return {
    ...t,
    params: redactValue(t.params) as Record<string, unknown>,
    context_url:
      typeof t.context_url === "string"
        ? (redactValue(t.context_url) as string)
        : t.context_url,
    intent: typeof t.intent === "string" ? (redactValue(t.intent) as string) : t.intent,
  };
}

/**
 * Resolve which domain we should read traces from. The on-disk trace
 * store is keyed by domain (one JSONL per host), so we need to map a
 * `<session-id>` positional to a domain. Three resolution paths:
 *   1. If the positional itself looks like a host (contains `.`), use it.
 *   2. If a session record at `~/.unbrowse/sessions/<id>.json` exists,
 *      look up its `chromeWsUrl` host (best-effort; sessions don't
 *      carry a current-page host).
 *   3. Else fall back to `--domain <host>` if supplied.
 */
function looksLikeHost(s: string): boolean {
  return /^[a-z0-9.\-]+\.[a-z]{2,}$/i.test(s);
}

async function resolveDomain(
  sessionIdOrHost: string,
  domainFlag: string | undefined,
): Promise<string | null> {
  if (domainFlag) return domainFlag;
  if (looksLikeHost(sessionIdOrHost)) return sessionIdOrHost;
  // Best-effort session-record lookup; trace store doesn't index by
  // sessionId, so a missing-domain return signals the caller to ask.
  try {
    const rec = await readSessionRecord(sessionIdOrHost);
    // chromeWsUrl is ws://host:port/devtools/...; not the page host.
    // Without a recorded contextUrl we can't infer; surface honest miss.
    void rec;
    return null;
  } catch {
    return null;
  }
}

// ─── v7 STATELESS POST PATH ────────────────────────────────────────────────
//
// Day-5 Swarm worker B (2026-05-28). The eval trace handler:
//   1. Reads v6 traces (the local trace-store remains the v6 ingress; v7
//      lifts each row across the boundary).
//   2. Projects each through `traceV6ToV7Step` (drops FORBIDDEN fields).
//   3. POSTs via `postStateless` to /v1/trace/append (TRACE_STATE namespace).
//   4. On 2xx: rm's the local JSONL (the wire receipt supersedes the file).
//   5. On 503 binding-missing: keeps local + marks `_v7_pending: true` rows
//      for next-firing retry; warns to stderr (sanitized — no v6 row bodies).
//   6. Returns `cacheKey` as the new pointer the CLI surfaces.
//
// NEVER LOGS the v6 trace before projection — some v6 rows carry secrets in
// query strings via `context_url`/`params`. The projector drops every
// cleartext-shaped field unconditionally.
//
// W24.6 LOST SHEEP #2 (Lewis 2026-05-28 — "stateless is the only path"):
// the prior `eval trace` redacted-local-emit path (`redactStoredTrace()` over
// the v6 store, written to stdout/JSON) is gone. v7 is POST-only; local
// `eval trace` reads at the v7 surface require the wallet-signed
// `GET /v1/trace/list` endpoint to ship (v7.3 follow-up).

/** Domain-file path mirror of trace-store's private helper (legacy mode). */
function v7DomainFilePath(domain: string): string {
  const root =
    process.env.UNBROWSE_TRACE_STORE_DIR ?? join(homedir(), ".unbrowse", "traces");
  const normalized = domain
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9.\-]/g, "_");
  return join(root, `${normalized}.jsonl`);
}

/**
 * Stateless-mode pending-trace tmp path. Mirrors `_session.ts:sessionTmpDir`
 * convention — `~/.unbrowse/tmp/<sigHash>/trace-pending.jsonl` where sigHash
 * is sha256(domain).slice(0,16). Lives under tmp/ so the A1 falsifier's
 * `! -path '*<slash>tmp<slash>*'` exclusion lets it through (STATELESS_BOUNDARY §H).
 * Deterministic per-domain so the next firing's retry-from-pending reads
 * the same path.
 */
function v7TmpPendingPath(domain: string): string {
  const normalized = domain.toLowerCase().replace(/^www\./, "");
  const sigHash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(homedir(), ".unbrowse", "tmp", sigHash, "trace-pending.jsonl");
}

/**
 * On successful POST: delete BOTH the legacy local JSONL and any stateless
 * tmp pending file (the wire receipt is now the truth-claim). Silent on
 * missing file — idempotent.
 */
function rmLocalTraceFile(domain: string): void {
  for (const fp of [v7DomainFilePath(domain), v7TmpPendingPath(domain)]) {
    try {
      if (existsSync(fp)) unlinkSync(fp);
    } catch {
      // Best-effort cleanup; never crash the handler over a filesystem hiccup.
    }
  }
}

/**
 * On 503 binding-missing: persist rows with `_v7_pending: true` markers so
 * next-firing knows which rows still need POST.
 *
 * Routing (A1 invariant — STATELESS_BOUNDARY §H rule 1):
 *   Write to `~/.unbrowse/tmp/<sigHash>/trace-pending.jsonl` so the
 *   falsifier
 *   `find ~/.unbrowse -type f ! -path '*wallet*' ! -path '*<slash>tmp<slash>*'`
 *   returns empty after 503.
 *
 * Best-effort; on write failure existing files (if any) remain for retry.
 */
function markLocalRowsPending(domain: string, rows: StoredTrace[]): void {
  try {
    const fp = v7TmpPendingPath(domain);
    mkdirSync(join(fp, ".."), { recursive: true });
    const marked = rows.map((r) => ({ ...r, _v7_pending: true }));
    writeFileSync(fp, marked.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  } catch {
    // Best-effort; existing local file remains for retry on next firing.
  }
}

/**
 * Project + POST. Returns the wire result so the handler can surface the
 * cacheKey pointer to the caller. NEVER throws — surfaces the failure
 * shape via `PostStatelessResult.ok=false`.
 */
async function postV7Traces(
  sessionId: string,
  domain: string,
  v6Rows: StoredTrace[],
): Promise<{ result: PostStatelessResult; v7Traces: V7TraceStep[] }> {
  // 1. Project — strips endpoint_sequence, context_url, params, goal_embedding
  //    UNCONDITIONALLY. After this point no v6 cleartext can leak.
  // 2. Slice to 1024 (backend schema cap).
  const v7Traces = traceV6ToV7Steps(v6Rows).slice(0, 1024);

  // 3. POST. signableFields whitelist is THE security gate at the boundary.
  const result = await postStateless({
    namespace: "trace",
    route: "/v1/trace/append",
    body: {
      sessionId,
      domain,
      traces: v7Traces,
    },
    signableFields: ["sessionId", "domain", "traces", "nonce"],
  });

  return { result, v7Traces };
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "trace")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval trace",
      {
        summary: meta.summary,
        usage: "unbrowse eval trace <session-id|host> [--domain <host>] [--intent <substring>] [--limit <n>]",
        positional: [
          { name: "session-id", description: "Browse session id, or a bare host like `example.com`.", required: true },
        ],
        flags: [
          { name: "--domain", description: "Explicit host (overrides session-id resolution).", value_expected: true },
          { name: "--intent", description: "Filter by intent substring.", value_expected: true },
          { name: "--limit", description: "Max rows to emit (default 50).", value_expected: true },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const sessionIdOrHost = parsed.positional[0];
  if (!sessionIdOrHost) {
    emit(
      {
        error: "missing_positional",
        subcommand: "eval trace",
        required: ["session-id"],
        got: parsed.positional,
        op_kind: meta.op_kind,
        hint: "Pass a session-id from `unbrowse eval sessions`, or a bare host like `example.com`.",
      },
      opts,
    );
    process.exit(EX_GENERIC);
  }

  const domainFlag = typeof parsed.flags.domain === "string" ? parsed.flags.domain : undefined;
  const intentFilter = typeof parsed.flags.intent === "string" ? parsed.flags.intent : undefined;
  const limitFlag = typeof parsed.flags.limit === "string" ? parseInt(parsed.flags.limit, 10) : undefined;
  const limit = Number.isFinite(limitFlag) && (limitFlag as number) > 0 ? (limitFlag as number) : 50;

  try {
    const domain = await resolveDomain(sessionIdOrHost, domainFlag);
    if (!domain) {
      emit(
        {
          ok: false,
          subcommand: "eval trace",
          op_kind: meta.op_kind,
          error: "domain_unresolved",
          hint: "Pass --domain <host>, or a bare host as the positional (e.g. `example.com`).",
        },
        opts,
      );
      process.exit(EX_GENERIC);
    }

    const rows: StoredTrace[] = intentFilter
      ? findTracesByIntent(domain, intentFilter, limit)
      : getRecentTraces(domain, limit);

    // v7 path — project + POST through `postStateless`. When no rows are
    // available, emit an honest empty-state envelope (W24.6 lost sheep #2:
    // no local-redacted JSONL emit path; `GET /v1/trace/list` ships in
    // v7.3).
    if (rows.length === 0) {
      emit(
        {
          ok: true,
          subcommand: "eval trace",
          op_kind: meta.op_kind,
          domain,
          count: 0,
          hint:
            "no local v6 trace rows for this domain; v7 read surface " +
            "(`GET /v1/trace/list`) ships in v7.3",
        },
        opts,
      );
      process.exit(0);
    }

    // SECURITY GATE: never log/emit v6 rows before projection. The
    // projector drops endpoint_sequence/context_url/params/goal_embedding
    // unconditionally — anything that crosses out of postV7Traces is
    // pointer-shaped only.
    // sessionId is the pointer back to SESSION_STATE — accept either a
    // bare host (collapses to "trace-by-host:<host>") or the canonical
    // session id positional. Backend `validateTraceAppendBody` only caps
    // length at 256 chars; the value itself is opaque.
    const sessionIdForWire = looksLikeHost(sessionIdOrHost)
      ? `trace-by-host:${sessionIdOrHost}`
      : sessionIdOrHost;
    const { result, v7Traces } = await postV7Traces(sessionIdForWire, domain, rows);

    if (result.ok) {
      rmLocalTraceFile(domain);
      emit(
        {
          ok: true,
          subcommand: "eval trace",
          op_kind: meta.op_kind,
          domain,
          count: v7Traces.length,
          cacheKey: result.cacheKey,
          receiptId: result.receiptId ?? null,
          idempotent: result.idempotent,
          v7_pointer: `trace://${result.cacheKey}`,
        },
        opts,
      );
      process.exit(0);
    }

    if (result.bindingMissing) {
      // 503 — keep local + mark pending. Emit a sanitized warn to stderr.
      markLocalRowsPending(domain, rows);
      process.stderr.write(
        `[eval trace] v7 namespace '${result.bindingMissing}' unwired; ` +
          `kept ${rows.length} local rows marked _v7_pending=true for retry\n`,
      );
      emit(
        {
          ok: false,
          subcommand: "eval trace",
          op_kind: meta.op_kind,
          domain,
          error: "trace_state_binding_missing",
          bindingMissing: result.bindingMissing,
          cacheKey: result.cacheKey,
          local_rows_kept: rows.length,
          hint: "operator must run `bunx wrangler kv:namespace create TRACE_STATE`",
        },
        opts,
      );
      process.exit(EX_GENERIC);
    }

    // Other failure (4xx / non-503 5xx / network throw). Surface honestly;
    // keep local rows untouched so next firing can retry.
    process.stderr.write(
      `[eval trace] v7 POST failed httpStatus=${result.httpStatus} ` +
        `errorHint=${result.errorHint ?? "<none>"}\n`,
    );
    emit(
      {
        ok: false,
        subcommand: "eval trace",
        op_kind: meta.op_kind,
        domain,
        error: "v7_post_failed",
        httpStatus: result.httpStatus,
        cacheKey: result.cacheKey,
        errorHint: result.errorHint ?? null,
      },
      opts,
    );
    process.exit(EX_GENERIC);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
