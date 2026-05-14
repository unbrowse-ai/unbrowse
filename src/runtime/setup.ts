import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir } from "./paths.js";
import { findKuriBinary, getKuriSourceCandidates } from "../kuri/client.js";
import { detectHostEnvironment, type HostEnvironment } from "./browser-host.js";
import { log } from "../logger.js";
import { checkWalletConfigured, type WalletCheckResult } from "../payments/wallet.js";
import { configureUpdateHintHooks, saveInstallSource, type UpdateHookStatus } from "./update-hints.js";

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
  update_hints: UpdateHookStatus[];
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
  const installSource = saveInstallSource(import.meta.url);

  const hostEnv = detectHostEnvironment();
  log("setup", `detected host environment: ${hostEnv}`);

  const browser = options?.installBrowser === false
    ? { installed: false, action: "skipped" as const }
    : await ensureBrowserEngineInstalled();
  const walletCheck = checkWalletConfigured();
  const skipWalletSetup = process.env.UNBROWSE_SKIP_WALLET_SETUP === "1";
  let lobsterInstalled = hasBinary("lobstercash") ||
    existsSync(path.join(os.homedir(), ".agents", "skills", "lobstercash", "SKILL.md"));

  // Auto-install + setup Crossmint lobster.cash wallet.
  // Wallet is required for the agent economy — agents earn USDC when their
  // indexed routes are used by others, and spend credits/USDC on paid routes.
  if (!skipWalletSetup && !walletCheck.configured) {
    if (!lobsterInstalled) {
      console.log("[unbrowse] Setting up Crossmint wallet (required for earning + payments)...");
      try {
        execFileSync("npx", ["@crossmint/lobster-cli", "setup"], {
          stdio: "inherit",
          timeout: 120_000,
        });
        lobsterInstalled = true;
      } catch {
        console.warn("[unbrowse] Crossmint wallet setup failed — you can retry with: npx @crossmint/lobster-cli setup");
        console.warn("[unbrowse] Continuing with the platform sponsor pool ($1/day per agent, $50/day across the platform). Pair a wallet via `lobstercash` to keep going past the daily cap and earn USDC when your routes are reused.");
      }
    } else {
      console.log("[unbrowse] Crossmint lobster.cash detected but wallet not configured — running wallet setup...");
      try {
        execFileSync("npx", ["@crossmint/lobster-cli", "setup"], {
          stdio: "inherit",
          timeout: 60_000,
        });
      } catch {
        console.warn("[unbrowse] Crossmint wallet setup failed or was skipped — continuing without wallet");
      }
    }
    // Re-check after setup
    const recheck = checkWalletConfigured();
    if (recheck.configured) {
      console.log(`[unbrowse] wallet configured (${recheck.provider})`);
    }
  }

  // Re-check wallet state after potential setup
  const finalWalletCheck = checkWalletConfigured();
  const wallet = {
    ...finalWalletCheck,
    lobster_installed: lobsterInstalled,
    message: finalWalletCheck.configured
      ? `Wallet configured (${finalWalletCheck.provider}). This address is the contributor truth: it is synced onto your agent profile, used for contributor payouts when your routes earn, and used for paid-route spending.`
      : lobsterInstalled
        ? "Crossmint lobster.cash is installed but not paired. Pair it now so this wallet address becomes your contributor payout target and your paid-route spending wallet. Run: npx @crossmint/lobster-cli setup"
        : "No wallet configured. Recommended for new installs: set up Crossmint lobster.cash so contributor payouts have a destination address and paid-route spending can clear automatically. Without it you stay in free indexing mode only.",
    install_hint: finalWalletCheck.configured
      ? undefined
      : lobsterInstalled
        ? "npx @crossmint/lobster-cli setup"
        : "npx @crossmint/lobster-cli setup",
  };

  // P0.2 / Day-4 Flex onboarding chain: fund escrow + register session key.
  // The stubs currently throw "not yet implemented (Day 4)" — Worker 1 is
  // wiring the real SDK calls (`Unbrowse.local().fundEscrow(...)` and
  // `Unbrowse.local().registerSessionKey(...)`) in parallel. Wrap in try/catch
  // so an unimplemented stub doesn't break the rest of setup; the soft-block
  // middleware on the backend handles agents who didn't finish onboarding.
  //
  // TODO(Day-5): when packages/sdk exports `fundEscrow` + `registerSessionKey`,
  // replace the stub bodies in promptFundEscrow / promptRegisterSessionKey with:
  //   const ub = await Unbrowse.local();
  //   const { escrowAddress } = await ub.fundEscrow({ amountUsdc, cluster });
  //   ...
  //   const { sessionKeyAddress } = await ub.registerSessionKey({ escrow });
  // and remove this try/catch — once the SDK is real, failure should be loud.
  const setupCtx: SetupContext = {
    cwd,
    walletConfigured: finalWalletCheck.configured,
  };
  let flexEscrow: { escrowAddress?: string; skipped: boolean } = { skipped: true };
  let flexSessionKey: { sessionKeyAddress?: string; skipped: boolean } = { skipped: true };
  try {
    flexEscrow = await promptFundEscrow(setupCtx);
  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.includes("not yet implemented")) {
      console.warn(`[unbrowse] Flex escrow setup failed: ${msg}`);
    }
  }
  try {
    flexSessionKey = await promptRegisterSessionKey(setupCtx);
  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.includes("not yet implemented")) {
      console.warn(`[unbrowse] Flex session key registration failed: ${msg}`);
    }
  }
  // flexEscrow / flexSessionKey results are not yet plumbed into SetupReport;
  // Day-5 will add `flex_escrow` and `flex_session_key` fields.
  void flexEscrow;
  void flexSessionKey;

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
    update_hints: configureUpdateHintHooks(import.meta.url, installSource),
    wallet,
  };
}

/**
 * v6.16 onboarding context, minimal shape — Day-3 mustard seed. Day-4 will
 * expand this to carry the user's wallet handle, the cluster RPC URL, and
 * the facilitator address used during onboarding.
 */
export type SetupContext = {
  cwd: string;
  walletConfigured: boolean;
};

/**
 * Prompt the user to fund a Flex escrow during onboarding. Day-3 stub.
 * Day-4: dispatches to `packages/sdk/src/flex.ts::fundEscrow`, prints the
 * resulting escrow PDA, and saves it to the local config.
 */
export async function promptFundEscrow(
  _ctx: SetupContext,
): Promise<{ escrowAddress?: string; skipped: boolean }> {
  throw new Error("not yet implemented (Day 4) — Flex escrow funding step");
}

/**
 * Prompt the user to register a session key against their funded escrow.
 * Day-3 stub. Day-4: generates a session keypair, calls
 * `packages/sdk/src/flex.ts::registerSessionKey`, persists the session-key
 * secret to the keychain, and prints the registered address.
 */
export async function promptRegisterSessionKey(
  _ctx: SetupContext,
): Promise<{ sessionKeyAddress?: string; skipped: boolean }> {
  throw new Error("not yet implemented (Day 4) — Flex session key registration step");
}
