/**
 * Unbrowse — Reverse-engineer internal APIs from any website.
 *
 * Captures the hidden API traffic that powers web apps — the undocumented
 * endpoints websites use internally but never publish. Log into any site,
 * use it normally, and unbrowse extracts the internal API structure,
 * authentication tokens, and session cookies. These become reusable skills
 * that let agents interact with sites programmatically without official API access.
 *
 * Tools:
 *   unbrowse_capture   — Visit URLs → captures internal API traffic → extracts auth tokens
 *   unbrowse_replay    — Call internal APIs with captured auth (auto-refresh on 401)
 *   unbrowse_login     — Login to capture session cookies/tokens for authenticated sites
 *   unbrowse_learn     — Parse HAR file → generate internal API skill
 *   unbrowse_skills    — List captured internal API skills and their endpoints
 *   unbrowse_auth      — Extract auth from running browser (session cookies, tokens)
 *   unbrowse_publish   — Share internal API skill to marketplace
 *   unbrowse_search    — Find internal API skills others have captured
 *   unbrowse_wallet    — Manage wallet for marketplace transactions
 *
 * Hooks:
 *   after_tool_call    — Auto-captures internal APIs when browsing
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { parseHar } from "../har-parser.js";
import { generateSkill } from "../skill-generator.js";
import { fetchBrowserCookies, fetchCapturedRequests, startCdpHeaderListener, stopCdpHeaderListener } from "../cdp-capture.js";
import { AutoDiscovery } from "../auto-discover.js";
import { SkillIndexClient, type PublishPayload } from "../skill-index.js";
import { sanitizeApiTemplate, extractEndpoints, extractPublishableAuth } from "../skill-sanitizer.js";
import { writeMarketplaceMeta, writeSkillPackageToDir } from "../skill-package-writer.js";
import { loginAndCapture, type LoginCredentials } from "../session-login.js";
import {
  createCredentialProvider,
  lookupCredentials,
  buildFormFields,
  type CredentialProvider,
  type LoginCredential,
} from "../credential-providers.js";
import {
  TokenRefreshScheduler,
  extractRefreshConfig,
  type RefreshConfig,
} from "../token-refresh.js";
import { TaskWatcher, type TaskIntent, type FailureInfo } from "../task-watcher.js";
import { CapabilityResolver, type Resolution } from "../capability-resolver.js";
import { loadWallet, migrateToKeychain, saveWallet } from "../wallet/keychain-wallet.js";
import type { WalletState } from "../wallet/wallet-tool.js";
import { DesktopAutomation } from "../desktop-automation.js";
import { createTools } from "./tools.js";
import { createBrowserSessionManager } from "./browser-session-manager.js";
import { hasApiIntent } from "./context-hints.js";
import { createTelemetryClient, loadTelemetryConfig, hashDomain } from "../telemetry-client.js";
import { getEnv } from "../runtime-env.js";
import { loadJsonOr, loadText } from "../disk-io.js";

/** Scan HAR entries for refresh token endpoints and save config to auth.json */
function detectAndSaveRefreshConfig(
  harEntries: Array<{
    request: { method: string; url: string; headers: Array<{ name: string; value: string }>; postData?: { text?: string } };
    response: { status: number; content?: { text?: string } };
  }>,
  authPath: string,
  logger: { info: (msg: string) => void },
): void {
  for (const entry of harEntries) {
    const refreshConfig = extractRefreshConfig(entry);
    if (refreshConfig) {
      // Found a refresh endpoint — save to auth.json
      try {
        let auth: Record<string, any> = {};
        if (existsSync(authPath)) {
          auth = loadJsonOr<Record<string, any>>(authPath, {});
        }
        auth.refreshConfig = refreshConfig;
        writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf-8");
        logger.info(`[unbrowse] Detected refresh endpoint: ${refreshConfig.url}`);
        break; // Only need one
      } catch { /* skip */ }
    }
  }
}

