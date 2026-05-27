/**
 * v7 CLI browse-session record + on-disk persistence.
 *
 * The v7 browse loop (`go -> snap -> fill -> close`) is stateless across CLI
 * processes — each invocation re-attaches to a Chrome that was spawned by a
 * previous `breath go`. The handle that links them is a small JSON record
 * on disk under `~/.unbrowse/sessions/<id>.json` carrying ONLY:
 *   - sessionId            opaque uuid the agent threads through subsequent calls
 *   - contextId            Target.BrowserContextID from createBrowserContext
 *   - targetId             Target.TargetID from createTarget
 *   - chromeWsUrl          browser-level CDP ws:// endpoint (Chrome /json/version)
 *   - chromePid            so `close` can SIGTERM Chrome when no targets remain
 *   - createdAt            unix ms — for stale-session pruning
 *
 * Forbidden in this record (load-bearing — see CLAUDE.md "no stubs / no
 * cleartext"): cookies, headers, resolved values, page bodies, selectors, urls.
 * The session file is a pointer-not-payload artifact (contract 3c2dd353).
 */
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BrowseSessionRecord {
  readonly sessionId: string;
  readonly contextId: string;
  readonly targetId: string;
  readonly chromeWsUrl: string;
  readonly chromePid: number;
  readonly createdAt: number;
}

function sessionsDir(): string {
  return join(homedir(), ".unbrowse", "sessions");
}

function sessionPath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.json`);
}

export async function writeSessionRecord(rec: BrowseSessionRecord): Promise<string> {
  const dir = sessionsDir();
  await mkdir(dir, { recursive: true });
  const path = sessionPath(rec.sessionId);
  // Pretty-printed for the (rare) human reader; the contents are pointer-only.
  await writeFile(path, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
  return path;
}

export async function readSessionRecord(sessionId: string): Promise<BrowseSessionRecord> {
  const raw = await readFile(sessionPath(sessionId), "utf8");
  return JSON.parse(raw) as BrowseSessionRecord;
}

export async function deleteSessionRecord(sessionId: string): Promise<void> {
  try {
    await unlink(sessionPath(sessionId));
  } catch (err) {
    // File-not-found is idempotent success — anything else is an honest failure.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}

/**
 * Most-recent session, by createdAt. Returns null if no sessions exist.
 * Used by `eval snap`, `breath fill`, `breath close` when no `--session` is
 * supplied — agents that only ever drive one session at a time get implicit
 * routing.
 */
export async function mostRecentSession(): Promise<BrowseSessionRecord | null> {
  const dir = sessionsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let newest: BrowseSessionRecord | null = null;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const path = join(dir, name);
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
 * Resolve a session by explicit id, or fall back to most-recent. Throws a
 * machine-readable error envelope on miss so the CLI surface stays uniform.
 */
export async function resolveSession(
  explicitId: string | undefined,
): Promise<BrowseSessionRecord> {
  if (explicitId) {
    return readSessionRecord(explicitId);
  }
  const recent = await mostRecentSession();
  if (!recent) {
    const err = new Error("no_active_session");
    (err as Error & { code?: string }).code = "no_active_session";
    throw err;
  }
  return recent;
}

/** Returns true iff any other session record references the same chrome pid. */
export async function anotherSessionUsesChrome(
  chromePid: number,
  excludeSessionId: string,
): Promise<boolean> {
  const dir = sessionsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    if (name === `${excludeSessionId}.json`) continue;
    try {
      const raw = await readFile(join(dir, name), "utf8");
      const rec = JSON.parse(raw) as BrowseSessionRecord;
      if (rec.chromePid === chromePid) return true;
    } catch {
      // ignore unreadable
    }
  }
  return false;
}
