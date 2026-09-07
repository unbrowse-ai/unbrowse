import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getModuleDir, getPackageRoot, getUnbrowseHome } from "./paths.js";
import { apiContract } from "../values/api-contract.js";

export type InstallMethod = "repo-clone" | "npm-global" | "unknown";
export type InstallHost = "auto" | "codex" | "claude" | "mcp" | "off" | "unknown";
export type HookAction = "installed" | "updated" | "already-installed" | "not-detected" | "skipped" | "failed";

export type UpdateHookStatus = {
  host: "codex" | "claude";
  action: HookAction;
  config_file?: string;
  message?: string;
};

export type InstallSourceState = {
  method: InstallMethod;
  host: InstallHost;
  package_root: string;
  repo_root?: string;
  recorded_at: string;
};

type UpdateCheckState = {
  checked_at?: string;
  latest_version?: string;
  latest_checked_at?: string;
  notified_version?: string;
  notified_at?: string;
  auto_update_attempted_at?: string;
  auto_update_target?: string;
  bg_check_spawned_at?: string;
};

export type UpdateCheckResult = {
  installed: string;
  latest: string | null;
  has_update: boolean;
  install: InstallSourceState;
  command: string;
  checked_at: string;
  cached: boolean;
};

const INSTALL_SCRIPT_URL = "https://unbrowse.ai/install.sh";
const DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000;
const CODEX_MARKER = "# Unbrowse update hints — managed by unbrowse setup";

function getHomeDir(): string {
  return process.env.HOME || os.homedir();
}

function getConfigDir(): string {
  if (process.env.UNBROWSE_CONFIG_DIR) return process.env.UNBROWSE_CONFIG_DIR;
  return getUnbrowseHome();
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function getInstallSourcePath(): string {
  return path.join(getConfigDir(), "install-source.json");
}

function getUpdateCheckStatePath(): string {
  return path.join(getConfigDir(), "update-check.json");
}

function detectRepoRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  return undefined;
}

function detectInstallMethod(packageRoot: string): InstallMethod {
  if (process.env.UNBROWSE_SETUP_METHOD === "repo-clone") return "repo-clone";
  if (process.env.UNBROWSE_SETUP_METHOD === "npm-global") return "npm-global";
  if (packageRoot.includes(`${path.sep}node_modules${path.sep}`)) return "npm-global";
  return detectRepoRoot(packageRoot) ? "repo-clone" : "unknown";
}

function detectInstallHost(repoRoot: string | undefined): InstallHost {
  const explicit = process.env.UNBROWSE_SETUP_HOST as InstallHost | undefined;
  if (explicit) return explicit;
  if (!repoRoot) return "unknown";

  const codexHome = process.env.CODEX_HOME || path.join(getHomeDir(), ".codex");
  if (repoRoot === path.join(codexHome, "skills", "unbrowse")) return "codex";
  if (repoRoot === path.join(getHomeDir(), ".claude", "skills", "unbrowse")) return "claude";
  if (repoRoot === path.join(getHomeDir(), "unbrowse")) return "off";
  return "unknown";
}

export function getInstalledVersion(metaUrl: string): string {
  // Walk up from the module dir to the first package.json that actually carries a
  // version. The shipped runtime includes a `runtime/package.json` stub
  // (`{"type":"module"}`, no version); naively reading the nearest package.json
  // yields "unknown", which makes the updater believe it is perpetually behind and
  // reinstall every interval. Skip version-less stubs.
  let dir = getModuleDir(metaUrl);
  const root = path.parse(dir).root;
  while (dir !== root) {
    const pj = path.join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const pkg = JSON.parse(readFileSync(pj, "utf8")) as { version?: string };
        if (typeof pkg.version === "string" && pkg.version.trim()) return pkg.version.trim();
      } catch { /* unreadable — keep walking up */ }
    }
    dir = path.dirname(dir);
  }
  return "unknown";
}

