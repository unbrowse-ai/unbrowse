/**
 * v7 CLI browse-session record + on-disk persistence.
 *
 * The v7 browse loop (`go -> snap -> fill -> close`) is stateless across CLI
 * processes — each invocation re-attaches to a Chrome that was spawned by a
 * previous `breath go`. The handle that links them is a small JSON record
 * on disk under `~/.unbrowse/tmp/<sigHash>/<id>.json` carrying ONLY:
 *   - sessionId            opaque uuid the agent threads through subsequent calls
 *   - contextId            Target.BrowserContextID from createBrowserContext
 *   - targetId             Target.TargetID from createTarget
 *   - chromeWsUrl          browser-level CDP ws:// endpoint (Chrome /json/version)
 *   - chromePid            so `close` can SIGTERM Chrome when no targets remain
 *   - createdAt            unix ms — for stale-session pruning
 *   - cookiesInventoryRef? sha256 hex of the canonical-JSON auth-profile inventory
 *                          (written by auth-capture per STATELESS_BOUNDARY §E
 *                          Option-1). Pointer-only — values stay in Keychain.
 *
 * Forbidden in this record (load-bearing — see CLAUDE.md "no stubs / no
 * cleartext"): cookies, headers, resolved values, page bodies, selectors, urls.
 * The session file is a pointer-not-payload artifact (contract 3c2dd353).
 *
 * Stateless is the SOLE path (W24.6, Lewis 2026-05-28 — "stateless is the
 * only path, why is that an env"). The session record lands under
 * `~/.unbrowse/tmp/<sigHash>/<id>.json` — a TRANSIENT working cache that
 * the next primitive can read; it is OUTSIDE the A1 falsifier's
 * session-family scan path. Tmp files are best-effort auto-pruned at >24h
 * age. The KV row at the backend is the truth.
 */
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { getUnbrowseHome } from "../runtime/paths.js";

export interface BrowseSessionRecord {
  readonly sessionId: string;
  readonly contextId: string;
  readonly targetId: string;
  readonly chromeWsUrl: string;
  readonly chromePid: number;
  readonly createdAt: number;
  /**
   * sha256 hex of canonical-JSON metadata inventory captured during a
   * preceding `breath auth-capture`. Pointer-only — cookie VALUES live
   * in OS Keychain at `unbrowse-auth/<domain>`, never in this record.
   * Optional: most sessions never run auth-capture.
   */
  readonly cookies_inventory_ref?: string;
}

function statelessTmpRoot(): string {
  return join(getUnbrowseHome(), "tmp");
}

/**
 * Where a session record lands — always a sigHash-scoped tmp working
 * dir under `~/.unbrowse/tmp/<sigHash>/<id>.json`. The file exists only
 * to bridge two primitives in the same conversation; the KV row at the
 * backend is the truth.
 *
 * The sigHash is derived from sessionId so that:
 *   1. Different sessions land in different tmp subdirs (no crosstalk).
 *   2. The same sessionId across invocations lands in the same subdir
 *      (the bridging primitive can find it).
 */
function sessionTmpDir(sessionId: string): string {
  // 16 hex chars from sessionId hash — short enough to be readable, long
  // enough to avoid collisions in any realistic workload.
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return join(statelessTmpRoot(), hash);
}

function sessionPath(sessionId: string): string {
  return join(sessionTmpDir(sessionId), `${sessionId}.json`);
}

export async function writeSessionRecord(rec: BrowseSessionRecord): Promise<string> {
  const path = sessionPath(rec.sessionId);
  await mkdir(join(path, ".."), { recursive: true });
  // Atomic write (no-torn-read race): write the full record to a unique temp
  // file in the SAME dir, then rename() onto the final path. rename() is atomic
  // on POSIX, so any concurrent reader (readSessionRecord / mostRecentSession /
  // anotherSessionUsesChrome) sees EITHER the old complete file OR the new one —
  // never a half-written JSON. The temp name is pid+random-unique so two
  // concurrent writers never clobber each other's in-flight temp; same-dir keeps
  // the rename on one filesystem (no EXDEV). Pretty-printed for the rare human
  // reader; the contents are pointer-only.
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
  try {
    await rename(tmp, path);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* best-effort temp cleanup */
    }
    throw err;
  }
  return path;
}

export async function readSessionRecord(sessionId: string): Promise<BrowseSessionRecord> {
  const raw = await readFile(sessionPath(sessionId), "utf8");
  return JSON.parse(raw) as BrowseSessionRecord;
}