function parsePositiveInt(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function resolveGatewayPort(config: any): number {
  const envPort =
    parsePositiveInt(getEnv("OPENCLAW_GATEWAY_PORT")) ??
    parsePositiveInt(getEnv("CLAWDBOT_GATEWAY_PORT"));
  if (envPort) return envPort;
  const cfgPort = parsePositiveInt(config?.gateway?.port);
  if (cfgPort) return cfgPort;
  return 18789;
}

function deriveBrowserControlPort(gatewayPort: number): number {
  // OpenClaw control port family: gateway + 2 (docs + upstream defaults).
  return gatewayPort + 2;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

const plugin = {
  id: "unbrowse-openclaw",
  name: "Unbrowse",
  description:
    "Self-learning skill generator. Primarily reverse-engineers APIs by browsing websites and " +
    "capturing network traffic — no manual steps, no extension, no Chrome needed. Also supports " +
    "broader skills: library integrations, workflows, and reusable agent knowledge. " +
    "Generates complete skill packages (SKILL.md, auth.json, TypeScript client) and publishes " +
    "to a cloud marketplace where agents can discover, buy, and sell skills with USDC.",

  register(api: OpenClawPluginApi) {
    const cfg = api.pluginConfig ?? {};
    const logger = api.logger;
    const rootConfig = (api as any).config ?? {};
    const gatewayPort = resolveGatewayPort(rootConfig);
    const derivedBrowserPort = deriveBrowserControlPort(gatewayPort);
    const browserPort = parsePositiveInt(cfg.browserPort) ?? derivedBrowserPort;
    const browserProfile = String(
      (cfg.browserProfile as string) ??
      ((rootConfig as any)?.browser?.defaultProfile as string) ??
      "",
    ).trim() || undefined;
    const allowLegacyPlaywrightFallback = (cfg.allowLegacyPlaywrightFallback as boolean) ?? false;

    // Detect diagnostic mode (doctor, audit, help, version) — skip all background tasks
    const isDiagnosticMode = (() => {
      const args = process.argv.join(" ").toLowerCase();
      const argMatch = args.includes("doctor") || args.includes("audit") || args.includes("--help") || args.includes("--version");
      if (argMatch) return true;
      // OpenClaw renames the process (e.g. "openclaw-doctor"), so also check process.title
      const title = (process.title || "").toLowerCase();
      return title.includes("doctor") || title.includes("audit");
    })();

    const defaultOutputDir = (cfg.skillsOutputDir as string) ?? join(homedir(), ".openclaw", "skills");
    const autoDiscoverEnabled = (cfg.autoDiscover as boolean) ?? true;
    const autoContributeEnabled = (cfg.autoContribute as boolean) ?? true;
    const enableAgentContextHints = (cfg.enableAgentContextHints as boolean) ?? false;
    const publishValidationWithAuth = (cfg.publishValidationWithAuth as boolean) ?? false;
    const skillIndexUrl = (cfg.skillIndexUrl as string) ?? getEnv("UNBROWSE_INDEX_URL") ?? "https://index.unbrowse.ai";

    const telemetryCfg = loadTelemetryConfig({ pluginConfig: cfg });
    const pluginVersion = (() => {
      try {
        const pkgUrl = new URL("../../package.json", import.meta.url);
        const pkg = loadJsonOr<Record<string, any>>(fileURLToPath(pkgUrl), {});
        return String(pkg?.version ?? "dev");
      } catch {
        return "dev";
      }
    })();
    const telemetry = createTelemetryClient({
      indexUrl: skillIndexUrl,
      pluginConfig: cfg,
      pluginVersion,
      platform: process.platform,
      logger: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
    });

    // ── Wallet persistence ──────────────────────────────────────────────
    // Private key stored in OS keychain by default (file fallback only when explicitly enabled).
    // Public address remains in ~/.openclaw/unbrowse/wallet.json.
    const migrated = migrateToKeychain();
    if (migrated) {
      logger.info("[unbrowse] Migrated Solana private key from wallet.json to OS Keychain.");
    }

    const savedWallet = loadWallet();
    let creatorWallet = savedWallet.creatorWallet ?? (cfg.creatorWallet as string) ?? getEnv("UNBROWSE_CREATOR_WALLET");
    let solanaPrivateKey = savedWallet.solanaPrivateKey;
    if (!solanaPrivateKey) {
      const bootstrappedPrivateKey = (cfg.skillIndexSolanaPrivateKey as string) ?? getEnv("UNBROWSE_SOLANA_PRIVATE_KEY");
      if (bootstrappedPrivateKey) {
        try {
          saveWallet({ creatorWallet, solanaPrivateKey: bootstrappedPrivateKey });
          solanaPrivateKey = bootstrappedPrivateKey;
          logger.warn(
            "[unbrowse] Imported payer private key from config/env into wallet storage. " +
            "Remove skillIndexSolanaPrivateKey/UNBROWSE_SOLANA_PRIVATE_KEY to avoid ambiguity.",
          );
        } catch (err) {
          logger.warn(
            `[unbrowse] Could not import payer key from config/env into wallet storage: ${(err as Error).message}`,
          );
        }
      }
    }
    // Keep a single mutable wallet reference for tool handlers to update,
    // while preserving the legacy `creatorWallet`/`solanaPrivateKey` locals.
    const walletState = ({
      get creatorWallet() { return creatorWallet; },
      set creatorWallet(v: string | undefined) { creatorWallet = v; },
      get solanaPrivateKey() { return solanaPrivateKey; },
      set solanaPrivateKey(v: string | undefined) { solanaPrivateKey = v; },
    } as unknown) as WalletState;
    const credentialSourceCfg = (cfg.credentialSource as string) ?? getEnv("UNBROWSE_CREDENTIAL_SOURCE") ?? "none";
    const vaultDbPath = join(homedir(), ".openclaw", "unbrowse", "vault.db");
    const credentialProvider = createCredentialProvider(credentialSourceCfg, vaultDbPath);

    // ── Security: Opt-in sensitive features (all disabled by default) ────
    const enableChromeCookies = (cfg.enableChromeCookies as boolean) ?? false;
    const enableDesktopAutomation = (cfg.enableDesktopAutomation as boolean) ?? false;
    
    if (enableChromeCookies) {
      logger.info("[unbrowse] Chrome cookie reading ENABLED (opt-in)");
    }
    if (enableDesktopAutomation) {
      logger.info("[unbrowse] Desktop automation ENABLED (opt-in)");
    }
    if (enableAgentContextHints) {
      logger.info("[unbrowse] Agent context hints ENABLED (opt-in)");
    }
    if (publishValidationWithAuth) {
      logger.info("[unbrowse] Publish-time auth validation ENABLED (opt-in)");
    }
    if (!autoContributeEnabled) {
      logger.info("[unbrowse] Auto-contribute DISABLED — skills will stay local only. Set autoContribute: true to earn revenue from contributions.");
    }
    logger.info(
      `[unbrowse] Browser integration: OpenClaw control on :${browserPort}` +
      `${browserProfile ? ` (profile=${browserProfile})` : ""}` +
      `${allowLegacyPlaywrightFallback ? ", Playwright fallback=enabled" : ", Playwright fallback=disabled"}`,
    );

    // ── Long-Lived Managers ───────────────────────────────────────────────
    const sessionManager = createBrowserSessionManager({ logger, browserPort });
    const {
      browserSessions,
      getOrCreateBrowserSession,
      getSharedBrowser,
      closeChrome,
      cleanupAllSessions,
    } = sessionManager;

    // ── Skill Index Client ─────────────────────────────────────────────────
    // Use a shared opts object so wallet values stay in sync after auto-generation
    const indexOpts: { indexUrl: string; creatorWallet?: string; solanaPrivateKey?: string } = {
      indexUrl: skillIndexUrl,
      creatorWallet,
      solanaPrivateKey,
    };
    const indexClient = new SkillIndexClient(indexOpts);

    // NOTE: Wallet is no longer auto-generated on startup.
    // User must explicitly set up wallet via unbrowse_wallet tool.

    // ── Auto-Publish Helper ────────────────────────────────────────────────
    // Track server reachability to avoid repeated failed publish attempts
    let serverReachable: boolean | null = null; // null = unknown, needs check
    let lastReachabilityCheck = 0;
    const REACHABILITY_CHECK_INTERVAL = 5 * 60 * 1000; // Re-check every 5 minutes
    const publishBackoff = new Map<string, { untilMs: number; reason: string }>();

    /** Publish a skill to the cloud index if autoContribute is enabled and creatorWallet is configured. */
    async function autoPublishSkill(service: string, skillDir: string): Promise<string | null> {
      if (!autoContributeEnabled) return null;
      // Publishing requires a creator address (earnings) + a private key to sign the request.
      if (!creatorWallet || !solanaPrivateKey) return null;

      // Per-skill backoff: avoid spamming publish when a given skill consistently fails
      // (quality gate, schema errors, upstream 5xx, etc.).
      const now = Date.now();
      const backoff = publishBackoff.get(service);
      if (backoff && now < backoff.untilMs) {
        return null;
      }

      // Check server reachability (with caching to avoid hammering)
      if (serverReachable === null || (serverReachable === false && now - lastReachabilityCheck > REACHABILITY_CHECK_INTERVAL)) {
        lastReachabilityCheck = now;
        serverReachable = await indexClient.healthCheck();
        if (!serverReachable) {
          logger.info(`[unbrowse] Skill marketplace unreachable — auto-publish disabled until server is available.`);
        }
      }

      if (!serverReachable) {
        // Silently skip — already logged once when we detected it was down
        return null;
      }

      try {
        const skillMd = loadText(join(skillDir, "SKILL.md"));
        const endpoints = extractEndpoints(skillMd);

        let baseUrl = "";
        let authMethodType = "Unknown";
        const authJsonPath = join(skillDir, "auth.json");
        if (existsSync(authJsonPath)) {
          const pub = extractPublishableAuth(loadText(authJsonPath));
          baseUrl = pub.baseUrl;
          authMethodType = pub.authMethodType;
        }

        // Collect scripts
        const scripts: Record<string, string> = {};
        const apiTsPath = join(skillDir, "scripts", "api.ts");
        if (existsSync(apiTsPath)) {
          scripts["api.ts"] = sanitizeApiTemplate(loadText(apiTsPath));
        }

        // Collect references (small, publishable artifacts like REFERENCE.md, DAG.json).
        const references: Record<string, string> = {};
        try {
          const refsDir = join(skillDir, "references");
          if (existsSync(refsDir)) {
            const { readdirSync, statSync } = await import("node:fs");
            for (const fn of readdirSync(refsDir)) {
              if (!fn.endsWith(".md") && !fn.endsWith(".json")) continue;
              const p2 = join(refsDir, fn);
              const st = statSync(p2);
              if (!st.isFile()) continue;
              if (st.size > 250_000) continue; // avoid huge payloads
              try {
                references[fn] = loadText(p2);
              } catch { /* ignore per-file */ }
            }
          }
        } catch { /* ignore */ }

        // Extract description from SKILL.md frontmatter
        let description = "";
        const descMatch = skillMd.match(/^description:\s*>-?\s*\n([\s\S]*?)(?=\n\w|---)/m);
        if (descMatch) {
          description = descMatch[1].replace(/\n\s+/g, " ").trim();
        } else {
          // Build a meaningful fallback description
          const endpointNames = endpoints.slice(0, 3).map((e: { method: string; path: string }) => e.path);
          const capText = endpointNames.length > 0 ? ` Endpoints: ${endpointNames.join(", ")}.` : "";
          description = `${service} skill for OpenClaw.${capText}`;
        }

        // Extract domain from baseUrl
        let domain = "";
        if (baseUrl) {
          try {
            domain = new URL(baseUrl).hostname;
          } catch { /* skip */ }
        }

        const result: any = await indexClient.publish({
          name: service,
          description,
          skillMd,
          authType: authMethodType !== "Unknown" ? authMethodType : undefined,
          scripts: Object.keys(scripts).length > 0 ? scripts : undefined,
          references: Object.keys(references).length > 0 ? references : undefined,
          serviceName: service,
          domain: domain || undefined,
          creatorWallet,
          priceUsdc: "0", // Auto-published skills are free by default
        });

        const skillId: string = result?.skill?.skillId ?? result?.skillId;

        // Backend returns canonical skill content for merge/update/create.
        // Always sync it locally (credentials stay local in auth.json).
        if (result?.skill) {
          const wrote = writeSkillPackageToDir(skillDir, result.skill);
          if (wrote) {
            logger.info(
              result?.merged
                ? `[unbrowse] Auto-publish merged: ${service} — local skill updated with canonical version`
                : `[unbrowse] Auto-publish sync: ${service} — local skill updated with canonical version`,
            );
          }
        }
        if (skillId) {
          writeMarketplaceMeta(skillDir, { skillId, indexUrl: indexOpts.indexUrl, name: service });
        }

        logger.info(`[unbrowse] Auto-published: ${service} (${skillId})`);
        return skillId;
      } catch (err) {
        const msg = (err as Error).message ?? "";
        const statusMatch = msg.match(/\((\d{3})\)/);
        const statusCode = statusMatch ? Number(statusMatch[1]) : null;

        // If it's a connection error, mark server as unreachable
        if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("timeout")) {
          serverReachable = false;
          lastReachabilityCheck = now;
          logger.info(`[unbrowse] Skill marketplace unreachable — auto-publish disabled until server is available.`);
        } else {
          // Backoff by failure class.
          const isQualityGate = statusCode === 400 && msg.includes("quality review");
          const isAuthOrBadReq = statusCode === 401 || statusCode === 403;
          const isServerError = statusCode != null && statusCode >= 500;

          const backoffMs =
            isQualityGate ? 24 * 60 * 60 * 1000 :
            isAuthOrBadReq ? 30 * 60 * 1000 :
            isServerError ? 10 * 60 * 1000 :
            5 * 60 * 1000;

          publishBackoff.set(service, {
            untilMs: now + backoffMs,
            reason:
              isQualityGate ? "quality_gate" :
              isAuthOrBadReq ? "auth_or_bad_request" :
              isServerError ? "server_error" :
              "unknown_error",
          });

          const shortMsg = msg.length > 600 ? `${msg.slice(0, 600)}…` : msg;
          logger.warn(`[unbrowse] Auto-publish failed for ${service}: ${shortMsg}`);
        }
        return null;
      }
    }

    // ── Auto-Discovery Engine ─────────────────────────────────────────────
    const discovery = new AutoDiscovery({
      outputDir: defaultOutputDir,
      port: browserPort,
      logger,
      onSkillGenerated: async (service, result) => {
        if (result.changed) {
          const publishCmd = `unbrowse_publish service="${service.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" skillsDir="${defaultOutputDir.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" price="0"`;
          if (!creatorWallet || !solanaPrivateKey) {
            logger.info(
              `[unbrowse] Skill ready to publish: ${service}. ` +
              `Wallet not configured yet; run unbrowse_wallet action="create" first, then ${publishCmd}`,
            );
          } else {
            logger.info(`[unbrowse] Skill ready to publish: ${service}. Publish now: ${publishCmd}`);
          }
        }
      },
    });

    // (Browser session management moved to src/plugin/browser-session-manager.ts)

    // ── Tools ─────────────────────────────────────────────────────────────

    const tools = createTools({
      logger,
      pluginConfig: cfg,
      browserPort,
      browserProfile,
      allowLegacyPlaywrightFallback,
      defaultOutputDir,
      autoDiscoverEnabled,
      enableChromeCookies,
      enableDesktopAutomation,
      publishValidationWithAuth,
      skillIndexUrl,
      indexClient,
      indexOpts,
      walletState,
      creatorWallet,
      solanaPrivateKey,
      vaultDbPath,
      credentialProvider,
      discovery,
      autoPublishSkill,
      detectAndSaveRefreshConfig,
      getOrCreateBrowserSession,
      getSharedBrowser,
      closeChrome: async () => { await closeChrome(); },
      browserSessions,
    });

    const toolNames = [
      "unbrowse_learn",
      "unbrowse_capture",
      "unbrowse_auth",
      "unbrowse_account",
      "unbrowse_telemetry",
      "unbrowse_replay",
      "unbrowse_skills",
      "unbrowse_publish",
      "unbrowse_search",
      "unbrowse_login",
      "unbrowse_wallet",
      "unbrowse_browse",
      "unbrowse_do",
      "unbrowse_desktop",
      "unbrowse_workflow_record",
      "unbrowse_workflow_learn",
      "unbrowse_workflow_execute",
      "unbrowse_workflow_stats",
    ];

    api.registerTool(tools, { names: toolNames });

    // ── Token Refresh Scheduler ─────────────────────────────────────────────
    // Automatically refresh OAuth/JWT tokens before they expire.
    // IMPORTANT: Don't start background tasks on plugin load; many `openclaw` commands
    // load plugins briefly then expect to exit back to the CLI.
    let tokenRefreshScheduler: TokenRefreshScheduler | null = null;
    const ensureTokenRefreshScheduler = () => {
      if (isDiagnosticMode) return;
      if (tokenRefreshScheduler) return;
      tokenRefreshScheduler = new TokenRefreshScheduler(defaultOutputDir, {
        intervalMinutes: 1,
        logger: {
          info: (msg) => logger.info(msg),
          warn: (msg) => logger.warn(msg),
        },
      });
      tokenRefreshScheduler.start();
    };

    // ── Failure Detection + Auto-Discovery Hook ────────────────────────────
    // Detects failures and suggests fixes, plus auto-discovers skills from browse activity
    const failureWatcher = new TaskWatcher();
    const failureResolver = new CapabilityResolver(defaultOutputDir);

    api.on("after_tool_call", async (event: any) => {
      if (isDiagnosticMode) return;

      const toolName = event?.toolName ?? event?.tool ?? "";
      const result = event?.result;
      const error = event?.error;

      // Anonymous telemetry (opt-out): tool outcome timing/error class only.
      try {
        const ok = !error;
        const durationMs = typeof event?.durationMs === "number" ? event.durationMs : undefined;
        const errorName = error?.name ? String(error.name) : undefined;
        telemetry.record("tool_call", {
          tool: String(toolName),
          ok,
          durationMs,
          errorName,
        });

        if (toolName === "unbrowse_browse") {
          const url = event?.params?.url ?? "";
          const domain = (() => { try { return new URL(String(url)).hostname; } catch { return ""; } })();
          telemetry.record("browse", {
            tool: String(toolName),
            ok,
            durationMs,
            // domain hashed, never raw
            domainHash: domain ? hashDomain(domain) : undefined,
          });
        }
      } catch { /* never block */ }

      // Check for failures that unbrowse can help with
      if (error || (result && typeof result === "object")) {
        const failure = failureWatcher.detectFailure(toolName, result, error);

        if (failure && failure.canResolve) {
          logger.info(
            `[unbrowse] Detected ${failure.errorType} failure in ${toolName}: ${failure.suggestedAction}`,
          );

          // Could add auto-remediation here in the future
          // For now, just log — the agent can use unbrowse_do to get suggestions
        }
      }

      // Auto-discovery: trigger on OpenClaw web browsing/automation tool calls.
      if (!autoDiscoverEnabled) return;
      if (typeof toolName !== "string") return;
      if (toolName !== "browse" && toolName !== "browser") return;

      try {
        const generated = await discovery.onBrowserToolCall();
        if (generated.length > 0) {
          logger.info(
            `[unbrowse] Auto-discovered ${generated.length} skill(s): ${generated.join(", ")}`,
          );
        }
      } catch {
        // Silently ignore — auto-discovery is best-effort
      }
    });

    // ── Agent Context Hook — Internal API Reverse Engineering ─────────────
    // Start long-lived helpers at agent start; context hints are separate opt-in.
    api.on("before_agent_start", async (event: unknown) => {
      if (isDiagnosticMode) return {};

      // Start background tasks only in long-lived agent contexts (not for one-shot CLI commands).
      ensureTokenRefreshScheduler();
      startCdpHeaderListener(9222).then((started) => {
        if (started) {
          logger.info("[unbrowse] CDP header listener active (Chrome port 9222)");
        }
      }).catch(() => { /* Chrome remote debugging not available */ });

      if (autoDiscoverEnabled) {
        logger.info("[unbrowse] Auto-discovery hook active");
      }

      if (telemetryCfg.enabled) {
        telemetry.record("agent_start", { hasWallet: Boolean(creatorWallet && solanaPrivateKey) });
      }

      if (!enableAgentContextHints) return {};
      if (!hasApiIntent(event)) return {};

      // Wallet setup is explicit via unbrowse_wallet (no auto-generation here).

      const lines: string[] = [
        "[Internal API Access] Reverse-engineer and call internal APIs from any website.",
        "",
        "Workflow: unbrowse_skills (check existing) → unbrowse_capture (discover) → unbrowse_replay (call).",
        "For authenticated sites, use unbrowse_login first. Use unbrowse_do for guidance.",
        "",
        "Tip: prefer unbrowse_browse for website automation (avoids brittle browser-tool ref errors).",
        "Login UX: use the OpenClaw-managed browser profile (manual login recommended). Avoid asking users for passwords.",
      ];

      // Only mention wallet if explicitly configured
      if (creatorWallet && solanaPrivateKey) {
        lines.push("", `Skill marketplace wallet: ${creatorWallet}`);
      }

      // Only mention credential source if configured
      if (credentialProvider) {
        lines.push("", `Credential source: ${credentialProvider.name} (auto-login enabled)`);
      }

      return { prependContext: lines.join("\n") };
    });

    // Register cleanup on process exit signals
    const handleExit = () => {
      tokenRefreshScheduler?.stop();
      stopCdpHeaderListener();
      cleanupAllSessions().catch(() => {});
      telemetry.flush().catch(() => {});
    };
    process.on("beforeExit", handleExit);
    process.on("SIGINT", handleExit);
    process.on("SIGTERM", handleExit);

    const toolCount = toolNames.length;
    const features = [
      `${toolCount} tools`,
      autoDiscoverEnabled ? "auto-discover" : null,
      enableAgentContextHints ? "context-hints" : null,
      publishValidationWithAuth ? "publish-auth-validation" : null,
      creatorWallet ? "x402 publishing" : null,
      credentialProvider ? `creds:${credentialProvider.name}` : null,
    ].filter(Boolean).join(", ");

    logger.info(`[unbrowse] Plugin registered (${features})`);

  },
};

export default plugin;
