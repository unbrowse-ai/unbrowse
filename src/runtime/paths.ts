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

export function runtimeArgsForEntrypoint(metaUrl: string, entrypoint: string): string[] {
  if (path.extname(entrypoint) !== ".ts") return [entrypoint];
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
