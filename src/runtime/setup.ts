import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir } from "./paths.js";
import { findKuriBinary, getKuriSourceCandidates } from "../kuri/client.js";
import { detectHostEnvironment, type HostEnvironment } from "./browser-host.js";
import { log } from "../logger.js";
import { checkWalletConfigured, type WalletCheckResult } from "../payments/wallet.js";

export type SetupScope = "auto" | "global" | "project" | "off";

export type SetupReport = {
  os: {
    platform: NodeJS.Platform;
    release: string;
    arch: string;
  };
  host_environment: HostEnvironment;
  package_managers: {
    npm: boolean;
    npx: boolean;
    bun: boolean;
    brew: boolean;
  };
  browser_engine: {
    installed: boolean;
    action: "already-installed" | "installed" | "failed" | "skipped";
    message?: string;
  };
  opencode: {
    detected: boolean;
    action: "installed" | "updated" | "skipped" | "not-detected";
    scope: "global" | "project" | "off";
  };
  wallet: WalletCheckResult & {
    message: string;
  };
};

function hasBinary(name: string): boolean {
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(checker, [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detectPackageManagers(): SetupReport["package_managers"] {
  return {
    npm: hasBinary("npm"),
    npx: hasBinary("npx"),
    bun: hasBinary("bun"),
    brew: hasBinary("brew"),
  };
}

function resolveConfigHome(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function getOpenCodeGlobalCommandsDir(): string {
  return path.join(resolveConfigHome(), "opencode", "commands");
}

function getOpenCodeProjectCommandsDir(cwd: string): string {
  return path.join(cwd, ".opencode", "commands");
}

function detectOpenCode(cwd: string): boolean {
  return hasBinary("opencode") ||
    existsSync(path.join(resolveConfigHome(), "opencode")) ||
    existsSync(path.join(cwd, ".opencode"));
}

function renderOpenCodeCommand(): string {
  return `---
description: Use Unbrowse as the exclusive web-access tool for a task.
---
Use Unbrowse as the only allowed tool for website access in this task.

Rules:
- Do not use Brave Search, built-in web search, browser MCPs, curl, or other network tools for website access unless the user explicitly authorizes fallback.
- If Unbrowse is slow on a first-time site, wait for it. Do not switch tools just because capture or indexing is still running.
- If Unbrowse returns partial results, refine with more Unbrowse commands (\`resolve\`, \`search\`, \`execute\`, \`login\`) before considering fallback.
- If Unbrowse genuinely cannot complete the task, explain why and ask before using another tool.

Suggested start:
\`\`\`bash
npx unbrowse resolve --intent "$ARGUMENTS" --url "<target-url>" --pretty
\`\`\`
`;
}

function writeOpenCodeCommand(scope: SetupScope, cwd: string): SetupReport["opencode"] {
  if (scope === "off") {
    return { detected: detectOpenCode(cwd), action: "skipped", scope: "off" };
  }

  const detected = detectOpenCode(cwd);
  if (scope === "auto" && !detected) {
    return { detected: false, action: "not-detected", scope: "off" };
  }

  const resolvedScope: "global" | "project" =
    scope === "project" ? "project" : scope === "global"
      ? "global"
      : existsSync(path.join(cwd, ".opencode"))
        ? "project"
        : "global";

  const commandsDir = resolvedScope === "project"
    ? getOpenCodeProjectCommandsDir(cwd)
    : getOpenCodeGlobalCommandsDir();
  const commandFile = path.join(ensureDir(commandsDir), "unbrowse.md");
  const content = renderOpenCodeCommand();
  const action = existsSync(commandFile) ? "updated" : "installed";
  mkdirSync(path.dirname(commandFile), { recursive: true });
  writeFileSync(commandFile, content);

  return {
    detected: detected || scope !== "auto",
    action,
    scope: resolvedScope,
    command_file: commandFile,
  };
}

export async function ensureBrowserEngineInstalled(): Promise<SetupReport["browser_engine"]> {
  const binary = findKuriBinary();
  if (existsSync(binary)) {
    return { installed: true, action: "already-installed" };
  }

  const sourceDir = getKuriSourceCandidates().find((candidate) => existsSync(path.join(candidate, "build.zig")));
  if (!sourceDir) {
    return {
      installed: false,
      action: "failed",
      message: `Kuri binary not found. Checked ${binary}`,
    };
  }

  if (!hasBinary("zig")) {
    return {
      installed: false,
      action: "failed",
      message: `Kuri source found at ${sourceDir}, but Zig is not installed`,
    };
  }

  try {
    execFileSync("zig", ["build", "-Doptimize=ReleaseFast"], {
      cwd: sourceDir,
      stdio: "inherit",
      timeout: 300_000,
    });
    const builtBinary = findKuriBinary();
    if (existsSync(builtBinary)) {
      return {
        installed: true,
        action: "installed",
        message: `Built Kuri from ${sourceDir}`,
      };
    }
    return {
      installed: false,
      action: "failed",
      message: `Kuri build completed but ${builtBinary} was not created`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { installed: false, action: "failed", message };
  }
}

export async function runSetup(options?: {
  cwd?: string;
  opencode?: SetupScope;
  installBrowser?: boolean;
}): Promise<SetupReport> {
  const cwd = options?.cwd || process.cwd();

  const hostEnv = detectHostEnvironment();
  log("setup", `detected host environment: ${hostEnv}`);

  const browser = options?.installBrowser === false
    ? { installed: false, action: "skipped" as const }
    : await ensureBrowserEngineInstalled();
  const walletCheck = checkWalletConfigured();
  const skipWalletSetup = process.env.UNBROWSE_SKIP_WALLET_SETUP === "1";
  const lobsterInstalled = hasBinary("lobstercash") ||
    existsSync(path.join(os.homedir(), ".agents", "skills", "lobstercash", "SKILL.md"));

  // Auto-setup lobster.cash wallet if skill is installed but wallet not configured
  if (!skipWalletSetup && !walletCheck.configured && lobsterInstalled) {
    console.log("[unbrowse] lobster.cash skill detected but wallet not configured — running wallet setup...");
    try {
      execFileSync("npx", ["@crossmint/lobster-cli", "setup"], {
        stdio: "inherit",
        timeout: 60_000,
      });
      // Re-check after setup
      const recheck = checkWalletConfigured();
      if (recheck.configured) {
        console.log(`[unbrowse] wallet configured (${recheck.provider})`);
      }
    } catch {
      console.warn("[unbrowse] lobster.cash wallet setup failed or was skipped — continuing without wallet");
    }
  }

  // Re-check wallet state after potential setup
  const finalWalletCheck = checkWalletConfigured();
  const wallet = {
    ...finalWalletCheck,
    lobster_installed: lobsterInstalled,
    message: finalWalletCheck.configured
      ? `Wallet configured (${finalWalletCheck.provider})`
      : lobsterInstalled
        ? "lobster.cash installed but wallet not paired. Run: lobstercash setup"
        : "No wallet configured. Install lobster.cash for paid marketplace skills, or use indexing mode for free.",
    install_hint: finalWalletCheck.configured
      ? undefined
      : lobsterInstalled
        ? "lobstercash setup"
        : "npx skills add https://github.com/Crossmint/lobstercash-cli-skills --global --yes",
  };

  return {
    os: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
    },
    host_environment: hostEnv,
    package_managers: detectPackageManagers(),
    browser_engine: browser,
    opencode: writeOpenCodeCommand(options?.opencode ?? "auto", cwd),
    wallet,
  };
}
