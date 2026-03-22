import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { getPackageRoot, isManagedSkillInstall } from "./paths.js";

const PACKAGE_NAME = "unbrowse";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const AUTO_UPDATE_APPLIED_ENV = "UNBROWSE_AUTO_UPDATE_APPLIED";
const DISABLE_AUTO_UPDATE_ENV = "UNBROWSE_DISABLE_AUTO_UPDATE";

export type AutoUpdateAction =
  | "disabled"
  | "already-applied"
  | "not-packaged-cli"
  | "up-to-date"
  | "check-failed"
  | "npm-exec-latest"
  | "install-global+reexec";

export type AutoUpdateResult = {
  action: AutoUpdateAction;
  currentVersion?: string;
  latestVersion?: string;
  reason?: string;
  exitCode?: number;
};

type PackageMeta = {
  name: string;
  version: string;
  root: string;
};

type SpawnResult = Pick<SpawnSyncReturns<Buffer>, "status" | "error">;

export type AutoUpdateDeps = {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  execPath: string;
  fetchLatestVersion: () => Promise<string | null>;
  readPackageMeta: (metaUrl: string) => PackageMeta | null;
  readGlobalNodeModules: () => string | null;
  spawn: (command: string, args: string[], options: SpawnSyncOptions) => SpawnResult;
  stderr: (msg: string) => void;
};

function defaultSpawn(command: string, args: string[], options: SpawnSyncOptions): SpawnResult {
  const result = spawnSync(command, args, { ...options, stdio: "inherit" });
  return { status: result.status, error: result.error };
}

function readPackageMeta(metaUrl: string): PackageMeta | null {
  const root = getPackageRoot(metaUrl);
  const packageJsonPath = path.join(root, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string; version?: string };
    if (typeof parsed.name !== "string" || typeof parsed.version !== "string") return null;
    return { name: parsed.name, version: parsed.version, root };
  } catch {
    return null;
  }
}

async function defaultFetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(2_500) });
    if (!res.ok) return null;
    const parsed = await res.json() as { version?: string };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function defaultReadGlobalNodeModules(): string | null {
  try {
    const result = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

function pathStartsWith(child: string, parent: string): boolean {
  const normalizedChild = `${child}${path.sep}`;
  const normalizedParent = `${parent}${path.sep}`;
  return normalizedChild.startsWith(normalizedParent);
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function compareSemver(left: string, right: string): number {
  const l = left.split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const r = right.split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (l[i] > r[i]) return 1;
    if (l[i] < r[i]) return -1;
  }
  return 0;
}

function resolveInstallSurface(metaUrl: string, pkgRoot: string, readGlobalNodeModulesFn: () => string | null): "global-npm" | "managed-skill" | "project-node-modules" | "other" {
  if (isManagedSkillInstall(metaUrl)) return "managed-skill";

  const globalRoot = readGlobalNodeModulesFn();
  if (globalRoot) {
    try {
      if (pathStartsWith(realpathSync(pkgRoot), realpathSync(globalRoot))) return "global-npm";
    } catch {
      if (pathStartsWith(path.resolve(pkgRoot), path.resolve(globalRoot))) return "global-npm";
    }
  }

  if (pkgRoot.includes(`${path.sep}node_modules${path.sep}`)) return "project-node-modules";
  return "other";
}

export async function maybeAutoUpdate(metaUrl: string, overrides: Partial<AutoUpdateDeps> = {}): Promise<AutoUpdateResult> {
  const deps: AutoUpdateDeps = {
    argv: overrides.argv ?? process.argv,
    cwd: overrides.cwd ?? process.cwd(),
    env: overrides.env ?? process.env,
    execPath: overrides.execPath ?? process.execPath,
    fetchLatestVersion: overrides.fetchLatestVersion ?? defaultFetchLatestVersion,
    readPackageMeta: overrides.readPackageMeta ?? readPackageMeta,
    readGlobalNodeModules: overrides.readGlobalNodeModules ?? defaultReadGlobalNodeModules,
    spawn: overrides.spawn ?? defaultSpawn,
    stderr: overrides.stderr ?? ((msg: string) => process.stderr.write(msg)),
  };

  if (isTruthyEnv(deps.env[DISABLE_AUTO_UPDATE_ENV])) {
    return { action: "disabled", reason: `${DISABLE_AUTO_UPDATE_ENV} is set` };
  }
  if (isTruthyEnv(deps.env[AUTO_UPDATE_APPLIED_ENV])) {
    return { action: "already-applied", reason: `${AUTO_UPDATE_APPLIED_ENV} is set` };
  }

  const pkg = deps.readPackageMeta(metaUrl);
  if (!pkg || pkg.name !== PACKAGE_NAME) {
    return { action: "not-packaged-cli", reason: "repo/dev source runtime" };
  }

  const latestVersion = await deps.fetchLatestVersion();
  if (!latestVersion) {
    return { action: "check-failed", currentVersion: pkg.version, reason: "could not read npm latest" };
  }
  if (compareSemver(latestVersion, pkg.version) <= 0) {
    return { action: "up-to-date", currentVersion: pkg.version, latestVersion };
  }

  const childEnv = { ...deps.env, [AUTO_UPDATE_APPLIED_ENV]: "1" };
  const installSurface = resolveInstallSurface(metaUrl, pkg.root, deps.readGlobalNodeModules);

  deps.stderr(`[unbrowse] auto-update ${pkg.version} -> ${latestVersion}\n`);

  if (installSurface === "global-npm") {
    const install = deps.spawn("npm", ["install", "-g", `${PACKAGE_NAME}@${latestVersion}`], {
      cwd: deps.cwd,
      env: childEnv,
    });
    if ((install.status ?? 1) === 0) {
      const rerun = deps.spawn(deps.execPath, deps.argv.slice(1), {
        cwd: deps.cwd,
        env: childEnv,
      });
      return {
        action: "install-global+reexec",
        currentVersion: pkg.version,
        latestVersion,
        exitCode: rerun.status ?? 1,
      };
    }
    deps.stderr("[unbrowse] global install update failed; falling back to npm exec latest.\n");
  }

  const rerun = deps.spawn("npm", [
    "exec",
    "--yes",
    "--prefer-online",
    "--package",
    `${PACKAGE_NAME}@${latestVersion}`,
    "--",
    PACKAGE_NAME,
    ...deps.argv.slice(2),
  ], {
    cwd: deps.cwd,
    env: childEnv,
  });

  return {
    action: "npm-exec-latest",
    currentVersion: pkg.version,
    latestVersion,
    exitCode: rerun.status ?? 1,
  };
}
