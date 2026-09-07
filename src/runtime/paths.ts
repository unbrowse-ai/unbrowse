import { existsSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export function getModuleDir(metaUrl: string): string {
  return path.dirname(fileURLToPath(metaUrl));
}

export function getPackageRoot(metaUrl: string): string {
  if (process.env.UNBROWSE_PACKAGE_ROOT) return process.env.UNBROWSE_PACKAGE_ROOT;
  let dir = getModuleDir(metaUrl);
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return getModuleDir(metaUrl);
}

export function resolveSiblingEntrypoint(metaUrl: string, basename: string): string {
  const file = fileURLToPath(metaUrl);
  return path.join(path.dirname(file), `${basename}${path.extname(file) || ".js"}`);
}

export function isBundledVirtualEntrypoint(entrypoint: string): boolean {
  return entrypoint.startsWith("/$bunfs/");
}

export function runtimeArgsForEntrypoint(metaUrl: string, entrypoint: string): string[] {
  if (path.extname(entrypoint) !== ".ts") {
    // Node's ESM loader rejects bare "C:\..." on Windows with
    // ERR_UNSUPPORTED_ESM_URL_SCHEME. Wrap as file:// only on Windows so
    // process.argv[1] stays a valid filesystem path on POSIX (Node 25.x's
    // CJS loader passes argv[1] through path.resolve and chokes on file://).
    return process.platform === "win32" ? [pathToFileURL(entrypoint).href] : [entrypoint];
  }
  if (process.versions.bun) return [entrypoint];

  try {
    const req = createRequire(metaUrl);
    const tsxPkg = req.resolve("tsx/package.json");
    const tsxLoader = path.join(path.dirname(tsxPkg), "dist", "loader.mjs");
    if (existsSync(tsxLoader)) return ["--import", pathToFileURL(tsxLoader).href, entrypoint];
  } catch {
    // fall through to bare specifier
  }

  return ["--import", "tsx", entrypoint];
}

export function isMainModule(metaUrl: string): boolean {
  let entry = process.argv[1];
  if (!entry) return false;
  // runtimeArgsForEntrypoint hands the child a file:// URL for bare .js
  // entries. realpathSync throws on URL strings, and the catch-branch's
  // path.resolve would then return a garbage path so this function always
  // returned false — main() silently never ran. Unwrap first.
  if (entry.startsWith("file://")) {
    try { entry = fileURLToPath(entry); } catch { /* fall through */ }
  }

  const modulePath = fileURLToPath(metaUrl);
  try {
    return realpathSync(entry) === realpathSync(modulePath);
  } catch {
    return path.resolve(entry) === path.resolve(modulePath);
  }
}

/**
 * Packaged runtime entry identity.
 *
 * `bun build` of mcp.ts inlines cli.ts. In that single file, every module's
 * `import.meta.url` equals `process.argv[1]` (the mcp bundle path), so
 * `isMainModule` alone wrongly fires CLI auto-main on the first lazy import
 * of `cmdGet` — dumping CLI help onto MCP stdout and `process.exit(0)`.
 * Hosts then report "MCP transport dropped".
 *
 * Resolution order: env → bun `--define UNBROWSE_RUNTIME_ENTRY=…` → argv basename.
 */
export type RuntimeEntryKind = "cli" | "mcp" | "contract-bridge" | "unknown";

// Injected by scripts/build-runtime-scrubbed.sh via bun --define. Monorepo
// source runs leave it undeclared; `typeof` is safe (no ReferenceError).
declare const UNBROWSE_RUNTIME_ENTRY: string | undefined;

export function getRuntimeEntryKind(): RuntimeEntryKind {
  const fromEnv = process.env.UNBROWSE_RUNTIME_ENTRY?.trim().toLowerCase();
  if (fromEnv === "cli" || fromEnv === "mcp" || fromEnv === "contract-bridge") {
    return fromEnv;
  }
  const injected = typeof UNBROWSE_RUNTIME_ENTRY === "string"
    ? UNBROWSE_RUNTIME_ENTRY.trim().toLowerCase()
    : "";
  if (injected === "cli" || injected === "mcp" || injected === "contract-bridge") {
    return injected;
  }
  let entry = process.argv[1] ?? "";
  if (entry.startsWith("file://")) {
    try { entry = fileURLToPath(entry); } catch { /* keep */ }
  }
  const base = path.basename(entry).toLowerCase();
  if (base === "mcp.js" || base === "mcp.ts" || base === "mcp") return "mcp";
  if (base === "contract-bridge.js" || base === "contract-bridge.ts" || base === "contract-bridge") {
    return "contract-bridge";
  }
  if (
    base === "cli.js" || base === "cli.ts" || base === "cli"
    || base === "unbrowse.js" || base === "unbrowse"
  ) {
    return "cli";
  }
  return "unknown";
}

/**
 * Whether cli.ts may auto-run `main()` as the process entrypoint.
 * False inside MCP/stdio (and other non-CLI entries) even when the
 * single-file bundle makes `isMainModule` true for inlined cli code.
 */
export function shouldAutoRunCliMain(metaUrl: string): boolean {
  if (process.env.MCP_SERVER_MODE === "1") return false;
  const kind = getRuntimeEntryKind();
  if (kind === "mcp" || kind === "contract-bridge") return false;
  return isMainModule(metaUrl);
}

/**
 * The unbrowse data root. `UNBROWSE_HOME` overrides the default `~/.unbrowse`
 * everywhere (U-3) so an isolated run — a test, a CI runner, a second profile —
 * can relocate ALL on-disk state with one knob. Empty/whitespace is ignored so
 * `UNBROWSE_HOME=` does not silently break the default install.
 */
export function getUnbrowseHome(): string {
  const override = process.env.UNBROWSE_HOME?.trim();
  if (override) return override;
  // $HOME before os.homedir(). Measured under bun: os.homedir() does NOT follow
  // a HOME set mid-process (HOME=/tmp/X -> os.homedir() still /home/deck), and
  // relocating a process by setting HOME is exactly what sandboxes and tests do
  // — src/cli-v7/eval/settings.ts already documented honouring "a runtime $HOME
  // override (some tests / sandboxes set $HOME mid-process)" while this, the
  // canonical resolver, did not. Every caller that moved onto this helper had
  // been reading process.env.HOME directly, so reading it here keeps their
  // behaviour identical and merely ADDS the UNBROWSE_HOME knob.
  const home = process.env.HOME?.trim();
  return path.join(home || os.homedir(), ".unbrowse");
}

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getLogsDir(): string {
  return ensureDir(path.join(getUnbrowseHome(), "logs"));
}

export function getRunDir(): string {
  return ensureDir(process.env.UNBROWSE_RUN_DIR || path.join(getUnbrowseHome(), "run"));
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9.-]+/g, "_");
}

export function getServerPidFile(baseUrl: string): string {
  const url = new URL(baseUrl);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const host = sanitizeSegment(url.hostname || "127.0.0.1");
  return path.join(getRunDir(), `server-${host}-${port}.json`);
}

export function getServerAutostartLogFile(): string {
  return path.join(getLogsDir(), "server-autostart.log");
}

export function isManagedSkillInstall(metaUrl: string): boolean {
  const managedDir = process.env.UNBROWSE_SKILL_DIR || path.join(os.homedir(), ".agents", "skills", "unbrowse");
  const pkgRoot = getPackageRoot(metaUrl);
  try {
    return realpathSync(pkgRoot) === realpathSync(managedDir);
  } catch {
    return false;
  }
}
