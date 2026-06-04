/**
 * v7 CLI browse-session record + on-disk persistence.
 *
 * The v7 browse loop (`go -> snap -> fill -> close`) is stateless across CLI
 * processes — each invocation re-attaches to a Chrome that was spawned by a
 * previous `act go`. The handle that links them is a small JSON record
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
  stat,
  unlink,
  writeFile,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface BrowseSessionRecord {
  readonly sessionId: string;
  readonly contextId: string;
  readonly targetId: string;
  readonly chromeWsUrl: string;
  readonly chromePid: number;
  readonly createdAt: number;
  /**
   * sha256 hex of canonical-JSON metadata inventory captured during a
   * preceding `act auth-capture`. Pointer-only — cookie VALUES live
   * in OS Keychain at `unbrowse-auth/<domain>`, never in this record.
   * Optional: most sessions never run auth-capture.
   */
  readonly cookies_inventory_ref?: string;
}

function statelessTmpRoot(): string {
  return join(homedir(), ".unbrowse", "tmp");
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
  // Pretty-printed for the (rare) human reader; the contents are pointer-only.
  await writeFile(path, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
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
