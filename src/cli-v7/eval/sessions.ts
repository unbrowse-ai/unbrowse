/**
 * `unbrowse eval sessions` — list browse-session records on disk.
 *
 * 1:1 mapping (kind-map.ts row "eval sessions"):
 *   CLI subcommand  : eval sessions
 *   MCP tool        : unbrowse_sessions
 *   Covenant kind   : observe_sessions
 *   Verb            : eval
 *
 * Walks `~/.unbrowse/sessions/*.json` (pointer-only session records, see
 * src/cli-v7/_session.ts), and for each entry probes whether the Chrome
 * pid is still alive AND the chromeWsUrl is reachable. Returns metadata
 * ONLY — no cookies, headers, page bodies (the session record itself
 * holds no payload).
 *
 * Liveness check is best-effort: `process.kill(pid, 0)` to test pid
 * existence + a fast HEAD probe of the `/json/version` endpoint so we
 * don't lie about a chromePid that's been recycled by the OS.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedV7Args } from "../args.js";
import {
  EX_GENERIC,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import type { BrowseSessionRecord } from "../_session.js";

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
    // chromeWsUrl is `ws://127.0.0.1:<port>/devtools/browser/<uuid>`.
    // The HTTP probe url is `http://127.0.0.1:<port>/json/version`.
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

export async function listSessions(): Promise<SessionRow[]> {
  const dir = join(homedir(), ".unbrowse", "sessions");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const rows: SessionRow[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const path = join(dir, name);
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
        summary: "List browse-session records on disk with liveness.",
        usage: "unbrowse eval sessions [--limit <N>]",
        flags: [
          {
            name: "--limit",
            description: "Max rows (default: unlimited).",
            value_expected: true,
          },
        ],
        covenant_kind: meta.covenant_kind,
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
    emit(
      {
        ok: true,
        subcommand: "eval sessions",
        covenant_kind: meta.covenant_kind,
        count: rows.length,
        sessions: rows,
      },
      opts,
    );
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
