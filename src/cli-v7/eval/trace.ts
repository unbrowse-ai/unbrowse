/**
 * `unbrowse eval trace <session-id>` — read stateless decision_trace.
 *
 * 1:1 mapping (kind-map.ts row "eval trace"):
 *   CLI subcommand  : eval trace
 *   MCP tool        : unbrowse_trace
 *   Covenant kind   : observe_trace
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
  type StoredTrace,
} from "../../graph/trace-store.js";
import { readSessionRecord } from "../_session.js";

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
        covenant_kind: meta.covenant_kind,
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
        covenant_kind: meta.covenant_kind,
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
          covenant_kind: meta.covenant_kind,
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

    const redacted = rows.map(redactStoredTrace);

    if (opts.json) {
      emit(
        {
          ok: true,
          subcommand: "eval trace",
          covenant_kind: meta.covenant_kind,
          domain,
          count: redacted.length,
          rows: redacted,
        },
        opts,
      );
    } else {
      // JSONL on stdout — one row per line, defensive single-line JSON.
      for (const row of redacted) {
        process.stdout.write(JSON.stringify(row) + "\n");
      }
    }
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
