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
  // Ensure a local self-custody identity wallet exists in ~/.unbrowse before
  // anything else. This is the agent's stable identity (and x402 signing key) —
  // minted once, reused forever. Distinct from the lobster.cash PAYOUT wallet
  // below: the user always gets a local wallet even if they never pair lobster.
  // Gated by the same flag tests use to assert a pristine "no wallet" machine.
  if (process.env.UNBROWSE_DISABLE_LOCAL_WALLET !== "1") {
    try {
      const { ensureLocalWalletAddress } = await import("../values/signer.js");
      const localAddr = ensureLocalWalletAddress();
      log("setup", `local identity wallet ready in ~/.unbrowse: ${localAddr}`);
    } catch (err) {
      log("setup", `local identity wallet ensure skipped: ${(err as Error).message}`);
    }
  }

  const walletCheck = checkWalletConfigured();
  const skipWalletSetup = process.env.UNBROWSE_SKIP_WALLET_SETUP === "1";
  let lobsterInstalled = hasBinary("lobstercash") ||
    existsSync(path.join(os.homedir(), ".agents", "skills", "lobstercash", "SKILL.md"));

  // Auto-install + setup Crossmint lobster.cash wallet.
  // Wallet is required for the agent economy — agents earn USDC when their
  // indexed routes are used by others, and spend credits/USDC on paid routes.
  //
  // Trust gradient: the user typed `unbrowse setup`, not "install Crossmint",
  // so print a clear preamble that names the next process by hand and explains
  // why before we hand stdio to a stranger's CLI. Default action is continue
  // (Enter), but TTY users get [s]kip as a back-out. Non-interactive (no TTY)
  // proceeds without prompting so CI flows aren't blocked.
  if (!skipWalletSetup && !walletCheck.configured) {
    const isInteractive = !!process.stdin.isTTY && !!process.stdout.isTTY &&
      process.env.UNBROWSE_NON_INTERACTIVE !== "1";
    let userOptedToSkip = false;
    if (isInteractive) {
      console.log("");
      console.log("[unbrowse] Next step: pair a Crossmint lobster.cash wallet (USDC payouts)");
      console.log("  Why: when other agents reuse routes your install captured, the");
      console.log("       payment settles in USDC on Solana to the wallet you pair here.");
      console.log("       Without it, you stay on the platform sponsor pool ($1/day/agent,");
      console.log("       $50/day/platform) and don't earn from your captures.");
      console.log("  What runs next: `npx @crossmint/lobster-cli setup` (a separate CLI");
      console.log("       owned by Crossmint; you can audit it at https://crossmint.com).");
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const ans = await new Promise<string>((resolve) => {
          rl.question("  [Enter] continue  /  [s] skip wallet pairing for now: ", resolve);
        });
        if (ans.trim().toLowerCase().startsWith("s")) userOptedToSkip = true;
      } finally {
        rl.close();
      }
    }

    if (userOptedToSkip) {
      console.log("[unbrowse] Wallet pairing skipped. Run `unbrowse wallet` anytime to pair.");
      // Mark skip so the rest of the function reports honestly and any later
      // re-prompts honor the choice for this run.
      process.env.UNBROWSE_SKIP_WALLET_SETUP = "1";
    } else if (!lobsterInstalled) {
      console.log("[unbrowse] Setting up Crossmint wallet (optional, for earning + payments)...");
      // Capture lobster-cli output instead of inheriting: its "Error: No active
      // agent" message + Node punycode DeprecationWarning alarm first-time users
      // even when we gracefully fall through to the sponsor pool. Surface the
      // raw stderr only when UNBROWSE_DEBUG_SETUP=1 is set for debugging.
      const debugSetup = process.env.UNBROWSE_DEBUG_SETUP === "1";
      try {
        execFileSync("npx", ["@crossmint/lobster-cli", "setup"], {
          stdio: debugSetup ? "inherit" : ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        });
        lobsterInstalled = true;
      } catch (err) {
        if (debugSetup) {
          console.warn(`[unbrowse] lobster-cli setup raw error: ${(err as Error).message}`);
        }
        console.warn("[unbrowse] No wallet yet — using sponsor pool ($1/day per agent, $50/day platform).");
        console.warn("[unbrowse] Pair a wallet later with: npx @crossmint/lobster-cli setup (or set UNBROWSE_DEBUG_SETUP=1 to debug).");
      }
    } else {
      console.log("[unbrowse] Crossmint lobster.cash detected but wallet not configured — running wallet setup...");
      const debugSetup = process.env.UNBROWSE_DEBUG_SETUP === "1";
      try {
        execFileSync("npx", ["@crossmint/lobster-cli", "setup"], {
          stdio: debugSetup ? "inherit" : ["ignore", "pipe", "pipe"],
          timeout: 60_000,
        });
      } catch (err) {
        if (debugSetup) {
          console.warn(`[unbrowse] lobster-cli pair raw error: ${(err as Error).message}`);
        }
        console.warn("[unbrowse] Wallet setup skipped — continuing. Re-run later: npx @crossmint/lobster-cli setup");
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
  // For v6.16.0-preview.0, these prompts are HONEST-SKIP: they print clear
  // next-steps (visit unbrowse.ai/account/escrow + /account/session-key)
  // and report a `skipped` result with a `reason`. They never throw, so no
  // try/catch silent-swallow path. Enforcement lives in the backend's
  // `flex-onboarding-required` middleware — priced calls return 402 with
  // `X-Flex-Onboarding-Required: 1` until escrow + session key exist.
  const setupCtx: SetupContext = {
    cwd,
    walletConfigured: finalWalletCheck.configured,
  };
  const flexEscrow = await promptFundEscrow(setupCtx);
  const flexSessionKey = await promptRegisterSessionKey(setupCtx);
  // flexEscrow / flexSessionKey results are not yet plumbed into SetupReport;
  // preview.1+ will add `flex_escrow` and `flex_session_key` fields.
  void flexEscrow;
  void flexSessionKey;

  if (flexEscrow.skipped || flexSessionKey.skipped) {
    console.log("");
    console.log("[unbrowse setup] Onboarding partial — see above for next steps.");
    console.log("  Priced calls will receive 402 with X-Flex-Onboarding-Required: 1");
    console.log("  until escrow + session-key are completed via SDK or web flow.");
  }

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
  ctx: SetupContext,
): Promise<{ escrowAddress?: string; skipped: boolean; reason?: string }> {
  if (!ctx.walletConfigured) {
    console.log("[unbrowse setup] Flex escrow funding: skipped (wallet not paired)");
    return { skipped: true, reason: "wallet_not_paired" };
  }
  console.log("");
  console.log("[unbrowse setup] Flex escrow funding (required for paid calls)");
  console.log("  Pre-deposit USDC into a Flex escrow PDA so the platform can");
  console.log("  settle creator payments off-chain in batches.");
  console.log("  Fund it via the web flow:");
  console.log("    open https://unbrowse.ai/account/escrow");
  console.log("  Server-side priced calls will return 402 with");
  console.log("  X-Flex-Onboarding-Required: 1 until this step is done.");
  return { skipped: true, reason: "deferred_to_sdk_or_web" };
}

/**
 * Prompt the user to register a session key against their funded escrow.
 * Day-3 stub. Day-4: generates a session keypair, calls
 * `packages/sdk/src/flex.ts::registerSessionKey`, persists the session-key
 * secret to the keychain, and prints the registered address.
 */
export async function promptRegisterSessionKey(
  ctx: SetupContext,
): Promise<{ sessionKeyAddress?: string; skipped: boolean; reason?: string }> {
  if (!ctx.walletConfigured) {
    return { skipped: true, reason: "wallet_not_paired" };
  }
  console.log("");
  console.log("[unbrowse setup] Flex session key registration");
  console.log("  Register an Ed25519 session key against your escrow so the");
  console.log("  SDK can sign payment authorizations off-chain.");
  console.log("  Register it via the web flow:");
  console.log("    open https://unbrowse.ai/account/session-key");
  return { skipped: true, reason: "deferred_to_sdk_or_web" };
}
