/**
 * `unbrowse eval sessions` — list browse-session records visible to this CLI.
 *
 * 1:1 mapping (kind-map.ts row "eval sessions"):
 *   CLI subcommand  : eval sessions
 *   MCP tool        : unbrowse_sessions
 *   Op kind   : eval:sessions
 *   Verb            : eval
 *
 * W24.6 (Lewis 2026-05-28 — "stateless is the only path"): the transient
 * working copies live at `~/.unbrowse/tmp/<sigHash>/<id>.json` and are
 * walked here. The KV ROW at the backend is the truth (per
 * `_session.ts`); the tmp file is a bridge between two primitives in
 * the same conversation.
 *
 * The canonical wallet-scoped enumeration is `GET /v1/session/
 * list-by-wallet` (W23 territory). As of v7.2.0-preview.0 that endpoint
 * DOES NOT EXIST yet — only `POST /v1/session/park` and `GET /v1/
 * session/restore/:id` are wired. The handler logs the gap as
 * `_stateless_listing_gap` so the caller knows the listing is
 * best-effort local-tmp until the wallet-listed KV scan endpoint ships.
 *
 * Liveness check is best-effort: `process.kill(pid, 0)` for pid
 * existence + a fast HEAD probe of `/json/version` so we never lie
 * about a chromePid that's been recycled by the OS.
 */
import { readFile, stat } from "node:fs/promises";
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
  type BrowseSessionRecord,
  // Re-implemented locally — module-private walker semantics
  // (~/.unbrowse/tmp/<sigHash>/*.json).
  // eslint-disable-next-line @typescript-eslint/no-restricted-imports
} from "../_session.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getUnbrowseHome } from "../../runtime/paths.js";
import { postStateless } from "../_stateless.js";

interface SessionRow {
  readonly sessionId: string;
  readonly targetId: string;
  readonly chromeWsUrl: string;
  readonly chromePid: number;
  readonly createdAt: number;
  readonly alive: boolean;
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * HEAD the chrome `/json/version` (browser-level endpoint). 500ms cap
 * — slow paths shouldn't make a list call wedge.
 */
async function chromeReachable(chromeWsUrl: string): Promise<boolean> {
  try {
    const m = chromeWsUrl.match(/^wss?:\/\/([^/]+)/);
    if (!m) return false;
    const httpProbe = `http://${m[1]}/json/version`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 500);
    try {
      const r = await fetch(httpProbe, { signal: ctrl.signal });
      return r.ok;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

/**
 * Walk every session JSON file under `~/.unbrowse/tmp/<sigHash>/*.json`.
 *
 * Re-implemented here (rather than importing the private generator from
 * `_session.ts`) because the generator is module-private; this walk has
 * the same semantics and is the single read-only surface eval needs.
 */
async function* walkVisibleSessionFiles(): AsyncGenerator<string> {
  const root = join(getUnbrowseHome(), "tmp");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  // tmp/<sigHash>/<id>.json — walk one level deeper.
  for (const sub of entries) {
    const subDir = join(root, sub);
    let subEntries: string[];
    try {
      const st = await stat(subDir);
      if (!st.isDirectory()) continue;
      subEntries = await readdir(subDir);
    } catch {
      continue;
    }
    for (const name of subEntries) {
      if (!name.endsWith(".json")) continue;
      yield join(subDir, name);
    }
  }
}

export async function listSessions(): Promise<SessionRow[]> {
  const rows: SessionRow[] = [];
  for await (const path of walkVisibleSessionFiles()) {
    try {
      const st = await stat(path);
      if (!st.isFile()) continue;
      const raw = await readFile(path, "utf8");
      const rec = JSON.parse(raw) as BrowseSessionRecord;
      const pidOk = pidAlive(rec.chromePid);
      const reachable = pidOk ? await chromeReachable(rec.chromeWsUrl) : false;
      rows.push({
        sessionId: rec.sessionId,
        targetId: rec.targetId,
        chromeWsUrl: rec.chromeWsUrl,
        chromePid: rec.chromePid,
        createdAt: rec.createdAt,
        alive: pidOk && reachable,
      });
    } catch {
      // skip malformed / unreadable rows — do not throw
    }
  }
  // newest first
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return rows;
}

export async function handler(
  parsed: ParsedV7Args,
  opts: OutputOptions,
): Promise<void> {
  const meta = lookupKindMap("eval", "sessions")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval sessions",
      {
        summary: "List browse-session records visible to this CLI with liveness.",
        usage: "unbrowse eval sessions [--limit <N>]",
        flags: [
          {
            name: "--limit",
            description: "Max rows (default: unlimited).",
            value_expected: true,
          },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  try {
    let rows = await listSessions();
    const limit =
      typeof parsed.flags.limit === "string"
        ? Number.parseInt(parsed.flags.limit, 10)
        : NaN;
    if (Number.isFinite(limit) && limit > 0) {
      rows = rows.slice(0, limit);
    }

    // Day-7 audit material: until /v1/session/list-by-wallet ships
    // (W23 v7.3 territory), the canonical wallet-listed KV view is
    // unavailable. The agent sees this gap explicitly.
    const envelope: Record<string, unknown> = {
      ok: true,
      subcommand: "eval sessions",
      op_kind: meta.op_kind,
      count: rows.length,
      sessions: rows,
      _stateless_listing_gap: {
        endpoint: "/v1/session/list-by-wallet",
        status: "not_yet_implemented",
        wave_hint:
          "v7.2.0-preview.0 only ships /v1/session/{park,restore/:id}. " +
          "Wallet-scoped enumeration ships in v7.3 (W23 follow-up). Until " +
          "then, eval sessions lists local-tmp bridge records " +
          "(~/.unbrowse/tmp/<sigHash>/*.json) only — these are best-effort " +
          "working copies; the KV row is the truth.",
        local_tmp_scan: true,
      },
    };

    // W24.2 — sig-keyed eval-read audit row. readKind=sessions is a
    // local-tmp + KV-list enumeration; no Chrome tab. byteCount is the
    // row payload size for forensic correlation.
    const post = await postStateless({
      namespace: "audit",
      route: "/v1/audit/eval-read",
      body: {
        readKind: "sessions" as const,
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
    envelope.audit_emit = {
      ok: post.ok,
      cacheKey: post.cacheKey,
      receiptId: post.receiptId,
      httpStatus: post.httpStatus,
      bindingMissing: post.bindingMissing,
      errorHint: post.errorHint,
    };

    emit(envelope, opts);
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