export function resolveInstallSource(metaUrl: string): InstallSourceState {
  const packageRoot = getPackageRoot(metaUrl);
  const envRepoRoot = process.env.UNBROWSE_SETUP_ROOT || undefined;
  const repoRoot = envRepoRoot || detectRepoRoot(packageRoot);
  return {
    method: detectInstallMethod(packageRoot),
    host: detectInstallHost(repoRoot),
    package_root: packageRoot,
    repo_root: repoRoot,
    recorded_at: new Date().toISOString(),
  };
}

export function saveInstallSource(metaUrl: string): InstallSourceState {
  const state = resolveInstallSource(metaUrl);
  writeJsonFile(getInstallSourcePath(), state);
  return state;
}

export function loadInstallSource(metaUrl: string): InstallSourceState {
  return readJsonFile<InstallSourceState>(getInstallSourcePath()) ?? resolveInstallSource(metaUrl);
}

function compareSemver(a: string, b: string): number {
  const parse = (value: string) => value.split("-", 1)[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchLatestVersion(): Promise<string | null> {
  // Every API read becomes /contract muscle memory: the npm latest-version GET recalls from the
  // contract ledger first and only hits the registry (the legacy internet) on a miss. mirror:false —
  // a hot CLI read must not float an off-machine mirror socket that delays process exit (the hang
  // fixed in 8080e567). A null (offline/error) is never memoized → it stays live.
  try {
    const r = await apiContract<string | null>({
      api: "npm.latest-version",
      args: "unbrowse",
      ttlMs: 5 * 60_000,
      cacheable: (v) => v != null,
      mirror: false,
      produce: async () => {
        try {
          const res = await fetch("https://registry.npmjs.org/unbrowse/latest", {
            signal: AbortSignal.timeout(8_000),
            headers: { Accept: "application/json" },
          });
          if (!res.ok) return null;
          const body = await res.json() as { version?: string };
          return typeof body.version === "string" && body.version.trim() ? body.version.trim() : null;
        } catch {
          return null;
        }
      },
    });
    return r.value;
  } catch {
    // contract-ledger infra failure must never break the update check — fall to a live null
    return null;
  }
}

function getUpdateIntervalMs(): number {
  const value = Number.parseInt(process.env.UNBROWSE_UPDATE_CHECK_INTERVAL_MS ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_INTERVAL_MS;
}

export function buildUpgradeCommand(install: InstallSourceState): string {
  if (install.method === "repo-clone" && install.repo_root) {
    const host = install.host === "unknown" || install.host === "auto" ? "off" : install.host;
    return `cd ${install.repo_root} && git pull --ff-only && ./setup --host ${host}`;
  }
  return `curl -fsSL ${INSTALL_SCRIPT_URL} | bash`;
}

export async function checkForUpdates(metaUrl: string, options?: { force?: boolean }): Promise<UpdateCheckResult> {
  const installed = getInstalledVersion(metaUrl);
  const install = loadInstallSource(metaUrl);
  const statePath = getUpdateCheckStatePath();
  const state = readJsonFile<UpdateCheckState>(statePath) ?? {};
  const checkedAt = new Date().toISOString();
  const intervalMs = getUpdateIntervalMs();
  const lastChecked = state.latest_checked_at ? Date.parse(state.latest_checked_at) : Number.NaN;
  const useCache = !options?.force &&
    !!state.latest_version &&
    Number.isFinite(lastChecked) &&
    Date.now() - lastChecked < intervalMs;
  const latest = useCache ? state.latest_version ?? null : await fetchLatestVersion();

  if (!useCache) {
    writeJsonFile(statePath, {
      ...state,
      checked_at: checkedAt,
      latest_version: latest ?? undefined,
      latest_checked_at: checkedAt,
    } satisfies UpdateCheckState);
  }

  return {
    installed,
    latest,
    has_update: !!latest && compareSemver(latest, installed) > 0,
    install,
    command: buildUpgradeCommand(install),
    checked_at: checkedAt,
    cached: useCache,
  };
}

export function recordUpdateHint(latestVersion: string): void {
  const statePath = getUpdateCheckStatePath();
  const state = readJsonFile<UpdateCheckState>(statePath) ?? {};
  writeJsonFile(statePath, {
    ...state,
    notified_version: latestVersion,
    notified_at: new Date().toISOString(),
  } satisfies UpdateCheckState);
}

// ── Auto-update ───────────────────────────────────────────────────────────────
// The client keeps itself current. We can't hot-swap the running process, so the
// update is applied in the background (detached, non-blocking) and takes effect on
// the NEXT invocation — the standard safe self-update shape (npm/yarn/gh-cli do the
// same: never block the in-flight command on a reinstall).

export type AutoUpdateDecision = { update: boolean; reason: string };

/** Truthy-string env guard (1/true/yes). */
function envOn(name: string): boolean {
  const v = (process.env[name] ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Pure decision: should we attempt an auto-update now? No I/O — every input is a
 * parameter, so this is unit-testable without network, fs, or a clock.
 */
export function shouldAutoUpdate(input: {
  hasUpdate: boolean;
  method: InstallMethod;
  disabled: boolean; // opt-out env / CI
  lastAttemptAt?: string;
  nowMs: number;
  intervalMs: number;
}): AutoUpdateDecision {
  if (input.disabled) return { update: false, reason: "disabled" };
  if (!input.hasUpdate) return { update: false, reason: "up-to-date" };
  // Only npm-global can be safely reinstalled unattended; a repo-clone would need a
  // git pull + rebuild we won't run behind the user's back.
  if (input.method !== "npm-global") return { update: false, reason: `method:${input.method}` };
  if (input.lastAttemptAt) {
    const last = Date.parse(input.lastAttemptAt);
    if (Number.isFinite(last) && input.nowMs - last < input.intervalMs) {
      return { update: false, reason: "throttled" };
    }
  }
  return { update: true, reason: "applying" };
}

// Commands that must NOT trigger a background update check: the self-update
// commands (which run the check themselves), the fast health probe, and the
// long-lived / internal daemons where a spawned node child is noise or harmful.
const BACKGROUND_UPDATE_SKIP_COMMANDS = new Set<string>([
  "upgrade", "update", "health", "mcp", "mcp-serve", "serve", "setup", "help",
  "__drain-queue", "contract-bridge",
]);

export type BackgroundCheckDecision = { spawn: boolean; reason: string };

/**
 * Pure decision: on a normal CLI invocation, should we spawn a detached
 * self-update checker? This is what keeps the CLI current for EVERY user — not
 * only hosts that ran `unbrowse setup` and got the SessionStart hook. Throttled
 * by the last-spawn timestamp so a node child is spawned at most once per
 * interval. No I/O — every input is a parameter (unit-testable, no clock/fs).
 */
export function shouldSpawnBackgroundUpdateCheck(input: {
  command: string;
  disabled: boolean;
  lastSpawnAtMs: number | null;
  nowMs: number;
  intervalMs: number;
}): BackgroundCheckDecision {
  if (input.disabled) return { spawn: false, reason: "disabled" };
  if (BACKGROUND_UPDATE_SKIP_COMMANDS.has(input.command)) {
    return { spawn: false, reason: `command:${input.command}` };
  }
  if (
    input.lastSpawnAtMs != null &&
    Number.isFinite(input.lastSpawnAtMs) &&
    input.nowMs - input.lastSpawnAtMs < input.intervalMs
  ) {
    return { spawn: false, reason: "throttled" };
  }
  return { spawn: true, reason: "due" };
}

export type BackgroundCheckResult = { spawned: boolean; reason: string };

/**
 * On a normal command, spawn a FULLY DETACHED self-update checker and return
 * immediately. The child runs `upgrade --hint-only`, which checks npm-latest and
 * (for npm-global installs) applies the update in its own detached background —
 * so the in-flight command is never blocked or slowed. Throttled via
 * update-check.json (`bg_check_spawned_at`); opt out with UNBROWSE_NO_AUTO_UPDATE
 * / CI. Never throws: a failure here must not break the user's command.
 *
 * This mirrors the update-notifier / gh-cli shape: the parent never waits, a
 * separate process owns the check, and the result lands on the NEXT invocation.
 */
export function maybeSpawnBackgroundUpdateCheck(metaUrl: string, command: string): BackgroundCheckResult {
  try {
    const statePath = getUpdateCheckStatePath();
    const state = readJsonFile<UpdateCheckState>(statePath) ?? {};
    const lastSpawn = state.bg_check_spawned_at ? Date.parse(state.bg_check_spawned_at) : Number.NaN;
    const decision = shouldSpawnBackgroundUpdateCheck({
      command,
      disabled: autoUpdateDisabled(),
      lastSpawnAtMs: Number.isFinite(lastSpawn) ? lastSpawn : null,
      nowMs: Date.now(),
      intervalMs: getUpdateIntervalMs(),
    });
    if (!decision.spawn) return { spawned: false, reason: decision.reason };

    // Stamp BEFORE spawning so a crash-looping checker can't re-spawn every
    // invocation (throttle holds even if the child never completes).
    writeJsonFile(statePath, { ...state, bg_check_spawned_at: new Date().toISOString() } satisfies UpdateCheckState);

    const hintBin = getHookScriptPath(metaUrl);
    if (!existsSync(hintBin)) return { spawned: false, reason: "hint-bin-missing" };
    const child = spawn(process.execPath, [hintBin], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    child.unref();
    return { spawned: true, reason: "spawned" };
  } catch (err) {
    return { spawned: false, reason: `error:${(err as Error)?.message ?? "unknown"}` };
  }
}

/** Whether auto-update is opted out (env or CI). */
export function autoUpdateDisabled(): boolean {
  return (
    envOn("UNBROWSE_NO_AUTO_UPDATE") ||
    envOn("UNBROWSE_DISABLE_UPDATE_HINTS") ||
    envOn("CI") ||
    !!process.env.GITHUB_ACTIONS
  );
}

export type AutoUpdateResult = { applied: boolean; reason: string; from?: string; to?: string };

/**
 * Check for an update and, when warranted, spawn a detached `npm i -g unbrowse@<latest>`
 * that survives this process. Never throws, never blocks: a failure to update must not
 * break the command the user actually ran. Throttled via update-check.json.
 */
export async function maybeAutoUpdate(metaUrl: string): Promise<AutoUpdateResult> {
  try {
    const result = await checkForUpdates(metaUrl);
    const statePath = getUpdateCheckStatePath();
    const state = readJsonFile<UpdateCheckState>(statePath) ?? {};
    const decision = shouldAutoUpdate({
      hasUpdate: result.has_update,
      method: result.install.method,
      disabled: autoUpdateDisabled(),
      lastAttemptAt: state.auto_update_attempted_at,
      nowMs: Date.now(),
      intervalMs: getUpdateIntervalMs(),
    });
    if (!decision.update) return { applied: false, reason: decision.reason };
    if (!result.latest) return { applied: false, reason: "no-latest" };

    // Record the attempt BEFORE spawning so a crash-looping install can't retry every
    // invocation (throttle holds even if the spawn never completes).
    writeJsonFile(statePath, {
      ...state,
      auto_update_attempted_at: new Date().toISOString(),
      auto_update_target: result.latest,
    } satisfies UpdateCheckState);

    const logFile = path.join(ensureDir(getConfigDir()), "auto-update.log");
    const child = spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "-g", `unbrowse@${result.latest}`],
      { detached: true, stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
    );
    // best-effort breadcrumb; never await the child
    try { writeFileSync(logFile, `${new Date().toISOString()} auto-update ${result.installed} -> ${result.latest} (pid ${child.pid ?? "?"})\n`, { flag: "a" }); } catch { /* ignore */ }
    child.unref();
    return { applied: true, reason: "spawned", from: result.installed, to: result.latest };
  } catch (err) {
    return { applied: false, reason: `error:${(err as Error)?.message ?? "unknown"}` };
  }
}

function commandIncludesHook(command: string | undefined, marker: string): boolean {
  return typeof command === "string" && command.includes(marker);
}

function getCodexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME || path.join(getHomeDir(), ".codex");
  return path.join(codexHome, "config.toml");
}

function getClaudeSettingsPath(): string {
  return path.join(getHomeDir(), ".claude", "settings.json");
}

function getHookScriptPath(metaUrl: string): string {
  return path.join(getPackageRoot(metaUrl), "bin", "unbrowse-update-hint.mjs");
}

function ensureCodexHooksFeature(content: string): string {
  if (/\bcodex_hooks\s*=\s*true\b/.test(content)) return content;
  if (/\[features\]/.test(content)) {
    return content.replace(/\[features\]\r?\n/, (match) => `${match}codex_hooks = true\n`);
  }
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  return `${content}${prefix}[features]\ncodex_hooks = true\n`;
}

function repairManagedCodexHookTable(content: string): string {
  const marker = CODEX_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(new RegExp(`(${marker}\\r?\\n)\\[\\[?hooks\\]?\\]?(?=\\r?\\n)`, "g"), "$1[hooks]");
}

function writeCodexHook(metaUrl: string): UpdateHookStatus {
  const configPath = getCodexConfigPath();
  if (!existsSync(path.dirname(configPath))) {
    return { host: "codex", action: "not-detected", config_file: configPath };
  }

  try {
    const hookScript = getHookScriptPath(metaUrl).replace(/\\/g, "/");
    const fileExistsBefore = existsSync(configPath);
    let content = fileExistsBefore ? readFileSync(configPath, "utf8") : "";
    const previous = content;
    content = ensureCodexHooksFeature(content);
    content = repairManagedCodexHookTable(content);

    if (!content.includes("unbrowse-update-hint.mjs")) {
      const command = `node "${hookScript}"`;
      const prefix = content && !content.endsWith("\n") ? "\n" : "";
      content += `${prefix}${CODEX_MARKER}\n[hooks]\nevent = "SessionStart"\ncommand = ${JSON.stringify(command)}\n`;
    }

    if (content !== previous) {
      writeFileSync(configPath, content, "utf8");
      return {
        host: "codex",
        action: fileExistsBefore ? "updated" : "installed",
        config_file: configPath,
      };
    }

    return { host: "codex", action: "already-installed", config_file: configPath };
  } catch (error) {
    return {
      host: "codex",
      action: "failed",
      config_file: configPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

type ClaudeSettings = {
  hooks?: {
    SessionStart?: Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
    }>;
  };
};

function writeClaudeHook(metaUrl: string): UpdateHookStatus {
  const settingsPath = getClaudeSettingsPath();
  if (!existsSync(path.dirname(settingsPath))) {
    return { host: "claude", action: "not-detected", config_file: settingsPath };
  }

  try {
    const hookScript = getHookScriptPath(metaUrl).replace(/\\/g, "/");
    const command = `node "${hookScript}"`;
    const fileExistsBefore = existsSync(settingsPath);
    const settings = readJsonFile<ClaudeSettings>(settingsPath) ?? {};
    settings.hooks ??= {};
    settings.hooks.SessionStart ??= [];

    const existing = settings.hooks.SessionStart.some((entry) =>
      Array.isArray(entry.hooks) && entry.hooks.some((hook) => commandIncludesHook(hook.command, "unbrowse-update-hint.mjs"))
    );

    if (!existing) {
      settings.hooks.SessionStart.push({
        hooks: [{ type: "command", command }],
      });
      writeJsonFile(settingsPath, settings);
      return {
        host: "claude",
        action: fileExistsBefore ? "updated" : "installed",
        config_file: settingsPath,
      };
    }

    return { host: "claude", action: "already-installed", config_file: settingsPath };
  } catch (error) {
    return {
      host: "claude",
      action: "failed",
      config_file: settingsPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function configureUpdateHintHooks(metaUrl: string, install?: InstallSourceState): UpdateHookStatus[] {
  if (process.env.UNBROWSE_DISABLE_UPDATE_HINTS === "1") return [];
  const source = install ?? loadInstallSource(metaUrl);
  const configuredHosts =
    source.host === "codex" || source.host === "claude"
      ? [source.host]
      : ["codex", "claude"];

  return configuredHosts.map((host) => (host === "codex" ? writeCodexHook(metaUrl) : writeClaudeHook(metaUrl)));
}
