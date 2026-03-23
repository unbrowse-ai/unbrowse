import { existsSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function getModuleDir(metaUrl: string): string {
  return path.dirname(fileURLToPath(metaUrl));
}

export function getPackageRoot(metaUrl: string): string {
  if (process.env.UNBROWSE_PACKAGE_ROOT) return process.env.UNBROWSE_PACKAGE_ROOT;
  const dir = getModuleDir(metaUrl);

  let cursor = dir;
  while (true) {
    if (existsSync(path.join(cursor, "package.json"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const base = path.basename(dir);
  return base === "src" || base === "dist" ? path.dirname(dir) : dir;
}

export function resolveSiblingEntrypoint(metaUrl: string, basename: string): string {
  const file = fileURLToPath(metaUrl);
  return path.join(path.dirname(file), `${basename}${path.extname(file) || ".js"}`);
}

function resolveBinaryOnPath(name: string): string | null {
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    const output = execFileSync(checker, [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const match = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return match || null;
  } catch {
    return null;
  }
}

export function runtimeInvocationForEntrypoint(metaUrl: string, entrypoint: string): { command: string; args: string[] } {
  if (path.extname(entrypoint) !== ".ts") return { command: process.execPath, args: [entrypoint] };
  if (process.versions.bun) return { command: process.execPath, args: [entrypoint] };

  const bunBinary = process.env.BUN_BIN || resolveBinaryOnPath("bun");
  if (bunBinary) return { command: bunBinary, args: [entrypoint] };

  try {
    const req = createRequire(metaUrl);
    const tsxPkg = req.resolve("tsx/package.json");
    const tsxLoader = path.join(path.dirname(tsxPkg), "dist", "loader.mjs");
    if (existsSync(tsxLoader)) return { command: process.execPath, args: ["--import", tsxLoader, entrypoint] };
  } catch {
    // fall through to bare specifier
  }

  return { command: process.execPath, args: ["--import", "tsx", entrypoint] };
}

export function runtimeArgsForEntrypoint(metaUrl: string, entrypoint: string): string[] {
  return runtimeInvocationForEntrypoint(metaUrl, entrypoint).args;
}

export function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;

  const modulePath = fileURLToPath(metaUrl);
  try {
    return realpathSync(entry) === realpathSync(modulePath);
  } catch {
    return path.resolve(entry) === path.resolve(modulePath);
  }
}

export function getUnbrowseHome(): string {
  return path.join(os.homedir(), ".unbrowse");
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