export async function deleteSessionRecord(sessionId: string): Promise<void> {
  const p = sessionPath(sessionId);
  try {
    await unlink(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
  // Also rm the sigHash subdir if empty.
  try {
    const dir = sessionTmpDir(sessionId);
    const remaining = await readdir(dir);
    if (remaining.length === 0) {
      await rm(dir, { recursive: true, force: true });
    }
  } catch {
    // best-effort
  }
}

/** Walk every session record under tmp/<sigHash>/<id>.json. */
async function* walkSessionFiles(): AsyncGenerator<string> {
  const root = statelessTmpRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
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

/**
 * Most-recent session, by createdAt. Returns null if no sessions exist.
 */
export async function mostRecentSession(): Promise<BrowseSessionRecord | null> {
  let newest: BrowseSessionRecord | null = null;
  for await (const path of walkSessionFiles()) {
    try {
      const st = await stat(path);
      if (!st.isFile()) continue;
      const raw = await readFile(path, "utf8");
      const rec = JSON.parse(raw) as BrowseSessionRecord;
      if (!newest || rec.createdAt > newest.createdAt) newest = rec;
    } catch {
      // Skip unreadable / malformed session files; do not throw.
    }
  }
  return newest;
}

/**
 * True iff the OS process is alive. `kill(pid, 0)` probes existence WITHOUT
 * sending a signal: it throws ESRCH when the process is gone, EPERM when it
 * exists but we may not signal it (still alive). The persisted Chrome's pid is
 * the liveness proxy for a browse session.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Most-recent session whose Chrome is still alive; prunes dead ones it passes. */
async function mostRecentLiveSession(): Promise<BrowseSessionRecord | null> {
  const recs: BrowseSessionRecord[] = [];
  for await (const path of walkSessionFiles()) {
    try {
      recs.push(JSON.parse(await readFile(path, "utf8")) as BrowseSessionRecord);
    } catch {
      /* skip unreadable */
    }
  }
  recs.sort((a, b) => b.createdAt - a.createdAt);
  for (const rec of recs) {
    if (isProcessAlive(rec.chromePid)) return rec;
    // Dead Chrome → stale record; prune it (best-effort) and keep looking.
    await deleteSessionRecord(rec.sessionId).catch(() => undefined);
  }
  return null;
}

export async function resolveSession(
  explicitId: string | undefined,
  opts: { probeLive?: boolean } = {},
): Promise<BrowseSessionRecord> {
  const probeLive = opts.probeLive ?? true;

  if (explicitId) {
    const rec = await readSessionRecord(explicitId);
    if (probeLive && !isProcessAlive(rec.chromePid)) {
      // Named session's Chrome is gone — prune + fail with a clean, actionable
      // error instead of a raw ECONNREFUSED from the downstream CDP attach.
      await deleteSessionRecord(rec.sessionId).catch(() => undefined);
      const err = new Error("session_expired");
      (err as Error & { code?: string }).code = "session_expired";
      throw err;
    }
    return rec;
  }

  const recent = probeLive ? await mostRecentLiveSession() : await mostRecentSession();
  if (!recent) {
    const err = new Error("no_active_session");
    (err as Error & { code?: string }).code = "no_active_session";
    throw err;
  }
  return recent;
}

/**
 * Bound the persisted-Chrome footprint so `act go` without a matching
 * `act close` cannot leak browsers indefinitely. Best-effort, never throws:
 *   1. Delete every record whose Chrome pid is already dead (pure cleanup).
 *   2. If more than `maxLive` browse sessions are still alive, SIGTERM the
 *      Chrome of the OLDEST ones (least likely to be in active use) and delete
 *      their records, down to the cap.
 * Returns the number of records reaped. Call at the start of `act go`.
 */
export async function reapStaleSessions(
  opts: { maxLive?: number } = {},
): Promise<number> {
  const envMax = Number.parseInt(process.env.UNBROWSE_MAX_BROWSE_SESSIONS ?? "", 10);
  const maxLive = opts.maxLive ?? (Number.isInteger(envMax) && envMax > 0 ? envMax : 8);

  const recs: BrowseSessionRecord[] = [];
  for await (const path of walkSessionFiles()) {
    try {
      recs.push(JSON.parse(await readFile(path, "utf8")) as BrowseSessionRecord);
    } catch {
      /* skip unreadable */
    }
  }

  let reaped = 0;
  const live: BrowseSessionRecord[] = [];
  for (const rec of recs) {
    if (isProcessAlive(rec.chromePid)) {
      live.push(rec);
    } else {
      await deleteSessionRecord(rec.sessionId).catch(() => undefined);
      reaped++;
    }
  }

  if (live.length > maxLive) {
    // Oldest first; kill the overflow.
    live.sort((a, b) => a.createdAt - b.createdAt);
    for (const rec of live.slice(0, live.length - maxLive)) {
      const shared = await anotherSessionUsesChrome(rec.chromePid, rec.sessionId);
      if (!shared) {
        try {
          process.kill(rec.chromePid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
      await deleteSessionRecord(rec.sessionId).catch(() => undefined);
      reaped++;
    }
  }

  return reaped;
}

/** Returns true iff any other session record references the same chrome pid. */
export async function anotherSessionUsesChrome(
  chromePid: number,
  excludeSessionId: string,
): Promise<boolean> {
  const excludeFile = `${excludeSessionId}.json`;
  for await (const path of walkSessionFiles()) {
    if (path.endsWith(`/${excludeFile}`)) continue;
    try {
      const raw = await readFile(path, "utf8");
      const rec = JSON.parse(raw) as BrowseSessionRecord;
      if (rec.chromePid === chromePid) return true;
    } catch {
      // ignore unreadable
    }
  }
  return false;
}
