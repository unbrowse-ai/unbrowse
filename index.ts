/**
 * Unbrowse — Self-learning skill generator.
 *
 * Primarily reverse-engineers APIs: provide URLs and it automatically
 * launches a browser, captures network traffic, and generates complete
 * skill packages. Also supports broader skills — library integrations,
 * workflows, and reusable agent knowledge. Skills are published to a
 * cloud marketplace where agents discover, buy, and sell with USDC.
 *
 * Tools:
 *   unbrowse_capture   — Provide URLs → auto-launches browser → captures all API traffic
 *   unbrowse_replay    — Execute API calls with stored credentials (auto-refresh on 401)
 *   unbrowse_login     — Log in with credentials via Playwright/stealth (for auth-required sites)
 *   unbrowse_interact  — Drive browser pages (click, fill, select, read) for multi-step flows
 *   unbrowse_learn     — Parse a HAR file → generate skill
 *   unbrowse_skills    — List all discovered skills
 *   unbrowse_stealth   — Launch stealth cloud browser (BrowserBase) — API execution only
 *   unbrowse_auth      — Extract auth from a running browser via CDP (low-level)
 *   unbrowse_publish   — Publish skill to cloud index (earn USDC via x402)
 *   unbrowse_search    — Search & install skills from the cloud index
 *   unbrowse_wallet    — Manage Solana wallet (auto-generate, set address, check status)
 *
 * Hooks:
 *   after_tool_call    — Auto-discovers skills when agent uses browser tool
 */

import type { ClawdbotPluginApi, ClawdbotPluginToolContext } from "clawdbot/plugin-sdk";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

import { parseHar } from "./src/har-parser.js";
import { generateSkill } from "./src/skill-generator.js";
import { fetchBrowserCookies, fetchCapturedRequests } from "./src/cdp-capture.js";
import { AutoDiscovery } from "./src/auto-discover.js";
import {
  createStealthSession,
  stopStealthSession,
  getStealthSession,
  captureFromStealth,
  type StealthSession,
} from "./src/stealth-browser.js";
import { SkillIndexClient, type PublishPayload } from "./src/skill-index.js";
import { sanitizeApiTemplate, extractEndpoints, extractPublishableAuth } from "./src/skill-sanitizer.js";
import { loginAndCapture, type LoginCredentials } from "./src/session-login.js";
import {
  createCredentialProvider,
  lookupCredentials,
  buildFormFields,
  type CredentialProvider,
  type LoginCredential,
} from "./src/credential-providers.js";
import {
  TokenRefreshScheduler,
  extractRefreshConfig,
  type RefreshConfig,
} from "./src/token-refresh.js";

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
          auth = JSON.parse(readFileSync(authPath, "utf-8"));
        }
        auth.refreshConfig = refreshConfig;
        writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf-8");
        logger.info(`[unbrowse] Detected refresh endpoint: ${refreshConfig.url}`);
        break; // Only need one
      } catch { /* skip */ }
    }
  }
}

// ── Tool Schemas ──────────────────────────────────────────────────────────────

const LEARN_SCHEMA = {
  type: "object" as const,
  properties: {
    harPath: {
      type: "string" as const,
      description: "Path to a HAR file to parse",
    },
    harJson: {
      type: "string" as const,
      description: "Inline HAR JSON content (alternative to harPath)",
    },
    outputDir: {
      type: "string" as const,
      description: "Directory to save generated skill (default: ~/.clawdbot/skills)",
    },
  },
  required: [] as string[],
};

const CAPTURE_SCHEMA = {
  type: "object" as const,
  properties: {
    urls: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "URLs to visit and capture API traffic from. The tool launches a browser automatically — just provide URLs.",
    },
    outputDir: {
      type: "string" as const,
      description: "Directory to save generated skill (default: ~/.clawdbot/skills)",
    },
    waitMs: {
      type: "number" as const,
      description: "How long to wait on each page for network activity in ms (default: 5000).",
    },
    crawl: {
      type: "boolean" as const,
      description: "Browse the site after loading seed URLs to discover more API endpoints. Follows same-domain links. (default: true)",
    },
    maxPages: {
      type: "number" as const,
      description: "Max pages to visit during crawl (default: 15). Only used when crawl=true.",
    },
    testEndpoints: {
      type: "boolean" as const,
      description: "Auto-test discovered GET endpoints with captured auth to verify they work (default: true).",
    },
  },
  required: ["urls"],
};

const AUTH_SCHEMA = {
  type: "object" as const,
  properties: {
    domain: {
      type: "string" as const,
      description: "Filter auth extraction to a specific domain",
    },
  },
  required: [] as string[],
};

const REPLAY_SCHEMA = {
  type: "object" as const,
  properties: {
    service: {
      type: "string" as const,
      description: "Service name (skill directory name) to test",
    },
    endpoint: {
      type: "string" as const,
      description: "Specific endpoint to call (e.g., 'GET /api/v2/streams/trending'). If omitted, tests all endpoints.",
    },
    body: {
      type: "string" as const,
      description: "JSON body for POST/PUT/PATCH requests",
    },
    skillsDir: {
      type: "string" as const,
      description: "Skills directory (default: ~/.clawdbot/skills)",
    },
    useStealth: {
      type: "boolean" as const,
      description: "Use stealth cloud browser with anti-detection to bypass blocks. Costs ~$0.01/call. Auto-enabled on 403/blocked responses.",
    },
    proxyCountry: {
      type: "string" as const,
      description: "Proxy country code when using stealth (e.g., 'us', 'gb', 'de'). Default: 'us'.",
    },
  },
  required: ["service"],
};

const STEALTH_SCHEMA = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: ["start", "stop", "capture", "status"],
      description:
        "start: launch cloud browser, stop: end session, capture: grab network traffic + generate skill, status: check session",
    },
    url: {
      type: "string" as const,
      description: "URL to navigate to after starting (optional)",
    },
    timeout: {
      type: "number" as const,
      description: "Session timeout in minutes (default: 15, max: 240)",
    },
    proxyCountry: {
      type: "string" as const,
      description: "Proxy country code (e.g., US, GB, SG) for geo-restricted sites",
    },
    sessionId: {
      type: "string" as const,
      description: "Session ID (required for stop/capture/status actions)",
    },
  },
  required: ["action"],
};

const SKILLS_SCHEMA = {
  type: "object" as const,
  properties: {},
  required: [] as string[],
};

const PUBLISH_SCHEMA = {
  type: "object" as const,
  properties: {
    service: {
      type: "string" as const,
      description: "Service name (skill directory name) to publish to the cloud index",
    },
    skillsDir: {
      type: "string" as const,
      description: "Skills directory (default: ~/.clawdbot/skills)",
    },
  },
  required: ["service"],
};

const SEARCH_SCHEMA = {
  type: "object" as const,
  properties: {
    query: {
      type: "string" as const,
      description: "Search query — service name, API type, or description",
    },
    tags: {
      type: "string" as const,
      description: "Comma-separated tags to filter by (e.g., rest,finance)",
    },
    install: {
      type: "string" as const,
      description: "Skill ID to download and install locally (requires x402 USDC payment)",
    },
  },
  required: [] as string[],
};

const WALLET_SCHEMA = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      description:
        'Action: "status" (show wallet config + balances), "setup" (auto-generate keypair if not configured), ' +
        '"set_creator" (set earning wallet address), "set_payer" (set private key for paying downloads)',
    },
    wallet: {
      type: "string" as const,
      description: "Solana wallet address (for set_creator action)",
    },
    privateKey: {
      type: "string" as const,
      description: "Base58-encoded Solana private key (for set_payer action)",
    },
  },
  required: [] as string[],
};

const INTERACT_SCHEMA = {
  type: "object" as const,
  properties: {
    url: {
      type: "string" as const,
      description: "URL to navigate to. Uses authenticated session from a previously captured skill.",
    },
    service: {
      type: "string" as const,
      description: "Service name to load auth from (uses auth.json from this skill). Auto-detected from URL domain if omitted.",
    },
    actions: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          action: {
            type: "string" as const,
            enum: [
              "click_element", "input_text", "select_option", "get_dropdown_options",
              "scroll", "send_keys", "wait", "extract_content",
              "go_to_url", "go_back", "done", "wait_for_otp",
            ],
            description:
              "Action type. Use element indices from the page state (e.g. click_element index=3). " +
              "Index-based actions: click_element, input_text, select_option, get_dropdown_options. " +
              "Page actions: scroll, send_keys, wait, extract_content, go_to_url, go_back, done. " +
              "Special: wait_for_otp (waits for OTP from SMS/notification, auto-fills into index).",
          },
          index: {
            type: "number" as const,
            description: "Element index from page state (shown as [1], [2], etc.). Required for click_element, input_text, select_option, get_dropdown_options.",
          },
          text: {
            type: "string" as const,
            description: 'Text for input_text (value to type), select_option (option text to select), extract_content (query), send_keys (keys like "Enter", "Tab", "Control+a"), go_to_url (URL).',
          },
          clear: {
            type: "boolean" as const,
            description: "For input_text: clear existing text before typing (default: true).",
          },
          direction: {
            type: "string" as const,
            enum: ["down", "up"],
            description: 'Scroll direction (default: "down").',
          },
          amount: {
            type: "number" as const,
            description: "Scroll amount in pages (default: 1). Use 0.5 for half page, 10 for bottom/top.",
          },
          selector: {
            type: "string" as const,
            description: "CSS selector fallback — only use when element index is not available.",
          },
        },
        required: ["action"],
      },
      description:
        "Sequence of browser actions. After navigating, you receive a page state with indexed interactive elements " +
        "(e.g. [1] <button> Submit, [2] <input type=\"text\" placeholder=\"Search\">). " +
        "Reference elements by their index number in click_element, input_text, select_option actions.",
    },
    captureTraffic: {
      type: "boolean" as const,
      description: "Capture API traffic during interaction for skill generation (default: true)",
    },
    closeChromeIfNeeded: {
      type: "boolean" as const,
      description: "Only needed if Chrome is running WITHOUT remote debugging. If Chrome has CDP enabled (--remote-debugging-port), we connect directly without closing. Set true only if asked to close Chrome.",
    },
  },
  required: ["url", "actions"],
};

const LOGIN_SCHEMA = {
  type: "object" as const,
  properties: {
    loginUrl: {
      type: "string" as const,
      description: "URL of the login page to navigate to",
    },
    service: {
      type: "string" as const,
      description: "Service name for the skill (auto-detected from domain if omitted)",
    },
    formFields: {
      type: "object" as const,
      description:
        'CSS selector → value pairs for form fields. e.g. {"#email": "user@example.com", "#password": "secret"}. ' +
        "Use CSS selectors that target the input elements.",
      additionalProperties: { type: "string" as const },
    },
    submitSelector: {
      type: "string" as const,
      description: 'CSS selector for the submit button (default: auto-detect). e.g. "button[type=submit]"',
    },
    headers: {
      type: "object" as const,
      description: "Headers to inject on all requests (e.g. API key auth). These are set before navigation.",
      additionalProperties: { type: "string" as const },
    },
    cookies: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const },
          value: { type: "string" as const },
          domain: { type: "string" as const },
        },
        required: ["name", "value", "domain"],
      },
      description: "Pre-set cookies to inject before navigating (e.g. existing session tokens)",
    },
    captureUrls: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "Additional URLs to visit after login to capture API traffic for skill generation",
    },
    proxyCountry: {
      type: "string" as const,
      description: "Proxy country code for stealth browser (e.g., US, GB). Only used with BrowserBase.",
    },
    autoFillFromProvider: {
      type: "boolean" as const,
      description:
        "Auto-fill login form using credentials from the configured credential source " +
        "(keychain, 1password, or vault). Only works if credentialSource is configured. Default: true when no formFields provided.",
    },
    saveCredentials: {
      type: "boolean" as const,
      description:
        "Save the login credentials to the vault after successful login (default: true if vault provider is active).",
    },
  },
  required: ["loginUrl"],
};

const AGENT_SCHEMA = {
  type: "object" as const,
  properties: {
    task: {
      type: "string" as const,
      description:
        "Natural language task to execute. The AI agent will browse the web autonomously to complete it. " +
        'e.g. "Go to twitter.com and post \'Hello world\'" or "Search for flights to Paris on kayak.com"',
    },
    url: {
      type: "string" as const,
      description: "Starting URL (optional). If not provided, the agent will start from a search engine.",
    },
    maxSteps: {
      type: "number" as const,
      description: "Maximum number of browser actions the agent can take (default: 50).",
    },
    timeoutMinutes: {
      type: "number" as const,
      description: "Maximum time to run in minutes (default: 15, max: 60).",
    },
    profileId: {
      type: "string" as const,
      description: "Browser profile ID for authenticated sessions (create with action='create_profile').",
    },
    action: {
      type: "string" as const,
      enum: ["run", "status", "stop", "list_profiles", "create_profile"],
      description:
        "Action to perform. run: execute task (default), status: check task status, stop: cancel task, " +
        "list_profiles: show saved browser profiles, create_profile: create a new profile for authenticated sessions.",
    },
    taskId: {
      type: "string" as const,
      description: "Task ID (required for status/stop actions).",
    },
    profileName: {
      type: "string" as const,
      description: "Name for new profile (required for create_profile action).",
    },
  },
  required: [] as string[],
};

// ── Plugin ────────────────────────────────────────────────────────────────────

const plugin = {
  id: "unbrowse",
  name: "Unbrowse",
  description:
    "Self-learning skill generator. Primarily reverse-engineers APIs by browsing websites and " +
    "capturing network traffic — no manual steps, no extension, no Chrome needed. Also supports " +
    "broader skills: library integrations, workflows, and reusable agent knowledge. " +
    "Generates complete skill packages (SKILL.md, auth.json, TypeScript client) and publishes " +
    "to a cloud marketplace where agents can discover, buy, and sell skills with USDC.",

  register(api: ClawdbotPluginApi) {
    const cfg = api.pluginConfig ?? {};
    const logger = api.logger;
    const browserPort = (cfg.browserPort as number) ?? 18791;

    // ── Persistent OTP Watcher ─────────────────────────────────────────────
    // Keeps running across interact calls so OTP can be filled when it arrives
    let persistentOtpWatcher: any = null;
    let otpWatcherPage: any = null;  // The page to fill OTP into
    let otpWatcherElementIndex: number | null = null;
    let otpWatcherTimeout: NodeJS.Timeout | null = null;
    const OTP_WATCHER_TTL_MS = 5 * 60 * 1000; // 5 minutes

    async function startPersistentOtpWatcher(page: any, elementIndex: number) {
      // Stop any existing watcher
      stopPersistentOtpWatcher();

      otpWatcherPage = page;
      otpWatcherElementIndex = elementIndex;

      const { startOTPWatcher } = await import("./src/otp-watcher.js");
      const { getElementByIndex } = await import("./src/dom-service.js");

      persistentOtpWatcher = startOTPWatcher(async (otp) => {
        logger.info(`[unbrowse] Auto-OTP: Received "${otp.code}" from ${otp.source}`);
        try {
          if (otpWatcherPage && otpWatcherElementIndex != null) {
            const el = await getElementByIndex(otpWatcherPage, otpWatcherElementIndex);
            if (el) {
              await el.click();
              await el.fill(otp.code);
              logger.info(`[unbrowse] Auto-OTP: Filled "${otp.code}" into element [${otpWatcherElementIndex}]`);
              // Clear after successful fill
              persistentOtpWatcher?.clear();
            }
          }
        } catch (err) {
          logger.warn(`[unbrowse] Auto-OTP fill failed: ${(err as Error).message}`);
        }
      });

      // Auto-stop after TTL
      otpWatcherTimeout = setTimeout(() => {
        logger.info(`[unbrowse] Auto-OTP watcher TTL expired (${OTP_WATCHER_TTL_MS / 1000}s)`);
        stopPersistentOtpWatcher();
      }, OTP_WATCHER_TTL_MS);

      logger.info(`[unbrowse] Persistent OTP watcher started for element [${elementIndex}] (TTL: ${OTP_WATCHER_TTL_MS / 1000}s)`);
    }

    function stopPersistentOtpWatcher() {
      if (persistentOtpWatcher) {
        persistentOtpWatcher.stop();
        persistentOtpWatcher = null;
      }
      if (otpWatcherTimeout) {
        clearTimeout(otpWatcherTimeout);
        otpWatcherTimeout = null;
      }
      otpWatcherPage = null;
      otpWatcherElementIndex = null;
    }
    const defaultOutputDir = (cfg.skillsOutputDir as string) ?? join(homedir(), ".clawdbot", "skills");
    const browserUseApiKey = cfg.browserUseApiKey as string | undefined;
    const browserUseCloudApiKey = cfg.browserUseCloudApiKey as string | undefined;
    const autoDiscoverEnabled = (cfg.autoDiscover as boolean) ?? true;
    const skillIndexUrl = (cfg.skillIndexUrl as string) ?? process.env.UNBROWSE_INDEX_URL ?? "https://skills.unbrowse.ai";
    let creatorWallet = (cfg.creatorWallet as string) ?? process.env.UNBROWSE_CREATOR_WALLET;
    let solanaPrivateKey = (cfg.skillIndexSolanaPrivateKey as string) ?? process.env.UNBROWSE_SOLANA_PRIVATE_KEY;
    const credentialSourceCfg = (cfg.credentialSource as string) ?? process.env.UNBROWSE_CREDENTIAL_SOURCE ?? "none";
    const vaultDbPath = join(homedir(), ".clawdbot", "unbrowse", "vault.db");
    const credentialProvider = createCredentialProvider(credentialSourceCfg, vaultDbPath);

    // ── Auto-Generate Wallet ──────────────────────────────────────────────
    // If no wallet is configured, generate a Solana keypair automatically.
    // This lets the agent discover and pay for skills out of the box.
    async function ensureWallet(): Promise<void> {
      if (creatorWallet && solanaPrivateKey) return; // Already configured

      try {
        const { Keypair } = await import("@solana/web3.js");
        const bs58 = await import("bs58");
        const keypair = Keypair.generate();
        const publicKey = keypair.publicKey.toBase58();
        const privateKeyB58 = bs58.default.encode(keypair.secretKey);

        // Save to plugin config via runtime
        const currentConfig = await api.runtime.config.loadConfig();
        const pluginEntries = (currentConfig as any).plugins?.entries ?? {};
        const unbrowseEntry = pluginEntries.unbrowse ?? {};
        const unbrowseConfig = unbrowseEntry.config ?? {};

        if (!creatorWallet) {
          unbrowseConfig.creatorWallet = publicKey;
          creatorWallet = publicKey;
          indexOpts.creatorWallet = publicKey;
        }
        if (!solanaPrivateKey) {
          unbrowseConfig.skillIndexSolanaPrivateKey = privateKeyB58;
          solanaPrivateKey = privateKeyB58;
          indexOpts.solanaPrivateKey = privateKeyB58;
        }

        unbrowseEntry.config = unbrowseConfig;
        pluginEntries.unbrowse = unbrowseEntry;
        (currentConfig as any).plugins = { ...(currentConfig as any).plugins, entries: pluginEntries };

        await api.runtime.config.writeConfigFile(currentConfig);

        logger.info(
          `[unbrowse] Solana wallet auto-generated: ${publicKey}` +
          ` — send USDC (Solana SPL) to this address to discover skills from the marketplace ($0.01/skill).` +
          ` You also earn USDC when others download your published skills.`,
        );
      } catch (err) {
        logger.error(`[unbrowse] Failed to auto-generate wallet: ${(err as Error).message}`);
      }
    }

    // ── Skill Index Client ─────────────────────────────────────────────────
    // Use a shared opts object so wallet values stay in sync after auto-generation
    const indexOpts: { indexUrl: string; creatorWallet?: string; solanaPrivateKey?: string } = {
      indexUrl: skillIndexUrl,
      creatorWallet,
      solanaPrivateKey,
    };
    const indexClient = new SkillIndexClient(indexOpts);

    // Fire-and-forget wallet setup (don't block plugin registration)
    ensureWallet().catch(() => { });

    // ── Auto-Publish Helper ────────────────────────────────────────────────
    // Track server reachability to avoid repeated failed publish attempts
    let serverReachable: boolean | null = null; // null = unknown, needs check
    let lastReachabilityCheck = 0;
    const REACHABILITY_CHECK_INTERVAL = 5 * 60 * 1000; // Re-check every 5 minutes

    /** Publish a skill to the cloud index if creatorWallet is configured. */
    async function autoPublishSkill(service: string, skillDir: string): Promise<string | null> {
      if (!creatorWallet) return null;

      // Check server reachability (with caching to avoid hammering)
      const now = Date.now();
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
        const skillMd = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
        const endpoints = extractEndpoints(skillMd);
        let baseUrl = "";
        let authMethodType = "Unknown";
        const authJsonPath = join(skillDir, "auth.json");
        if (existsSync(authJsonPath)) {
          const pub = extractPublishableAuth(readFileSync(authJsonPath, "utf-8"));
          baseUrl = pub.baseUrl;
          authMethodType = pub.authMethodType;
        }
        let apiTemplate = "";
        const apiTsPath = join(skillDir, "scripts", "api.ts");
        if (existsSync(apiTsPath)) {
          apiTemplate = sanitizeApiTemplate(readFileSync(apiTsPath, "utf-8"));
        }

        const result = await indexClient.publish({
          service, baseUrl, authMethodType, endpoints,
          skillMd, apiTemplate, creatorWallet,
        });
        logger.info(`[unbrowse] Auto-published: ${service} v${result.version}`);
        return `v${result.version}`;
      } catch (err) {
        const msg = (err as Error).message ?? "";
        // If it's a connection error, mark server as unreachable
        if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("timeout")) {
          serverReachable = false;
          lastReachabilityCheck = now;
          logger.info(`[unbrowse] Skill marketplace unreachable — auto-publish disabled until server is available.`);
        } else {
          logger.warn(`[unbrowse] Auto-publish failed for ${service}: ${msg}`);
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
          await autoPublishSkill(service, result.skillDir);
        }
      },
    });

    // Track active stealth sessions
    const stealthSessions = new Map<string, StealthSession>();

    // ── Browser Session Tracking ────────────────────────────────────────────
    // Use a SINGLE shared browser instance across all services (just different tabs).
    // This prevents multiple Chrome windows from opening.
    interface BrowserSession {
      browser: any;
      context: any;
      page: any;
      service: string;
      lastUsed: Date;
      method: "cdp-clawdbot" | "cdp-chrome" | "playwright";
    }
    const browserSessions = new Map<string, BrowserSession>();
    const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

    // Shared browser instance - reused across all services
    let sharedBrowser: any = null;
    let sharedContext: any = null;
    let sharedBrowserMethod: BrowserSession["method"] = "playwright";

    /** Try to connect to a CDP endpoint. Returns browser or null. */
    async function tryCdpConnect(chromium: any, port: number): Promise<any | null> {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(2000),
        });
        if (!resp.ok) return null;
        const data = await resp.json() as { webSocketDebuggerUrl?: string };
        const wsUrl = data.webSocketDebuggerUrl ?? `http://127.0.0.1:${port}`;
        const browser = await chromium.connectOverCDP(wsUrl, { timeout: 5000 });
        logger.info(`[unbrowse] Connected to CDP at port ${port}`);
        return browser;
      } catch {
        // CDP not available at this port — silently fall through to next strategy
        return null;
      }
    }

    /** Gracefully close Chrome and wait for it to exit. */
    async function closeChrome(): Promise<boolean> {
      try {
        const { spawnSync } = await import("node:child_process");
        // Use osascript to gracefully quit Chrome (saves state)
        spawnSync("osascript", ["-e", 'tell application "Google Chrome" to quit'], { timeout: 5000 });
        // Wait for Chrome to fully exit
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          const psResult = spawnSync("pgrep", ["-x", "Google Chrome"], { encoding: "utf-8" });
          if (!psResult.stdout.trim()) {
            logger.info(`[unbrowse] Chrome closed successfully`);
            return true;
          }
        }
        // Force kill if still running
        spawnSync("pkill", ["-x", "Google Chrome"], { timeout: 2000 });
        logger.info(`[unbrowse] Chrome force-killed`);
        return true;
      } catch (err) {
        logger.warn(`[unbrowse] Failed to close Chrome: ${(err as Error).message}`);
        return false;
      }
    }

    /** Clean up stale browser sessions (just close pages, not the shared browser). */
    function cleanupStaleSessions() {
      const now = Date.now();
      for (const [key, session] of browserSessions) {
        if (now - session.lastUsed.getTime() > SESSION_TTL_MS) {
          // Only close the page (tab), not the shared browser/context
          session.page?.close().catch(() => {});
          browserSessions.delete(key);
          logger.info(`[unbrowse] Closed stale tab for ${key}`);
        }
      }
    }

    /** Get or create a browser session for a service. Uses CDP cascade.
     *  IMPORTANT: Reuses a SINGLE shared browser instance across all services.
     *  Each service gets its own page (tab) in the shared browser.
     */
    async function getOrCreateBrowserSession(
      service: string,
      url: string,
      authCookies: Record<string, string>,
      authHeaders: Record<string, string>,
    ): Promise<BrowserSession> {
      // Clean up stale sessions first
      cleanupStaleSessions();

      // Check for existing session for this service
      const existing = browserSessions.get(service);
      if (existing) {
        existing.lastUsed = new Date();
        // Verify the page is still alive
        try {
          await existing.page.evaluate(() => true);
          return existing;
        } catch {
          // Page died, remove from sessions (but keep shared browser)
          browserSessions.delete(service);
        }
      }

      const { chromium } = await import("playwright");

      // Check if shared browser is still alive
      if (sharedBrowser) {
        try {
          // Test if browser is responsive
          const contexts = sharedBrowser.contexts();
          if (contexts.length === 0) throw new Error("No contexts");
        } catch {
          // Browser died, reset
          sharedBrowser = null;
          sharedContext = null;
        }
      }

      // Create shared browser if needed (only happens once)
      if (!sharedBrowser) {
        // Strategy 1: Connect to Chrome extension relay (port 18792) — user's actual Chrome with auto-attach
        sharedBrowser = await tryCdpConnect(chromium, 18792);
        sharedBrowserMethod = "cdp-chrome";

        // Strategy 2: Connect to clawd managed browser (port 18800) — has persistent user-data
        if (!sharedBrowser) {
          sharedBrowser = await tryCdpConnect(chromium, 18800);
          sharedBrowserMethod = "cdp-clawdbot";
        }

        // Strategy 3: Connect to browser control server's default (port 18791 forwards to active profile)
        if (!sharedBrowser) {
          sharedBrowser = await tryCdpConnect(chromium, browserPort);
          sharedBrowserMethod = "cdp-clawdbot";
        }

        // Strategy 4: Connect to Chrome with other remote debugging ports
        if (!sharedBrowser) {
          for (const port of [9222, 9229]) {
            sharedBrowser = await tryCdpConnect(chromium, port);
            if (sharedBrowser) {
              sharedBrowserMethod = "cdp-chrome";
              break;
            }
          }
        }

        // Strategy 5: Launch Playwright Chromium (fast, reliable, no Chrome dependency)
        // This is the primary fallback when no CDP connection is available
        if (!sharedBrowser) {
          logger.info(`[unbrowse] Launching Playwright Chromium...`);
          try {
            sharedBrowser = await chromium.launch({
              headless: false,
              args: [
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
              ],
            });
            sharedBrowserMethod = "playwright";
            logger.info(`[unbrowse] Launched Playwright Chromium browser`);
          } catch (err) {
            logger.info(`[unbrowse] Playwright launch failed: ${(err as Error).message.split('\n')[0]}`);
          }
        }

        if (!sharedBrowser) {
          throw new Error("NO_BROWSER");
        }
      }

      // Get or create shared context (using Chrome with user profile)
      let context = sharedContext;
      if (!context) {
        context = sharedBrowser.contexts()[0];
      }
      if (!context) {
        context = await sharedBrowser.newContext({
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        });
      }

      // Store context for reuse
      sharedContext = context;

      // Inject cookies for the target domain from auth.json
      if (Object.keys(authCookies).length > 0) {
        try {
          const domain = new URL(url).hostname;
          const cookieObjects = Object.entries(authCookies).map(([name, value]) => ({
            name,
            value,
            domain,
            path: "/",
          }));
          await context.addCookies(cookieObjects);
        } catch { /* non-critical */ }
      }

      // Inject custom headers
      if (Object.keys(authHeaders).length > 0) {
        try {
          await context.setExtraHTTPHeaders(authHeaders);
        } catch { /* non-critical */ }
      }

      // Create a new page (tab) for this service in the shared browser
      const page = await context.newPage();
      const session: BrowserSession = {
        browser: sharedBrowser,
        context,
        page,
        service,
        lastUsed: new Date(),
        method: sharedBrowserMethod,
      };
      browserSessions.set(service, session);
      logger.info(`[unbrowse] Created tab for ${service} in shared browser (${sharedBrowserMethod})`);
      return session;
    }

    // ── Tools ─────────────────────────────────────────────────────────────

    const tools = (_ctx: ClawdbotPluginToolContext) => {
      const toolList = [
        // ── unbrowse_learn ──────────────────────────────────────────
        {
          name: "unbrowse_learn",
          label: "Learn API from HAR",
          description:
            "Parse a HAR file to discover API endpoints, extract authentication, " +
            "and generate a complete clawdbot skill package (SKILL.md, auth.json, " +
            "TypeScript API client). The skill is installed to ~/.clawdbot/skills/ " +
            "for immediate use.",
          parameters: LEARN_SCHEMA,
          async execute(_toolCallId: string, params: unknown) {
            const p = params as { harPath?: string; harJson?: string; outputDir?: string };

            let harData: { log: { entries: unknown[] } };

            if (p.harPath) {
              const absPath = resolve(p.harPath);
              if (!existsSync(absPath)) {
                return { content: [{ type: "text", text: `HAR file not found: ${absPath}` }] };
              }
              try {
                harData = JSON.parse(readFileSync(absPath, "utf-8"));
              } catch (err) {
                return { content: [{ type: "text", text: `Failed to parse HAR: ${(err as Error).message}` }] };
              }
            } else if (p.harJson) {
              try {
                harData = JSON.parse(p.harJson);
              } catch (err) {
                return { content: [{ type: "text", text: `Failed to parse HAR JSON: ${(err as Error).message}` }] };
              }
            } else {
              return { content: [{ type: "text", text: "Provide either harPath or harJson." }] };
            }

            try {
              const apiData = parseHar(harData as any);
              const result = await generateSkill(apiData, p.outputDir ?? defaultOutputDir);
              discovery.markLearned(result.service);

              // Detect and save refresh token config
              detectAndSaveRefreshConfig((harData as any).log?.entries ?? [], join(result.skillDir, "auth.json"), logger);

              // Auto-publish if skill content changed
              let publishedVersion: string | null = null;
              if (result.changed) {
                publishedVersion = await autoPublishSkill(result.service, result.skillDir);
              }

              const summaryLines = [
                `Skill generated: ${result.service}`,
                `Auth: ${result.authMethod}`,
                `Endpoints: ${result.endpointCount}`,
              ];
              if (result.diff) {
                summaryLines.push(`Changes: ${result.diff}`);
              }
              summaryLines.push(
                `Auth headers: ${result.authHeaderCount} | Cookies: ${result.cookieCount}`,
                `Installed: ${result.skillDir}`,
              );
              if (publishedVersion) {
                summaryLines.push(`Published: ${publishedVersion} (auto-synced to cloud index)`);
              }
              summaryLines.push("", `Use ${toPascalCase(result.service)}Client from scripts/api.ts`);

              logger.info(`[unbrowse] Skill: ${result.service} (${result.endpointCount} endpoints)`);
              return { content: [{ type: "text", text: summaryLines.join("\n") }] };
            } catch (err) {
              return { content: [{ type: "text", text: `Skill generation failed: ${(err as Error).message}` }] };
            }
          },
        },

        // ── unbrowse_capture ────────────────────────────────────────
        {
          name: "unbrowse_capture",
          label: "Capture APIs",
          description:
            "Capture API traffic from any website. Just provide URLs — the tool automatically " +
            "launches a browser, visits each page, crawls same-domain links to discover more endpoints, " +
            "checks for OpenAPI/Swagger specs, and auto-tests all GET endpoints. No extension needed. " +
            "For sites that require login, use unbrowse_login first to establish a session.",
          parameters: CAPTURE_SCHEMA,
          async execute(_toolCallId: string, params: unknown) {
            const p = params as {
              outputDir?: string;
              urls: string[];
              waitMs?: number;
              crawl?: boolean;
              maxPages?: number;
              testEndpoints?: boolean;
            };

            if (!p.urls || p.urls.length === 0) {
              return { content: [{ type: "text", text: "Provide at least one URL to capture." }] };
            }

            try {
              const { captureFromChromeProfile } = await import("./src/profile-capture.js");

              const shouldCrawl = p.crawl !== false;
              const shouldTest = p.testEndpoints !== false;
              const maxPages = p.maxPages ?? 15;

              // Progress feedback before starting
              logger.info(`[unbrowse] Capture starting: ${p.urls.length} seed URL(s), crawl up to ${maxPages} pages (60s max)...`);

              const { har, cookies, requestCount, method, crawlResult } = await captureFromChromeProfile(p.urls, {
                waitMs: p.waitMs,
                browserPort,
                crawl: shouldCrawl,
                crawlOptions: {
                  maxPages,
                  discoverOpenApi: true,
                },
              });

              // Analyze HTTP status codes for rate limit/blocking detection
              const entries = har.log?.entries ?? [];
              let blocked403 = 0;
              let rateLimited429 = 0;
              let serverErrors5xx = 0;
              for (const entry of entries) {
                const status = entry.response?.status ?? 0;
                if (status === 403) blocked403++;
                else if (status === 429) rateLimited429++;
                else if (status >= 500 && status < 600) serverErrors5xx++;
              }
              const totalRequests = entries.length;
              const failedRequests = blocked403 + rateLimited429 + serverErrors5xx;
              const failureRate = totalRequests > 0 ? failedRequests / totalRequests : 0;

              if (requestCount === 0) {
                return { content: [{ type: "text", text: "No API requests captured. The pages may not make API calls, or try waiting longer (waitMs)." }] };
              }

              let apiData = parseHar(har, p.urls[0]);
              for (const [name, value] of Object.entries(cookies)) {
                if (!apiData.cookies[name]) apiData.cookies[name] = value;
              }

              // Merge OpenAPI spec endpoints if found
              const openApiSpec = crawlResult?.openApiSpec ?? null;
              if (openApiSpec) {
                const { mergeOpenApiEndpoints } = await import("./src/har-parser.js");
                const specBaseUrl = openApiSpec.baseUrl ?? apiData.baseUrl;
                apiData = mergeOpenApiEndpoints(apiData, openApiSpec.endpoints, specBaseUrl);
              }

              // Auto-test GET endpoints
              let testSummary: { total: number; verified: number; failed: number; skipped: number; results: Array<{ method: string; path: string; ok: boolean; hasData: boolean }> } | null = null;
              if (shouldTest && Object.keys(apiData.endpoints).length > 0) {
                try {
                  const { testGetEndpoints } = await import("./src/endpoint-tester.js");
                  testSummary = await testGetEndpoints(
                    apiData.baseUrl,
                    apiData.endpoints,
                    apiData.authHeaders,
                    { ...apiData.cookies, ...cookies },
                  );

                  // Mark endpoints as verified based on test results
                  for (const tr of testSummary.results) {
                    for (const [, reqs] of Object.entries(apiData.endpoints)) {
                      for (const r of reqs) {
                        if (r.path === tr.path && r.method === tr.method) {
                          r.verified = tr.ok && tr.hasData;
                        }
                      }
                    }
                  }
                } catch (testErr) {
                  logger.warn(`[unbrowse] Endpoint testing failed: ${(testErr as Error).message}`);
                }
              }

              const result = await generateSkill(apiData, p.outputDir ?? defaultOutputDir, {
                verifiedEndpoints: testSummary?.verified,
                unverifiedEndpoints: testSummary?.failed,
                openApiSource: crawlResult?.openApiSource,
                pagesCrawled: crawlResult?.pagesCrawled,
              });
              discovery.markLearned(result.service);

              // Detect and save refresh token config
              detectAndSaveRefreshConfig(har.log?.entries ?? [], join(result.skillDir, "auth.json"), logger);

              // Auto-publish if skill content changed
              let publishedVersion: string | null = null;
              if (result.changed) {
                publishedVersion = await autoPublishSkill(result.service, result.skillDir);
              }

              // Build summary
              const summaryLines = [
                `Captured (${method}): ${requestCount} requests from ${p.urls.length} page(s)`,
              ];
              if (crawlResult && crawlResult.pagesCrawled > 0) {
                summaryLines.push(`Crawled: ${crawlResult.pagesCrawled} additional pages`);
              }
              if (openApiSpec) {
                summaryLines.push(`OpenAPI: ${crawlResult?.openApiSource} (${openApiSpec.endpoints.length} endpoints)`);
              }
              summaryLines.push(
                `Skill: ${result.service}`,
                `Auth: ${result.authMethod}`,
                `Endpoints: ${result.endpointCount}`,
              );
              if (result.diff) {
                summaryLines.push(`Changes: ${result.diff}`);
              }
              if (testSummary) {
                summaryLines.push(`Verified: ${testSummary.verified}/${testSummary.total} GET endpoints`);
              }
              summaryLines.push(
                `Auth headers: ${result.authHeaderCount} | Cookies: ${result.cookieCount}`,
                `Installed: ${result.skillDir}`,
              );
              if (publishedVersion) {
                summaryLines.push(`Published: ${publishedVersion} (auto-synced to cloud index)`);
              }

              // Rate limit / bot detection warnings
              if (failureRate > 0.1 && failedRequests > 2) {
                const failureDetails: string[] = [];
                if (blocked403 > 0) failureDetails.push(`${blocked403} blocked (403)`);
                if (rateLimited429 > 0) failureDetails.push(`${rateLimited429} rate-limited (429)`);
                if (serverErrors5xx > 0) failureDetails.push(`${serverErrors5xx} server errors (5xx)`);
                summaryLines.push(
                  "",
                  `⚠️  High failure rate: ${failureDetails.join(", ")} out of ${totalRequests} requests`,
                  `   The site may be blocking automated crawls. Skill may be incomplete.`,
                  `   Try: unbrowse_replay with useStealth=true, or the browser tool for manual exploration.`,
                );
                logger.warn(`[unbrowse] High failure rate (${Math.round(failureRate * 100)}%) — ${failureDetails.join(", ")}`);
              }

              logger.info(`[unbrowse] Capture → ${result.service} (${result.endpointCount} endpoints, ${crawlResult?.pagesCrawled ?? 0} crawled, via ${method})`);
              return { content: [{ type: "text", text: summaryLines.join("\n") }] };
            } catch (err) {
              const msg = (err as Error).message;
              if (msg.includes("Target page, context or browser has been closed")) {
                return { content: [{ type: "text", text: "Browser context closed unexpectedly. Try again." }] };
              }
              if (msg.includes("playwright")) {
                return { content: [{ type: "text", text: `Playwright not available: ${msg}. Install with: bun add playwright` }] };
              }
              return { content: [{ type: "text", text: `Capture failed: ${msg}` }] };
            }
          },
        },

        // ── unbrowse_auth ───────────────────────────────────────────
        {
          name: "unbrowse_auth",
          label: "Extract Auth",
          description:
            "Extract auth credentials (cookies, headers, tokens) from a running browser via CDP. " +
            "For most use cases, prefer unbrowse_capture (just provide URLs) or " +
            "unbrowse_login (credential-based login). This is a low-level tool.",
          parameters: AUTH_SCHEMA,
          async execute(_toolCallId: string, params: unknown) {
            const p = params as { domain?: string };

            try {
              const [entries, cookies] = await Promise.all([
                fetchCapturedRequests(browserPort),
                fetchBrowserCookies(browserPort),
              ]);

              const authHeaders: Record<string, string> = {};
              const authNames = new Set([
                "authorization", "x-api-key", "api-key", "apikey",
                "x-auth-token", "access-token", "x-access-token",
                "token", "x-token", "authtype", "mudra",
              ]);

              for (const entry of entries) {
                if (p.domain) {
                  try {
                    if (!new URL(entry.url).host.includes(p.domain)) continue;
                  } catch { continue; }
                }
                for (const [name, value] of Object.entries(entry.headers ?? {})) {
                  if (authNames.has(name.toLowerCase())) {
                    authHeaders[name.toLowerCase()] = value;
                  }
                }
              }

              const lines = [
                `Auth from browser:`,
                ``,
                `Headers (${Object.keys(authHeaders).length}):`,
                ...Object.entries(authHeaders).map(([n, v]) => `  ${n}: ${v.slice(0, 50)}${v.length > 50 ? "..." : ""}`),
                ``,
                `Cookies (${Object.keys(cookies).length}):`,
                ...Object.entries(cookies).map(([n, v]) => `  ${n}: ${v.slice(0, 50)}${v.length > 50 ? "..." : ""}`),
              ];

              logger.info(`[unbrowse] Auth: ${Object.keys(authHeaders).length} headers, ${Object.keys(cookies).length} cookies`);
              return { content: [{ type: "text", text: lines.join("\n") }] };
            } catch (err) {
              const msg = (err as Error).message;
              if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
                return { content: [{ type: "text", text: `Browser not running on port ${browserPort}.` }] };
              }
              return { content: [{ type: "text", text: `Auth extraction failed: ${msg}` }] };
            }
          },
        },

        // ── unbrowse_replay ─────────────────────────────────────────
        {
          name: "unbrowse_replay",
          label: "Execute API",
          description:
            "Execute API calls using a skill's stored credentials. Uses stealth cloud browser " +
            "with proxy support (useStealth=true) to bypass anti-bot protection. Falls back to " +
            "direct fetch with auth headers/cookies. Auto-refreshes credentials on 401/403. " +
            "Auto-uses stealth fallback when requests are blocked (403/429).",
          parameters: REPLAY_SCHEMA,
          async execute(_toolCallId: string, params: unknown) {
            const p = params as { service: string; endpoint?: string; body?: string; skillsDir?: string; useStealth?: boolean; proxyCountry?: string };
            const skillsDir = p.skillsDir ?? defaultOutputDir;
            const skillDir = join(skillsDir, p.service);
            const authPath = join(skillDir, "auth.json");
            const skillMdPath = join(skillDir, "SKILL.md");

            if (!existsSync(skillDir)) {
              return { content: [{ type: "text", text: `Skill not found: ${skillDir}` }] };
            }

            // Load auth state (mutable — refreshed on 401/403)
            let authHeaders: Record<string, string> = {};
            let cookies: Record<string, string> = {};
            let baseUrl = "https://api.example.com";
            let storedLocalStorage: Record<string, string> = {};
            let storedSessionStorage: Record<string, string> = {};
            let loginConfig: {
              loginUrl: string;
              formFields?: Record<string, string>;
              submitSelector?: string;
              headers?: Record<string, string>;
              cookies?: Array<{ name: string; value: string; domain: string }>;
              captureUrls?: string[];
            } | null = null;

            async function loadAuth() {
              // Try auth.json first
              if (existsSync(authPath)) {
                try {
                  const auth = JSON.parse(readFileSync(authPath, "utf-8"));
                  authHeaders = auth.headers ?? {};
                  cookies = auth.cookies ?? {};
                  baseUrl = auth.baseUrl ?? baseUrl;
                  loginConfig = auth.loginConfig ?? null;

                  // Restore client-side auth tokens (JWTs from localStorage/sessionStorage)
                  // These were captured by session-login from the SPA's browser state.
                  const ls = auth.localStorage as Record<string, string> | undefined;
                  const ss = auth.sessionStorage as Record<string, string> | undefined;
                  const meta = auth.metaTokens as Record<string, string> | undefined;
                  storedLocalStorage = ls ?? {};
                  storedSessionStorage = ss ?? {};

                  for (const [key, value] of [...Object.entries(ls ?? {}), ...Object.entries(ss ?? {})]) {
                    const lk = key.toLowerCase();
                    // Promote JWTs to Authorization header
                    if (value.startsWith("eyJ") || /^Bearer\s/i.test(value)) {
                      const tokenValue = value.startsWith("eyJ") ? `Bearer ${value}` : value;
                      if (lk.includes("access") || lk.includes("auth") || lk.includes("token")) {
                        if (!authHeaders["authorization"]) {
                          authHeaders["authorization"] = tokenValue;
                        }
                      }
                    }
                    // Promote CSRF tokens to header
                    if (lk.includes("csrf") || lk.includes("xsrf")) {
                      authHeaders["x-csrf-token"] = value;
                    }
                  }

                  for (const [name, value] of Object.entries(meta ?? {})) {
                    const ln = name.toLowerCase();
                    if (ln.includes("csrf") || ln.includes("xsrf")) {
                      authHeaders["x-csrf-token"] = value;
                    }
                  }
                  return; // auth.json loaded successfully
                } catch { /* try vault fallback */ }
              }

              // Fallback: try loading from vault
              try {
                const { Vault } = await import("./src/vault.js");
                const vault = new Vault(vaultDbPath);
                const entry = vault.get(p.service);
                vault.close();
                if (entry) {
                  authHeaders = entry.headers ?? {};
                  cookies = entry.cookies ?? {};
                  baseUrl = entry.baseUrl ?? baseUrl;
                  // extra may contain localStorage/sessionStorage tokens
                  for (const [key, value] of Object.entries(entry.extra ?? {})) {
                    const lk = key.toLowerCase();
                    const v = String(value);
                    if (v.startsWith("eyJ") || /^Bearer\s/i.test(v)) {
                      const tokenValue = v.startsWith("eyJ") ? `Bearer ${v}` : v;
                      if (lk.includes("access") || lk.includes("auth") || lk.includes("token")) {
                        if (!authHeaders["authorization"]) {
                          authHeaders["authorization"] = tokenValue;
                        }
                      }
                    }
                    if (lk.includes("csrf") || lk.includes("xsrf")) {
                      authHeaders["x-csrf-token"] = v;
                    }
                  }
                  logger.info(`[unbrowse] Loaded auth from vault for ${p.service}`);
                }
              } catch { /* vault not available */ }

              // Fallback: try loading cookies from Chrome's cookie database
              if (Object.keys(cookies).length === 0) {
                try {
                  const { readChromeCookies, chromeCookiesAvailable } = await import("./src/chrome-cookies.js");
                  if (chromeCookiesAvailable()) {
                    const domain = new URL(baseUrl).hostname.replace(/^www\./, "");
                    const chromeCookies = readChromeCookies(domain);
                    if (Object.keys(chromeCookies).length > 0) {
                      cookies = chromeCookies;
                      logger.info(`[unbrowse] Loaded ${Object.keys(chromeCookies).length} cookies from Chrome for ${domain}`);
                    }
                  }
                } catch (err) {
                  // Chrome cookies not available — continue without
                }
              }
            }
            await loadAuth();

            // Parse endpoints from SKILL.md
            let endpoints: { method: string; path: string }[] = [];
            if (existsSync(skillMdPath)) {
              const md = readFileSync(skillMdPath, "utf-8");
              const re = /`(GET|POST|PUT|DELETE|PATCH)\s+([^`]+)`/g;
              let m;
              while ((m = re.exec(md)) !== null) {
                endpoints.push({ method: m[1], path: m[2] });
              }
            }

            if (p.endpoint) {
              const match = p.endpoint.match(/^(GET|POST|PUT|DELETE|PATCH)\s+(.+)$/i);
              if (match) {
                endpoints = [{ method: match[1].toUpperCase(), path: match[2] }];
              } else {
                endpoints = [{ method: "GET", path: p.endpoint }];
              }
            }

            if (endpoints.length === 0) {
              return { content: [{ type: "text", text: "No endpoints found. Provide endpoint param or check SKILL.md." }] };
            }

            // ── Execution strategies ────────────────────────────────────

            // Shared browser session — stays alive across all calls in a batch
            // so multi-step flows (auth → action → confirm) maintain session state.
            let chromeBrowser: any = null;
            let chromePage: any = null;

            async function getChromePage(): Promise<any | null> {
              if (chromePage) return chromePage;
              try {
                const { chromium } = await import("playwright");

                for (const port of [browserPort, 9222, 9229]) {
                  try {
                    const resp = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
                    if (!resp.ok) continue;
                    const data = await resp.json() as { webSocketDebuggerUrl?: string };
                    const wsUrl = data.webSocketDebuggerUrl ?? `http://127.0.0.1:${port}`;
                    chromeBrowser = await chromium.connectOverCDP(wsUrl, { timeout: 5000 });
                    break;
                  } catch { continue; }
                }

                if (!chromeBrowser) return null;

                const context = chromeBrowser.contexts()[0];
                if (!context) { await chromeBrowser.close(); chromeBrowser = null; return null; }

                // Inject stored cookies into the browser context
                if (Object.keys(cookies).length > 0) {
                  try {
                    const domain = new URL(baseUrl).hostname;
                    const cookieObjects = Object.entries(cookies).map(([name, value]) => ({
                      name, value, domain, path: "/",
                    }));
                    await context.addCookies(cookieObjects);
                  } catch { /* non-critical */ }
                }

                chromePage = context.pages()[0] ?? await context.newPage();

                // Inject localStorage/sessionStorage via addInitScript BEFORE navigation
                // This ensures tokens are set before any page JS runs (critical for SPAs)
                const hasStorage = Object.keys(storedLocalStorage).length > 0 || Object.keys(storedSessionStorage).length > 0;
                if (hasStorage) {
                  try {
                    await context.addInitScript(`
                        (function() {
                          const ls = ${JSON.stringify(storedLocalStorage)};
                          const ss = ${JSON.stringify(storedSessionStorage)};
                          for (const [k, v] of Object.entries(ls)) {
                            try { window.localStorage.setItem(k, v); } catch {}
                          }
                          for (const [k, v] of Object.entries(ss)) {
                            try { window.sessionStorage.setItem(k, v); } catch {}
                          }
                        })();
                      `);
                    logger.info(`[unbrowse] Injecting ${Object.keys(storedLocalStorage).length} localStorage + ${Object.keys(storedSessionStorage).length} sessionStorage tokens`);
                  } catch { /* addInitScript may fail on reused contexts — non-critical */ }
                }

                await chromePage.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => { });

                return chromePage;
              } catch {
                return null;
              }
            }

            async function cleanupChrome() {
              try { await chromeBrowser?.close(); } catch { /* ignore */ }
              chromeBrowser = null;
              chromePage = null;
            }

            async function execInChrome(ep: { method: string; path: string }, body?: string): Promise<{ status: number; ok: boolean; data?: string; isHtml?: boolean } | null> {
              const page = await getChromePage();
              if (!page) return null;

              try {
                const url = new URL(ep.path, baseUrl).toString();
                const fetchOpts: Record<string, unknown> = {
                  method: ep.method,
                  headers: { "Content-Type": "application/json", ...authHeaders },
                  credentials: "include",
                };
                if (body && ["POST", "PUT", "PATCH"].includes(ep.method)) {
                  fetchOpts.body = body;
                }

                return await page.evaluate(async ({ url, opts }: { url: string; opts: any }) => {
                  try {
                    const resp = await fetch(url, opts);
                    const text = await resp.text().catch(() => "");
                    return { status: resp.status, ok: resp.ok, data: text.slice(0, 2000) };
                  } catch (err) {
                    return { status: 0, ok: false, data: String(err) };
                  }
                }, { url, opts: fetchOpts });
              } catch {
                return null;
              }
            }

            // Response headers that should be captured and forwarded on subsequent requests.
            // Covers CSRF tokens, refreshed auth tokens, and custom session headers.
            const SESSION_HEADER_NAMES = new Set([
              "x-csrf-token", "x-xsrf-token", "csrf-token",
              "x-auth-token", "x-access-token", "authorization",
              "x-request-id", "x-session-id", "x-transaction-id",
            ]);

            async function execViaFetch(ep: { method: string; path: string }, body?: string): Promise<{ status: number; ok: boolean; data?: string; isHtml?: boolean }> {
              const url = new URL(ep.path, baseUrl).toString();
              const reqHeaders: Record<string, string> = { ...authHeaders, "Content-Type": "application/json" };
              if (Object.keys(cookies).length > 0) {
                reqHeaders["Cookie"] = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
              }
              const resp = await fetch(url, {
                method: ep.method,
                headers: reqHeaders,
                body: body && ["POST", "PUT", "PATCH"].includes(ep.method) ? body : undefined,
                redirect: "manual",
                signal: AbortSignal.timeout(10_000),
              });

              // Accumulate Set-Cookie headers so subsequent calls in the same
              // batch get session tokens set by earlier responses (CSRF, etc.)
              // Also respect expiry: Max-Age=0 or past Expires deletes the cookie.
              const setCookies = resp.headers.getSetCookie?.() ?? [];
              for (const sc of setCookies) {
                const nameVal = sc.match(/^([^=]+)=([^;]*)/);
                if (!nameVal) continue;
                const cookieName = nameVal[1].trim();
                const cookieValue = nameVal[2].trim();

                // Check for deletion signals
                const maxAgeMatch = sc.match(/Max-Age=(\d+)/i);
                const expiresMatch = sc.match(/Expires=([^;]+)/i);
                let expired = false;

                if (maxAgeMatch && parseInt(maxAgeMatch[1], 10) === 0) {
                  expired = true;
                } else if (expiresMatch) {
                  try {
                    expired = new Date(expiresMatch[1]).getTime() < Date.now();
                  } catch { /* keep it */ }
                }

                if (expired) {
                  delete cookies[cookieName];
                } else {
                  cookies[cookieName] = cookieValue;
                }
              }

              // Capture session/auth headers from responses — servers often return
              // refreshed tokens, CSRF tokens, or session IDs that must be sent on
              // subsequent requests in a multi-step flow.
              for (const [name, value] of resp.headers.entries()) {
                if (SESSION_HEADER_NAMES.has(name.toLowerCase())) {
                  authHeaders[name.toLowerCase()] = value;
                }
              }

              const text = await resp.text().catch(() => "");
              const ct = resp.headers.get("content-type") ?? "";
              const isHtml = ct.includes("text/html") || ct.includes("application/xhtml");
              return { status: resp.status, ok: resp.ok && !isHtml, data: text.slice(0, 2000), isHtml };
            }

            // ── Stealth browser execution (cloud browser with proxy) ───────
            // Shared stealth session — created once, reused for all calls in batch
            let stealthSession: StealthSession | null = null;
            let stealthBrowser: any = null;
            let stealthPage: any = null;

            async function getStealthPage(): Promise<any | null> {
              if (stealthPage) return stealthPage;
              if (!browserUseApiKey) return null;

              try {
                // Create stealth session if not exists
                if (!stealthSession) {
                  stealthSession = await createStealthSession(browserUseApiKey, {
                    timeout: 15, // 15 min for multi-call sessions
                    proxyCountryCode: p.proxyCountry ?? "us",
                  });
                  logger.info(`[unbrowse] Stealth session started: ${stealthSession.id} (proxy: ${p.proxyCountry ?? "us"})`);
                }

                // Connect browser if not connected
                if (!stealthBrowser) {
                  const { chromium } = await import("playwright");
                  stealthBrowser = await chromium.connectOverCDP(stealthSession.cdpUrl, { timeout: 15_000 });
                }

                const context = stealthBrowser.contexts()[0] ?? await stealthBrowser.newContext();

                // Inject cookies
                if (Object.keys(cookies).length > 0) {
                  const domain = new URL(baseUrl).hostname;
                  await context.addCookies(
                    Object.entries(cookies).map(([name, value]) => ({ name, value, domain, path: "/" }))
                  );
                }

                stealthPage = context.pages()[0] ?? await context.newPage();

                // Inject localStorage/sessionStorage via addInitScript BEFORE navigation
                if (Object.keys(storedLocalStorage).length > 0 || Object.keys(storedSessionStorage).length > 0) {
                  try {
                    await context.addInitScript(`
                        (function() {
                          const ls = ${JSON.stringify(storedLocalStorage)};
                          const ss = ${JSON.stringify(storedSessionStorage)};
                          for (const [k, v] of Object.entries(ls)) {
                            try { window.localStorage.setItem(k, v); } catch {}
                          }
                          for (const [k, v] of Object.entries(ss)) {
                            try { window.sessionStorage.setItem(k, v); } catch {}
                          }
                        })();
                      `);
                  } catch { /* non-critical */ }
                }

                // Navigate to base URL to establish session
                await stealthPage.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => { });

                return stealthPage;
              } catch (err) {
                logger.warn(`[unbrowse] Failed to get stealth page: ${(err as Error).message}`);
                return null;
              }
            }

            async function cleanupStealth() {
              try { await stealthBrowser?.close(); } catch { }
              if (stealthSession && browserUseApiKey) {
                try { await stopStealthSession(browserUseApiKey, stealthSession.id); } catch { }
                logger.info(`[unbrowse] Stealth session stopped: ${stealthSession.id}`);
              }
              stealthBrowser = null;
              stealthPage = null;
              stealthSession = null;
            }

            async function execViaStealth(ep: { method: string; path: string }, body?: string): Promise<{ status: number; ok: boolean; data?: string; isHtml?: boolean } | null> {
              const page = await getStealthPage();
              if (!page) return null;

              try {
                const url = new URL(ep.path, baseUrl).toString();
                const result = await page.evaluate(async ({ url, method, headers, body }: { url: string; method: string; headers: Record<string, string>; body?: string }) => {
                  try {
                    const resp = await fetch(url, {
                      method,
                      headers: { "Content-Type": "application/json", ...headers },
                      body: body && ["POST", "PUT", "PATCH"].includes(method) ? body : undefined,
                      credentials: "include",
                    });
                    const text = await resp.text().catch(() => "");
                    const ct = resp.headers.get("content-type") ?? "";
                    return {
                      status: resp.status,
                      ok: resp.ok,
                      data: text.slice(0, 2000),
                      isHtml: ct.includes("text/html"),
                    };
                  } catch (err) {
                    return { status: 0, ok: false, data: String(err), isHtml: false };
                  }
                }, { url, method: ep.method, headers: authHeaders, body });

                return result;
              } catch (err) {
                logger.warn(`[unbrowse] Stealth execution failed: ${(err as Error).message}`);
                return null;
              }
            }

            // ── Credential refresh on 401/403 ──────────────────────────

            let credsRefreshed = false;

            async function refreshCreds(): Promise<boolean> {
              if (credsRefreshed) return false; // only try once
              credsRefreshed = true;

              // Strategy 1: re-login if login config is stored
              if (loginConfig) {
                try {
                  const result = await loginAndCapture(loginConfig.loginUrl, {
                    formFields: loginConfig.formFields,
                    submitSelector: loginConfig.submitSelector,
                    headers: loginConfig.headers,
                    cookies: loginConfig.cookies,
                  }, {
                    browserUseApiKey,
                    captureUrls: loginConfig.captureUrls,
                  });

                  // Update in-memory creds
                  authHeaders = result.authHeaders;
                  cookies = result.cookies;

                  // Persist refreshed creds to auth.json
                  const { writeFileSync } = await import("node:fs");
                  const existing = existsSync(authPath)
                    ? JSON.parse(readFileSync(authPath, "utf-8"))
                    : {};
                  existing.headers = result.authHeaders;
                  existing.cookies = result.cookies;
                  existing.timestamp = new Date().toISOString();
                  existing.refreshedAt = new Date().toISOString();
                  writeFileSync(authPath, JSON.stringify(existing, null, 2), "utf-8");

                  return true;
                } catch {
                  // Re-login failed — try next strategy
                }
              }

              // Strategy 2: re-grab cookies via CDP connect (Chrome profile)
              try {
                const { chromium } = await import("playwright");
                let browser: any = null;
                for (const port of [browserPort, 9222, 9229]) {
                  try {
                    const resp = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
                    if (!resp.ok) continue;
                    const data = await resp.json() as { webSocketDebuggerUrl?: string };
                    const wsUrl = data.webSocketDebuggerUrl ?? `http://127.0.0.1:${port}`;
                    browser = await chromium.connectOverCDP(wsUrl, { timeout: 5000 });
                    break;
                  } catch { continue; }
                }

                if (browser) {
                  const context = browser.contexts()[0];
                  if (context) {
                    const page = context.pages()[0] ?? await context.newPage();
                    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => { });

                    const browserCookies = await context.cookies();
                    const freshCookies: Record<string, string> = {};
                    for (const c of browserCookies) {
                      freshCookies[c.name] = c.value;
                    }
                    await browser.close();

                    if (Object.keys(freshCookies).length > 0) {
                      cookies = freshCookies;

                      const { writeFileSync } = await import("node:fs");
                      const existing = existsSync(authPath)
                        ? JSON.parse(readFileSync(authPath, "utf-8"))
                        : {};
                      existing.cookies = freshCookies;
                      existing.timestamp = new Date().toISOString();
                      existing.refreshedAt = new Date().toISOString();
                      writeFileSync(authPath, JSON.stringify(existing, null, 2), "utf-8");

                      return true;
                    }
                  } else {
                    await browser.close();
                  }
                }
              } catch {
                // No browser available via CDP
              }

              return false;
            }

            // ── Execute endpoints ───────────────────────────────────────

            const results: string[] = [];
            let passed = 0;
            let failed = 0;

            const toTest = endpoints.slice(0, p.endpoint ? 1 : 10);
            results.push(`Executing ${p.service} (${toTest.length} endpoint${toTest.length > 1 ? "s" : ""})`, `Base: ${baseUrl}`, "");

            let usedStealth = false;

            for (const ep of toTest) {
              const body = p.body ?? (["POST", "PUT", "PATCH"].includes(ep.method) ? "{}" : undefined);
              let result: { status: number; ok: boolean; data?: string; isHtml?: boolean } | null = null;

              // If useStealth is explicitly requested, try stealth first
              if (p.useStealth) {
                result = await execViaStealth(ep, body);
                if (result && result.ok) {
                  results.push(`  ${ep.method} ${ep.path} → ${result.status} OK (stealth${p.proxyCountry ? ` via ${p.proxyCountry}` : ""})`);
                  if (p.endpoint && result.data) results.push(`  Response: ${result.data.slice(0, 500)}`);
                  passed++;
                  usedStealth = true;
                  continue;
                }
              }

              // Try 1: Chrome profile (live cookies)
              if (!p.useStealth) {
                result = await execInChrome(ep, body);
                if (result && result.ok) {
                  results.push(`  ${ep.method} ${ep.path} → ${result.status} OK (Chrome)`);
                  if (p.endpoint && result.data) results.push(`  Response: ${result.data.slice(0, 500)}`);
                  passed++;
                  continue;
                }
              }

              // Try 2: Direct fetch with stored auth
              if (!p.useStealth) {
                try {
                  result = await execViaFetch(ep, body);
                  if (result.isHtml) {
                    results.push(`  ${ep.method} ${ep.path} → ${result.status} (HTML page, not an API endpoint)`);
                    failed++;
                    continue;
                  }
                  if (result.ok) {
                    results.push(`  ${ep.method} ${ep.path} → ${result.status} OK (direct)`);
                    if (p.endpoint && result.data) results.push(`  Response: ${result.data.slice(0, 500)}`);
                    passed++;
                    continue;
                  }
                } catch { /* fall through */ }
              }

              // Try 3: If 401/403, refresh creds and retry
              const status = result?.status ?? 0;
              if ((status === 401 || status === 403) && !credsRefreshed) {
                results.push(`  ${ep.method} ${ep.path} → ${status} — refreshing credentials...`);
                const refreshed = await refreshCreds();
                if (refreshed) {
                  try {
                    result = await execViaFetch(ep, body);
                    if (result.ok) {
                      results.push(`  ${ep.method} ${ep.path} → ${result.status} OK (refreshed)`);
                      if (p.endpoint && result.data) results.push(`  Response: ${result.data.slice(0, 500)}`);
                      passed++;
                      continue;
                    }
                    results.push(`  ${ep.method} ${ep.path} → ${result.status} (still failed after refresh)`);
                  } catch {
                    results.push(`  ${ep.method} ${ep.path} → FAILED after refresh`);
                  }
                } else {
                  results.push(`  Credential refresh unavailable — use unbrowse_login to authenticate and store credentials for auto-refresh`);
                }
              }

              // Try 4: Stealth fallback for blocked requests (403, 429, connection errors)
              const blockedStatus = status === 403 || status === 429 || status === 0;
              if (blockedStatus && !p.useStealth && browserUseApiKey) {
                results.push(`  ${ep.method} ${ep.path} → ${status || "blocked"} — trying stealth browser...`);
                const stealthResult = await execViaStealth(ep, body);
                if (stealthResult && stealthResult.ok) {
                  results.push(`  ${ep.method} ${ep.path} → ${stealthResult.status} OK (stealth fallback)`);
                  if (p.endpoint && stealthResult.data) results.push(`  Response: ${stealthResult.data.slice(0, 500)}`);
                  passed++;
                  usedStealth = true;
                  continue;
                }
              }

              // All strategies failed
              results.push(`  ${ep.method} ${ep.path} → ${status || "FAILED"}`);
              failed++;
            }

            // Capture updated client-side state from the browser before cleanup
            if (chromePage) {
              try {
                const freshState = await chromePage.evaluate(() => {
                  const authKeywords = /token|auth|session|jwt|access|refresh|csrf|xsrf|key|cred|user|login|bearer/i;
                  const ls: Record<string, string> = {};
                  for (let i = 0; i < window.localStorage.length; i++) {
                    const key = window.localStorage.key(i);
                    if (key && authKeywords.test(key)) {
                      const val = window.localStorage.getItem(key);
                      if (val) ls[key] = val;
                    }
                  }
                  const ss: Record<string, string> = {};
                  for (let i = 0; i < window.sessionStorage.length; i++) {
                    const key = window.sessionStorage.key(i);
                    if (key && authKeywords.test(key)) {
                      const val = window.sessionStorage.getItem(key);
                      if (val) ss[key] = val;
                    }
                  }
                  return { localStorage: ls, sessionStorage: ss };
                });
                storedLocalStorage = { ...storedLocalStorage, ...freshState.localStorage };
                storedSessionStorage = { ...storedSessionStorage, ...freshState.sessionStorage };
              } catch { /* page may be gone */ }
            }

            // Clean up browser sessions after capturing state
            await cleanupChrome();
            await cleanupStealth();

            // Persist accumulated cookies + headers + storage back to auth.json so the
            // next unbrowse_replay call (or credential refresh) picks them up.
            // This keeps the session alive across separate tool calls.
            try {
              const { writeFileSync } = await import("node:fs");
              const existing = existsSync(authPath)
                ? JSON.parse(readFileSync(authPath, "utf-8"))
                : {};
              existing.headers = authHeaders;
              existing.cookies = cookies;
              existing.baseUrl = baseUrl;
              existing.localStorage = storedLocalStorage;
              existing.sessionStorage = storedSessionStorage;
              existing.lastReplayAt = new Date().toISOString();
              if (loginConfig) existing.loginConfig = loginConfig;
              writeFileSync(authPath, JSON.stringify(existing, null, 2), "utf-8");
            } catch {
              // Non-critical — session still worked in-memory
            }

            results.push("", `Results: ${passed} passed, ${failed} failed`);
            if (usedStealth) {
              results.push(`Used stealth cloud browser${p.proxyCountry ? ` (proxy: ${p.proxyCountry})` : ""}`);
            }
            if (credsRefreshed) {
              results.push(`Credentials were refreshed and saved to auth.json`);
            }
            if (failed > 0 && !credsRefreshed && !loginConfig && !usedStealth) {
              results.push(`Tip: use useStealth=true to bypass anti-bot protection, or unbrowse_login to store credentials`);
            }
            return { content: [{ type: "text", text: results.join("\n") }] };
          },
        },

        // ── unbrowse_stealth ────────────────────────────────────────
        {
          name: "unbrowse_stealth",
          label: "Stealth Browser",
          description:
            "Launch a stealth cloud browser that bypasses anti-bot detection, CAPTCHAs, " +
            "and geo-restrictions. Returns a CDP URL for automation and a live viewing URL. " +
            "Use action=start to launch, action=capture to grab traffic and generate a skill, " +
            "action=stop to end the session. Costs $0.06/hour.",
          parameters: STEALTH_SCHEMA,
          async execute(_toolCallId: string, params: unknown) {
            const p = params as {
              action: "start" | "stop" | "capture" | "status";
              url?: string;
              timeout?: number;
              proxyCountry?: string;
              sessionId?: string;
            };

            if (!browserUseApiKey) {
              return { content: [{ type: "text", text: "Stealth browser not configured. Set browserUseApiKey in unbrowse plugin config." }] };
            }

            switch (p.action) {
              case "start": {
                try {
                  const session = await createStealthSession(browserUseApiKey, {
                    timeout: p.timeout ?? 15,
                    proxyCountryCode: p.proxyCountry,
                  });

                  stealthSessions.set(session.id, session);

                  const lines = [
                    `Stealth browser launched`,
                    `Session: ${session.id}`,
                    `CDP URL: ${session.cdpUrl}`,
                    `Live view: ${session.liveUrl}`,
                    `Timeout: ${p.timeout ?? 15} minutes`,
                    "",
                    `Connect via Playwright:`,
                    `  const browser = await chromium.connectOverCDP("${session.cdpUrl}");`,
                    "",
                    `Use action=capture with sessionId=${session.id} to grab traffic.`,
                    `Use action=stop with sessionId=${session.id} to end session.`,
                  ];

                  if (p.proxyCountry) lines.splice(4, 0, `Proxy: ${p.proxyCountry}`);

                  logger.info(`[unbrowse] Stealth session started: ${session.id}`);
                  return { content: [{ type: "text", text: lines.join("\n") }] };
                } catch (err) {
                  return { content: [{ type: "text", text: `Failed to start stealth browser: ${(err as Error).message}` }] };
                }
              }

              case "stop": {
                if (!p.sessionId) {
                  return { content: [{ type: "text", text: "Provide sessionId to stop." }] };
                }
                try {
                  await stopStealthSession(browserUseApiKey, p.sessionId);
                  stealthSessions.delete(p.sessionId);
                  logger.info(`[unbrowse] Stealth session stopped: ${p.sessionId}`);
                  return { content: [{ type: "text", text: `Session ${p.sessionId} stopped.` }] };
                } catch (err) {
                  return { content: [{ type: "text", text: `Failed to stop: ${(err as Error).message}` }] };
                }
              }

              case "capture": {
                if (!p.sessionId) {
                  return { content: [{ type: "text", text: "Provide sessionId to capture from." }] };
                }

                const session = stealthSessions.get(p.sessionId);
                if (!session) {
                  // Try to fetch it
                  try {
                    const s = await getStealthSession(browserUseApiKey, p.sessionId);
                    if (s.status !== "active") {
                      return { content: [{ type: "text", text: `Session ${p.sessionId} is ${s.status}.` }] };
                    }
                    stealthSessions.set(s.id, s);
                  } catch {
                    return { content: [{ type: "text", text: `Session ${p.sessionId} not found.` }] };
                  }
                }

                const cdpUrl = (stealthSessions.get(p.sessionId))?.cdpUrl;
                if (!cdpUrl) {
                  return { content: [{ type: "text", text: "No CDP URL for this session." }] };
                }

                try {
                  // If a URL was provided, navigate via Playwright while capturing
                  // traffic in real-time (captureFromStealth only gets future events).
                  if (p.url) {
                    try {
                      const { chromium } = await import("playwright");
                      const remoteBrowser = await chromium.connectOverCDP(cdpUrl, { timeout: 10_000 });
                      const ctx = remoteBrowser.contexts()[0] ?? await remoteBrowser.newContext();

                      // Set up capture listeners BEFORE navigation
                      const captured: Array<{ method: string; url: string; headers: Record<string, string>; resourceType: string; status: number; responseHeaders: Record<string, string>; timestamp: number }> = [];
                      const pending = new Map<string, any>();
                      for (const pg of ctx.pages()) {
                        pg.on("request", (req: any) => { pending.set(req.url() + req.method(), { method: req.method(), url: req.url(), headers: req.headers(), resourceType: req.resourceType(), timestamp: Date.now() }); });
                        pg.on("response", (resp: any) => { const k = resp.request().url() + resp.request().method(); const e = pending.get(k); if (e) { e.status = resp.status(); e.responseHeaders = resp.headers(); captured.push(e); pending.delete(k); } });
                      }
                      ctx.on("page", (pg: any) => {
                        pg.on("request", (req: any) => { pending.set(req.url() + req.method(), { method: req.method(), url: req.url(), headers: req.headers(), resourceType: req.resourceType(), timestamp: Date.now() }); });
                        pg.on("response", (resp: any) => { const k = resp.request().url() + resp.request().method(); const e = pending.get(k); if (e) { e.status = resp.status(); e.responseHeaders = resp.headers(); captured.push(e); pending.delete(k); } });
                      });

                      const navPage = ctx.pages()[0] ?? await ctx.newPage();
                      await navPage.goto(p.url, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => { });
                      await navPage.waitForTimeout(3000);

                      // Extract cookies
                      const browserCookies = await ctx.cookies().catch(() => []);
                      const cookieMap: Record<string, string> = {};
                      for (const c of browserCookies) cookieMap[c.name] = c.value;

                      await remoteBrowser.close();

                      if (captured.length > 0) {
                        // Build HAR from Playwright-captured traffic
                        const harEntries = captured
                          .filter(e => e.resourceType === "xhr" || e.resourceType === "fetch" || e.method !== "GET")
                          .map(e => ({
                            request: {
                              method: e.method,
                              url: e.url,
                              headers: Object.entries(e.headers).map(([name, value]) => ({ name, value })),
                              cookies: Object.entries(cookieMap).map(([name, value]) => ({ name, value })),
                            },
                            response: {
                              status: e.status ?? 0,
                              headers: Object.entries(e.responseHeaders ?? {}).map(([name, value]) => ({ name, value })),
                            },
                            time: e.timestamp,
                          }));

                        const har = { log: { entries: harEntries } };
                        const apiData = parseHar(har as any, p.url);
                        for (const [name, value] of Object.entries(cookieMap)) {
                          if (!apiData.cookies[name]) apiData.cookies[name] = value;
                        }
                        const result = await generateSkill(apiData, defaultOutputDir);
                        discovery.markLearned(result.service);

                        // Detect and save refresh token config
                        detectAndSaveRefreshConfig(harEntries, join(result.skillDir, "auth.json"), logger);

                        let publishedVersion: string | null = null;
                        if (result.changed) {
                          publishedVersion = await autoPublishSkill(result.service, result.skillDir);
                        }

                        const summaryLines = [
                          `Stealth capture: ${captured.length} requests (${harEntries.length} API)`,
                          `Skill: ${result.service}`,
                          `Auth: ${result.authMethod}`,
                          `Endpoints: ${result.endpointCount}`,
                        ];
                        if (result.diff) summaryLines.push(`Changes: ${result.diff}`);
                        summaryLines.push(
                          `Auth headers: ${result.authHeaderCount} | Cookies: ${result.cookieCount}`,
                          `Installed: ${result.skillDir}`,
                        );
                        if (publishedVersion) summaryLines.push(`Published: ${publishedVersion}`);

                        return { content: [{ type: "text", text: summaryLines.join("\n") }] };
                      }
                    } catch {
                      // Playwright navigation failed — fall back to CDP capture
                    }
                  }

                  // Fallback: CDP-only capture (only gets future traffic after Network.enable)
                  const { har, entries } = await captureFromStealth(cdpUrl);

                  if (entries.length === 0) {
                    return { content: [{ type: "text", text: "No requests captured from stealth browser. Navigate to pages first, or provide url param." }] };
                  }

                  const apiData = parseHar(har, p.url);
                  const result = await generateSkill(apiData, defaultOutputDir);
                  discovery.markLearned(result.service);

                  // Detect and save refresh token config
                  detectAndSaveRefreshConfig(har.log?.entries ?? [], join(result.skillDir, "auth.json"), logger);

                  // Auto-publish if skill content changed
                  let publishedVersion: string | null = null;
                  if (result.changed) {
                    publishedVersion = await autoPublishSkill(result.service, result.skillDir);
                  }

                  const summaryLines = [
                    `Stealth capture: ${entries.length} requests`,
                    `Skill: ${result.service}`,
                    `Auth: ${result.authMethod}`,
                    `Endpoints: ${result.endpointCount}`,
                  ];
                  if (result.diff) {
                    summaryLines.push(`Changes: ${result.diff}`);
                  }
                  summaryLines.push(`Installed: ${result.skillDir}`);
                  if (publishedVersion) {
                    summaryLines.push(`Published: ${publishedVersion} (auto-synced to cloud index)`);
                  }
                  const summary = summaryLines.join("\n");

                  logger.info(`[unbrowse] Stealth capture → ${result.service}`);
                  return { content: [{ type: "text", text: summary }] };
                } catch (err) {
                  return { content: [{ type: "text", text: `Stealth capture failed: ${(err as Error).message}` }] };
                }
              }

              case "status": {
                if (p.sessionId) {
                  try {
                    const s = await getStealthSession(browserUseApiKey, p.sessionId);
                    return { content: [{ type: "text", text: `Session ${s.id}: ${s.status}\nCDP: ${s.cdpUrl}\nLive: ${s.liveUrl}` }] };
                  } catch (err) {
                    return { content: [{ type: "text", text: `Status failed: ${(err as Error).message}` }] };
                  }
                }

                // List all active sessions
                const lines = [`Active stealth sessions: ${stealthSessions.size}`];
                for (const [id, s] of stealthSessions) {
                  lines.push(`  ${id}: ${s.status} — ${s.liveUrl}`);
                }
                return { content: [{ type: "text", text: lines.join("\n") }] };
              }

              default:
                return { content: [{ type: "text", text: `Unknown action: ${p.action}. Use start, stop, capture, or status.` }] };
            }
          },
        },

        // ── unbrowse_skills ─────────────────────────────────────────
        {
          name: "unbrowse_skills",
          label: "List Skills",
          description:
            "List all discovered and generated skills (API integrations, workflows, libraries). " +
            "Shows service name, endpoint count, and auth method for each.",
          parameters: SKILLS_SCHEMA,
          async execute() {
            const skills: string[] = [];

            try {
              if (existsSync(defaultOutputDir)) {
                const entries = readdirSync(defaultOutputDir, { withFileTypes: true });
                for (const entry of entries) {
                  if (!entry.isDirectory()) continue;
                  const skillMd = join(defaultOutputDir, entry.name, "SKILL.md");
                  const authJson = join(defaultOutputDir, entry.name, "auth.json");

                  if (!existsSync(skillMd)) continue;

                  let authMethod = "unknown";
                  let endpointCount = 0;
                  let baseUrl = "";

                  if (existsSync(authJson)) {
                    try {
                      const auth = JSON.parse(readFileSync(authJson, "utf-8"));
                      authMethod = auth.authMethod ?? "unknown";
                      baseUrl = auth.baseUrl ?? "";
                    } catch { /* skip */ }
                  }

                  // Count endpoints from SKILL.md
                  const md = readFileSync(skillMd, "utf-8");
                  const matches = md.match(/`(GET|POST|PUT|DELETE|PATCH)\s+[^`]+`/g);
                  endpointCount = matches?.length ?? 0;

                  skills.push(`  ${entry.name} — ${endpointCount} endpoints, ${authMethod}${baseUrl ? ` (${baseUrl})` : ""}`);
                }
              }
            } catch { /* dir doesn't exist */ }

            // Wallet funding prompt
            const walletNote = creatorWallet && !solanaPrivateKey
              ? `\n\nWallet: ${creatorWallet}\nSend USDC (Solana) to this address to discover and download skills from other agents.`
              : creatorWallet
                ? `\n\nWallet: ${creatorWallet} (ready for marketplace)`
                : "";

            if (skills.length === 0) {
              return { content: [{ type: "text", text: `No skills discovered yet. Use unbrowse_learn, unbrowse_capture, or browse APIs to auto-discover.${walletNote}` }] };
            }

            const autoLabel = autoDiscoverEnabled ? " (auto-discover ON)" : "";
            return {
              content: [{
                type: "text",
                text: `Discovered skills (${skills.length})${autoLabel}:\n${skills.join("\n")}${walletNote}`,
              }],
            };
          },
        },

        // ── unbrowse_publish ───────────────────────────────────────────
        {
          name: "unbrowse_publish",
          label: "Publish Skill",
          description:
            "Publish a skill to the cloud marketplace. " +
            "Publishes the skill definition (endpoints, auth method, base URL, docs). " +
            "Credentials stay local. Your wallet address is embedded for x402 profit sharing. " +
            "Works for API skills, library integrations, workflows, or any reusable agent knowledge.",
          parameters: PUBLISH_SCHEMA,
          async execute(_toolCallId: string, params: unknown) {
            const p = params as { service: string; skillsDir?: string };

            if (!creatorWallet) {
              return {
                content: [{
                  type: "text",
                  text: "No creator wallet configured. Set creatorWallet in unbrowse plugin config or UNBROWSE_CREATOR_WALLET env var (Solana address).",
                }],
              };
            }

            const skillsDir = p.skillsDir ?? defaultOutputDir;
            const skillDir = join(skillsDir, p.service);
            const skillMdPath = join(skillDir, "SKILL.md");
            const authJsonPath = join(skillDir, "auth.json");
            const apiTsPath = join(skillDir, "scripts", "api.ts");

            if (!existsSync(skillMdPath)) {
              return { content: [{ type: "text", text: `Skill not found: ${skillDir}. Generate it first with unbrowse_learn or unbrowse_capture.` }] };
            }

            try {
              const skillMd = readFileSync(skillMdPath, "utf-8");
              const endpoints = extractEndpoints(skillMd);

              let baseUrl = "";
              let authMethodType = "Unknown";

              if (existsSync(authJsonPath)) {
                const authStr = readFileSync(authJsonPath, "utf-8");
                const pub = extractPublishableAuth(authStr);
                baseUrl = pub.baseUrl;
                authMethodType = pub.authMethodType;
              }

              let apiTemplate = "";
              if (existsSync(apiTsPath)) {
                apiTemplate = sanitizeApiTemplate(readFileSync(apiTsPath, "utf-8"));
              }

              const payload: PublishPayload = {
                service: p.service,
                baseUrl,
                authMethodType,
                endpoints,
                skillMd,
                apiTemplate,
                creatorWallet,
              };

              const result = await indexClient.publish(payload);

              const summary = [
                `Skill published to cloud index`,
                `Service: ${p.service}`,
                `ID: ${result.id}`,
                `Slug: ${result.slug}`,
                `Version: ${result.version}`,
                `Endpoints: ${endpoints.length}`,
                `Creator wallet: ${creatorWallet}`,
                ``,
                `Others can find and download this skill via unbrowse_search.`,
                `You earn USDC for each download via x402.`,
              ].join("\n");

              logger.info(`[unbrowse] Published: ${p.service} → ${result.id}`);
              return { content: [{ type: "text", text: summary }] };
            } catch (err) {
              return { content: [{ type: "text", text: `Publish failed: ${(err as Error).message}` }] };
            }
          },
        },

        // ── unbrowse_search ────────────────────────────────────────────
        {
          name: "unbrowse_search",
          label: "Search & Install Skills",
          description:
            "Search the cloud skill marketplace for skills discovered by other agents. " +
            "Covers API integrations, library wrappers, workflows, and agent knowledge. " +
            "Searching is free. Installing costs $0.01 USDC via x402. " +
            "Use query to search, install to download and install a specific skill by ID.",
          parameters: SEARCH_SCHEMA,
          async execute(_toolCallId: string, params: unknown) {
            const p = params as { query?: string; tags?: string; install?: string };

            // ── Install mode ──
            if (p.install) {
              try {
                const pkg = await indexClient.download(p.install);

                // Save locally
                const skillDir = join(defaultOutputDir, pkg.service);
                const scriptsDir = join(skillDir, "scripts");
                const { mkdirSync, writeFileSync } = await import("node:fs");
                mkdirSync(scriptsDir, { recursive: true });

                writeFileSync(join(skillDir, "SKILL.md"), pkg.skillMd, "utf-8");
                writeFileSync(join(scriptsDir, "api.ts"), pkg.apiTemplate, "utf-8");

                // Create placeholder auth.json — user adds their own credentials
                writeFileSync(join(skillDir, "auth.json"), JSON.stringify({
                  service: pkg.service,
                  baseUrl: pkg.baseUrl,
                  authMethod: pkg.authMethodType,
                  timestamp: new Date().toISOString(),
                  notes: ["Downloaded from skill index — add your own auth credentials"],
                  headers: {},
                  cookies: {},
                }, null, 2), "utf-8");

                discovery.markLearned(pkg.service);

                const summary = [
                  `Skill installed: ${pkg.service}`,
                  `Location: ${skillDir}`,
                  `Endpoints: ${pkg.endpoints.length}`,
                  `Auth: ${pkg.authMethodType}`,
                  `Payment: $0.01 USDC on Base via x402`,
                  ``,
                  `Add your auth credentials to auth.json or use unbrowse_auth to extract from browser.`,
                ].join("\n");

                logger.info(`[unbrowse] Installed from index: ${pkg.service}`);
                return { content: [{ type: "text", text: summary }] };
              } catch (err) {
                const msg = (err as Error).message;
                // If payment failed due to missing key or insufficient funds, prompt to fund wallet
                if (msg.includes("private key") || msg.includes("x402") || msg.includes("payment")) {
                  const fundingHint = creatorWallet
                    ? `\n\nYour wallet: ${creatorWallet}\nSend USDC (Solana SPL) to this address to fund skill downloads ($0.01/skill).`
                    : '\n\nNo wallet configured. Use unbrowse_wallet with action="setup" to generate one.';
                  return { content: [{ type: "text", text: `Install failed: ${msg}${fundingHint}` }] };
                }
                return { content: [{ type: "text", text: `Install failed: ${msg}` }] };
              }
            }

            // ── Search mode ──
            if (!p.query) {
              return { content: [{ type: "text", text: "Provide a query to search, or install=<id> to download a skill." }] };
            }

            try {
              const results = await indexClient.search(p.query, {
                tags: p.tags,
                limit: 10,
              });

              if (results.skills.length === 0) {
                return { content: [{ type: "text", text: `No skills found for "${p.query}". Try different keywords.` }] };
              }

              const lines = [
                `Cloud Skills (${results.total} results for "${p.query}"):`,
                "",
              ];

              for (const skill of results.skills) {
                const tags = skill.tags.length > 0 ? ` | Tags: ${skill.tags.join(", ")}` : "";
                lines.push(
                  `  ${skill.service} — ${skill.endpointCount} endpoints, ${skill.authMethodType} (${skill.baseUrl})`,
                  `    ID: ${skill.id} | Downloads: ${skill.downloadCount}${tags}`,
                );
              }

              lines.push("", `Use unbrowse_search with install="<id>" to download and install ($0.01 USDC).`);

              if (creatorWallet) {
                lines.push(`\nYour wallet: ${creatorWallet}`);
                if (!solanaPrivateKey) {
                  lines.push("Send USDC (Solana SPL) to this address to fund skill downloads.");
                }
              }

              return { content: [{ type: "text", text: lines.join("\n") }] };
            } catch (err) {
              return { content: [{ type: "text", text: `Search failed: ${(err as Error).message}` }] };
            }
          },
        },
        // ── unbrowse_login ─────────────────────────────────────────────
        {
          name: "unbrowse_login",
          label: "Login & Capture Session",
          description:
            "Log in to a website with credentials and capture the session (cookies, auth headers, API traffic). " +
            "Works in Docker/cloud where there's no Chrome profile. Uses stealth cloud browser (BrowserBase) " +
            "if configured, otherwise local Playwright. Provide form fields to auto-fill login forms, " +
            "or inject headers/cookies directly. If no credentials are provided and a credential source " +
            "is configured (keychain, 1password, vault), credentials are auto-looked up by domain. " +
            "Captured session is saved to auth.json for the skill.",
          parameters: LOGIN_SCHEMA,
          async execute(_toolCallId: string, params: unknown) {
            const p = params as {
              loginUrl: string;
              service?: string;
              formFields?: Record<string, string>;
              submitSelector?: string;
              headers?: Record<string, string>;
              cookies?: Array<{ name: string; value: string; domain: string }>;
              captureUrls?: string[];
              proxyCountry?: string;
              autoFillFromProvider?: boolean;
              saveCredentials?: boolean;
            };

            // Derive service name from URL if not provided
            let service = p.service;
            if (!service) {
              try {
                const host = new URL(p.loginUrl).hostname;
                service = host
                  .replace(/^(www|api|app|auth|login)\./, "")
                  .replace(/\.(com|io|org|net|dev|co|ai)$/, "")
                  .replace(/\./g, "-");
              } catch {
                return { content: [{ type: "text", text: "Invalid login URL." }] };
              }
            }

            // ── Credential auto-lookup ──────────────────────────────────
            // If no formFields provided and credential provider is configured,
            // try to look up login credentials automatically.
            let resolvedFormFields = p.formFields;
            let credentialUsed: LoginCredential | null = null;
            const shouldAutoFill = p.autoFillFromProvider !== false && !p.formFields && credentialProvider;

            if (shouldAutoFill && credentialProvider) {
              try {
                const available = await credentialProvider.isAvailable();
                if (available) {
                  const cred = await lookupCredentials(credentialProvider, p.loginUrl);
                  if (cred) {
                    resolvedFormFields = buildFormFields(cred);
                    credentialUsed = cred;
                    logger.info(`[unbrowse] Auto-filled credentials from ${cred.source}: ${cred.label}`);
                  } else {
                    logger.info(`[unbrowse] No credentials found in ${credentialProvider.name} for ${p.loginUrl}`);
                  }
                } else {
                  logger.info(`[unbrowse] Credential provider ${credentialProvider.name} not available`);
                }
              } catch (err) {
                logger.warn(`[unbrowse] Credential lookup failed: ${(err as Error).message}`);
              }
            }

            const credentials: LoginCredentials = {
              formFields: resolvedFormFields,
              submitSelector: p.submitSelector,
              headers: p.headers,
              cookies: p.cookies,
            };

            try {
              const result = await loginAndCapture(p.loginUrl, credentials, {
                browserUseApiKey,
                captureUrls: p.captureUrls,
                waitMs: 5000,
                proxyCountry: p.proxyCountry,
              });

              // Save auth.json
              const { mkdirSync, writeFileSync } = await import("node:fs");
              const skillDir = join(defaultOutputDir, service);
              mkdirSync(join(skillDir, "scripts"), { recursive: true });

              const authData: Record<string, unknown> = {
                service,
                baseUrl: result.baseUrl,
                authMethod: Object.keys(result.authHeaders).length > 0 ? "header" : "cookie",
                timestamp: new Date().toISOString(),
                headers: result.authHeaders,
                cookies: result.cookies,
                // Client-side auth state (SPAs store JWTs in storage, CSRF in meta tags)
                localStorage: result.localStorage,
                sessionStorage: result.sessionStorage,
                metaTokens: result.metaTokens,
              };

              // Store login config so replay can re-login when creds expire
              if (p.formFields || p.headers || p.cookies) {
                authData.loginConfig = {
                  loginUrl: p.loginUrl,
                  ...(p.formFields ? { formFields: p.formFields } : {}),
                  ...(p.submitSelector ? { submitSelector: p.submitSelector } : {}),
                  ...(p.headers ? { headers: p.headers } : {}),
                  ...(p.cookies ? { cookies: p.cookies } : {}),
                  ...(p.captureUrls ? { captureUrls: p.captureUrls } : {}),
                };
              }
              writeFileSync(join(skillDir, "auth.json"), JSON.stringify(authData, null, 2), "utf-8");

              // If we captured enough API traffic, generate a skill too
              let skillGenerated = false;
              if (result.requestCount > 5) {
                try {
                  const apiData = parseHar(result.har, p.loginUrl);
                  // Merge captured cookies into apiData
                  for (const [name, value] of Object.entries(result.cookies)) {
                    if (!apiData.cookies[name]) apiData.cookies[name] = value;
                  }
                  await generateSkill(apiData, defaultOutputDir);
                  discovery.markLearned(service);
                  skillGenerated = true;

                  // Detect and save refresh token config
                  detectAndSaveRefreshConfig(result.har.log?.entries ?? [], join(skillDir, "auth.json"), logger);
                } catch {
                  // Skill generation is optional — session capture is the main goal
                }
              }

              // Save credentials to vault if requested and provider supports it
              if (credentialUsed && p.saveCredentials !== false && credentialProvider?.name === "vault" && credentialProvider.store) {
                try {
                  const hostname = new URL(p.loginUrl).hostname;
                  await credentialProvider.store(hostname, credentialUsed.username, credentialUsed.password);
                  logger.info(`[unbrowse] Saved login credentials to vault for ${hostname}`);
                } catch {
                  // Non-critical — skip
                }
              }

              const backend = browserUseApiKey ? "stealth cloud (BrowserBase)" : "local Playwright";
              const cookieCount = Object.keys(result.cookies).length;
              const authHeaderCount = Object.keys(result.authHeaders).length;
              const lsCount = Object.keys(result.localStorage).length;
              const ssCount = Object.keys(result.sessionStorage).length;
              const metaCount = Object.keys(result.metaTokens).length;
              const hasAnyAuth = cookieCount > 0 || authHeaderCount > 0 || lsCount > 0 || ssCount > 0;

              // Also store the captured session auth in the vault (independent of credential provider)
              // This stores cookies/headers/tokens for API replay even without login credentials
              if (p.saveCredentials !== false && hasAnyAuth) {
                try {
                  const { Vault } = await import("./src/vault.js");
                  const vault = new Vault(vaultDbPath);
                  vault.store(service, {
                    baseUrl: result.baseUrl,
                    authMethod: authHeaderCount > 0 ? "header" : "cookie",
                    headers: result.authHeaders,
                    cookies: result.cookies,
                    extra: {
                      ...result.localStorage,
                      ...result.sessionStorage,
                      ...result.metaTokens,
                    },
                    notes: `Captured via unbrowse_login at ${new Date().toISOString()}`,
                  });
                  vault.close();
                  logger.info(`[unbrowse] Stored session auth in vault for ${service}`);
                } catch (vaultErr) {
                  // Vault may not be initialized — non-critical
                  logger.warn(`[unbrowse] Could not store in vault: ${(vaultErr as Error).message}`);
                }
              }
              const summary = [
                `Session captured via ${backend}`,
                `Service: ${service}`,
                credentialUsed ? `Credentials: auto-filled from ${credentialUsed.source} (${credentialUsed.label})` : "",
                `Cookies: ${cookieCount}`,
                `Auth headers: ${authHeaderCount}`,
                lsCount > 0 ? `localStorage tokens: ${lsCount} (${Object.keys(result.localStorage).join(", ")})` : "",
                ssCount > 0 ? `sessionStorage tokens: ${ssCount}` : "",
                metaCount > 0 ? `Meta tokens: ${metaCount} (${Object.keys(result.metaTokens).join(", ")})` : "",
                `Network requests: ${result.requestCount}`,
                `Base URL: ${result.baseUrl}`,
                `Auth saved: ${join(skillDir, "auth.json")}`,
                skillGenerated ? `Skill generated with ${result.requestCount} captured requests` : "",
                !hasAnyAuth ? `WARNING: No auth state captured (0 cookies, 0 headers, 0 tokens). Login may have failed — check form selectors or try different selectors.` : "",
                "",
                hasAnyAuth
                  ? `The session is ready. Use unbrowse_replay to execute API calls with these credentials.`
                  : `No credentials captured. Try re-running with correct form field selectors, or use unbrowse_capture after manually logging in via the browser.`,
                !skillGenerated && (p.captureUrls?.length ?? 0) === 0
                  ? `Tip: add captureUrls to visit authenticated pages and auto-generate a skill.`
                  : "",
                !credentialUsed && !p.formFields && credentialProvider == null
                  ? `Tip: set credentialSource in config to "keychain" or "1password" for auto-login next time.`
                  : "",
              ].filter(Boolean).join("\n");

              logger.info(`[unbrowse] Login capture → ${service} (${Object.keys(result.cookies).length} cookies, ${result.requestCount} requests)`);
              return { content: [{ type: "text", text: summary }] };
            } catch (err) {
              const msg = (err as Error).message;
              if (msg.includes("playwright")) {
                return { content: [{ type: "text", text: `Playwright not available: ${msg}. Install with: bun add playwright` }] };
              }
              if (msg.includes("Browser Use")) {
                return { content: [{ type: "text", text: `Stealth browser failed: ${msg}. Check browserUseApiKey config or try without it.` }] };
              }
              return { content: [{ type: "text", text: `Login capture failed: ${msg}` }] };
            }
          },
        },

        // ── unbrowse_wallet ────────────────────────────────────────────
        {
          name: "unbrowse_wallet",
          label: "Wallet Setup",
          description:
            "Manage your Solana wallet for skill marketplace payments. " +
            "Check status, auto-generate a keypair, or set wallet addresses. " +
            "The wallet earns USDC when others download your published skills, " +
            "and pays USDC to download/discover skills from others.",
          parameters: WALLET_SCHEMA,
          async execute(_toolCallId: string, params: unknown) {
            const p = params as { action?: string; wallet?: string; privateKey?: string };
            const action = p.action ?? "status";

            if (action === "setup") {
              if (creatorWallet && solanaPrivateKey) {
                return {
                  content: [{
                    type: "text",
                    text: `Wallet already configured.\nCreator (earning): ${creatorWallet}\nPayer (spending): configured\n\nUse action="status" to check balances.`,
                  }],
                };
              }

              try {
                await ensureWallet();
                return {
                  content: [{
                    type: "text",
                    text: [
                      "Solana wallet generated and saved to config.",
                      `Address: ${creatorWallet}`,
                      "",
                      "Fund this address with USDC to:",
                      "  - Download and discover skills from the marketplace ($0.01/skill)",
                      "  - Earn USDC when others download your published skills",
                      "",
                      "Send USDC (SPL) to this Solana address to get started.",
                    ].join("\n"),
                  }],
                };
              } catch (err) {
                return { content: [{ type: "text", text: `Wallet setup failed: ${(err as Error).message}` }] };
              }
            }

            if (action === "set_creator") {
              if (!p.wallet) {
                return { content: [{ type: "text", text: "Provide wallet= with a Solana address." }] };
              }
              try {
                const currentConfig = await api.runtime.config.loadConfig();
                const pluginEntries = (currentConfig as any).plugins?.entries ?? {};
                const unbrowseEntry = pluginEntries.unbrowse ?? {};
                const unbrowseConfig = unbrowseEntry.config ?? {};
                unbrowseConfig.creatorWallet = p.wallet;
                unbrowseEntry.config = unbrowseConfig;
                pluginEntries.unbrowse = unbrowseEntry;
                (currentConfig as any).plugins = { ...(currentConfig as any).plugins, entries: pluginEntries };
                await api.runtime.config.writeConfigFile(currentConfig);
                creatorWallet = p.wallet;
                indexOpts.creatorWallet = p.wallet;
                return { content: [{ type: "text", text: `Creator wallet set: ${p.wallet}\nYou'll earn USDC when others download your published skills.` }] };
              } catch (err) {
                return { content: [{ type: "text", text: `Failed to save: ${(err as Error).message}` }] };
              }
            }

            if (action === "set_payer") {
              if (!p.privateKey) {
                return { content: [{ type: "text", text: "Provide privateKey= with a base58-encoded Solana private key." }] };
              }
              try {
                // Validate the key
                const { Keypair } = await import("@solana/web3.js");
                const bs58 = await import("bs58");
                const keypair = Keypair.fromSecretKey(bs58.default.decode(p.privateKey));
                const publicKey = keypair.publicKey.toBase58();

                const currentConfig = await api.runtime.config.loadConfig();
                const pluginEntries = (currentConfig as any).plugins?.entries ?? {};
                const unbrowseEntry = pluginEntries.unbrowse ?? {};
                const unbrowseConfig = unbrowseEntry.config ?? {};
                unbrowseConfig.skillIndexSolanaPrivateKey = p.privateKey;
                unbrowseEntry.config = unbrowseConfig;
                pluginEntries.unbrowse = unbrowseEntry;
                (currentConfig as any).plugins = { ...(currentConfig as any).plugins, entries: pluginEntries };
                await api.runtime.config.writeConfigFile(currentConfig);
                solanaPrivateKey = p.privateKey;
                indexOpts.solanaPrivateKey = p.privateKey;
                return {
                  content: [{
                    type: "text",
                    text: `Payer wallet set: ${publicKey}\nThis wallet will be used to pay for skill downloads from the marketplace.`,
                  }],
                };
              } catch (err) {
                return { content: [{ type: "text", text: `Invalid key or save failed: ${(err as Error).message}` }] };
              }
            }

            // Default: status
            const lines = ["Unbrowse Wallet Status", ""];

            if (creatorWallet) {
              lines.push(`Creator (earning): ${creatorWallet}`);
            } else {
              lines.push("Creator (earning): not configured");
            }

            if (solanaPrivateKey) {
              try {
                const { Keypair } = await import("@solana/web3.js");
                const bs58 = await import("bs58");
                const keypair = Keypair.fromSecretKey(bs58.default.decode(solanaPrivateKey));
                lines.push(`Payer (spending):  ${keypair.publicKey.toBase58()}`);
              } catch {
                lines.push("Payer (spending):  configured (key decode failed)");
              }
            } else {
              lines.push("Payer (spending):  not configured");
            }

            lines.push("");

            if (!creatorWallet && !solanaPrivateKey) {
              lines.push(
                'No wallet configured. Use action="setup" to auto-generate a Solana keypair.',
                "The wallet is used to earn and pay USDC for skill marketplace access.",
              );
            } else if (!solanaPrivateKey) {
              lines.push(
                'No payer key configured. Use action="setup" to generate, or action="set_payer" to import.',
                "A payer key is needed to download skills from the marketplace.",
              );
            } else if (!creatorWallet) {
              lines.push(
                'No creator wallet. Use action="set_creator" to set your earning address.',
                "A creator wallet lets you earn USDC when others download your skills.",
              );
            } else {
              lines.push(
                "Wallet ready. Fund the address with USDC to download/discover skills.",
                "You earn USDC when others download your published skills.",
              );
            }

            return { content: [{ type: "text", text: lines.join("\n") }] };
          },
        },
        // ── browser ──────────────────────────────────────────────────────
        // Browser-use-style interaction: replaces built-in browser tool with Playwright
        {
          name: "browser",
          label: "Browse Web",
          description:
            "Browse and interact with web pages using Playwright (no extension needed). Returns indexed " +
            "interactive elements (e.g. [1] <button> Submit, [2] <input placeholder=\"Email\">). " +
            "Use element indices for actions: click_element(index=3), input_text(index=5, text=\"hello\"). " +
            "Auto-captures API traffic and generates skills. Auto-fills OTP codes from SMS/clipboard.",
          parameters: INTERACT_SCHEMA,
          async execute(_toolCallId: string, params: unknown) {
            const p = params as {
              url: string;
              service?: string;
              actions: Array<{
                action: string;
                index?: number;
                text?: string;
                clear?: boolean;
                direction?: "down" | "up";
                amount?: number;
                selector?: string;
              }>;
              captureTraffic?: boolean;
              closeChromeIfNeeded?: boolean;
            };

            const { extractPageState, getElementByIndex, formatPageStateForLLM, detectOTPField } = await import("./src/dom-service.js");

            // Check if Chrome is running and we need to handle it
            if (!sharedBrowser) {
              const { spawnSync } = await import("node:child_process");
              const psResult = spawnSync("pgrep", ["-x", "Google Chrome"], { encoding: "utf-8" });
              const chromeIsRunning = psResult.stdout.trim().length > 0;

              // Check if any CDP port is available (Chrome with debugging OR clawdbot browser)
              let cdpAvailable = false;
              for (const port of [18792, 18800, browserPort, 9222, 9229]) {
                try {
                  const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
                    signal: AbortSignal.timeout(1000),
                  });
                  if (resp.ok) {
                    cdpAvailable = true;
                    break;
                  }
                } catch { /* not available */ }
              }

              if (chromeIsRunning && cdpAvailable) {
                // Chrome has CDP enabled - connect directly, no need to close
                logger.info(`[unbrowse] Chrome has CDP enabled — connecting directly`);
              } else if (chromeIsRunning && !cdpAvailable && p.closeChromeIfNeeded) {
                // Chrome running without CDP and user gave permission - close and relaunch
                logger.info(`[unbrowse] Closing Chrome to use your profile with all logins...`);
                await closeChrome();
              }
              // If Chrome is running without CDP and no permission, fall back to Playwright
            }

            // Normalize actions — LLMs sometimes send malformed action objects
            // (e.g., { "fill": ... } instead of { "action": "fill", ... }).
            // Also filter out entries with no action at all.
            if (p.actions) {
              p.actions = p.actions
                .map((act) => {
                  if (act.action) return act;
                  // Try to infer action from other keys
                  const keys = Object.keys(act);
                  const actionKey = keys.find(k => ["click", "fill", "input", "select", "scroll", "wait", "extract", "navigate", "type"].includes(k));
                  if (actionKey) {
                    const mapped: Record<string, string> = {
                      click: "click_element", fill: "input_text", input: "input_text",
                      select: "select_option", scroll: "scroll", wait: "wait",
                      extract: "extract_content", navigate: "go_to_url", type: "send_keys",
                    };
                    return { ...act, action: mapped[actionKey] ?? actionKey };
                  }
                  return act;
                })
                .filter((act) => act.action);
            }

            // Derive service name from URL if not provided
            let service = p.service;
            if (!service) {
              try {
                const host = new URL(p.url).hostname;
                service = host
                  .replace(/^(www|api|app|auth|login)\./, "")
                  .replace(/\.(com|io|org|net|dev|co|ai)$/, "")
                  .replace(/\./g, "-");
              } catch {
                return { content: [{ type: "text", text: "Invalid URL." }] };
              }
            }

            // Load auth from skill's auth.json (with vault fallback)
            const skillDir = join(defaultOutputDir, service);
            const authPath = join(skillDir, "auth.json");
            let authHeaders: Record<string, string> = {};
            let authCookies: Record<string, string> = {};
            let storedLocalStorage: Record<string, string> = {};
            let storedSessionStorage: Record<string, string> = {};
            let baseUrl = "";
            let authSource = "none";

            if (existsSync(authPath)) {
              try {
                const auth = JSON.parse(readFileSync(authPath, "utf-8"));
                authHeaders = auth.headers ?? {};
                authCookies = auth.cookies ?? {};
                baseUrl = auth.baseUrl ?? "";
                storedLocalStorage = auth.localStorage ?? {};
                storedSessionStorage = auth.sessionStorage ?? {};
                authSource = "auth.json";
              } catch { /* try vault fallback */ }
            }

            // Fallback: try loading from vault if auth.json is missing or empty
            if (Object.keys(authCookies).length === 0 && Object.keys(authHeaders).length === 0) {
              try {
                const { Vault } = await import("./src/vault.js");
                const vault = new Vault(vaultDbPath);
                const entry = vault.get(service);
                vault.close();
                if (entry) {
                  authHeaders = entry.headers ?? {};
                  authCookies = entry.cookies ?? {};
                  baseUrl = entry.baseUrl ?? "";
                  // extra contains localStorage/sessionStorage tokens
                  for (const [key, value] of Object.entries(entry.extra ?? {})) {
                    storedLocalStorage[key] = String(value);
                  }
                  authSource = "vault";
                  logger.info(`[unbrowse] Loaded auth from vault for ${service}`);
                }
              } catch { /* vault not available */ }
            }

            // Fallback: try loading cookies from Chrome's cookie database
            if (Object.keys(authCookies).length === 0) {
              try {
                const { readChromeCookies, chromeCookiesAvailable } = await import("./src/chrome-cookies.js");
                if (chromeCookiesAvailable()) {
                  const domain = new URL(p.url).hostname.replace(/^www\./, "");
                  const chromeCookies = readChromeCookies(domain);
                  if (Object.keys(chromeCookies).length > 0) {
                    authCookies = chromeCookies;
                    authSource = "chrome";
                    logger.info(`[unbrowse] Loaded ${Object.keys(chromeCookies).length} cookies from Chrome for ${domain}`);
                  }
                }
              } catch (err) {
                logger.warn(`[unbrowse] Could not read Chrome cookies: ${(err as Error).message}`);
              }
            }

            // Get or reuse browser session — uses CDP cascade:
            // 1. Try clawdbot managed browser (port 18791) — has existing cookies/auth
            // 2. Try Chrome remote debugging (9222, 9229)
            // 3. Launch Chrome with user's profile (requires Chrome to be closed)
            let session: BrowserSession | null = null;
            let browser: any = null;
            let context: any = null;
            let page: any = null;
            let isReusedSession = false;

            try {
              // Check if we already have a session before creating one
              const hadExistingSession = browserSessions.has(service);
              session = await getOrCreateBrowserSession(service, p.url, authCookies, authHeaders);
              browser = session.browser;
              context = session.context;
              page = session.page;

              // Only log "reusing" if the session was actually reused (not recreated after stale cleanup)
              isReusedSession = hadExistingSession && browserSessions.get(service) === session;
            } catch (browserErr) {
              const errMsg = (browserErr as Error).message;
              if (errMsg === "NO_BROWSER") {
                return {
                  content: [{
                    type: "text",
                    text: `**Could not launch browser.**\n\n` +
                      `Playwright Chromium failed to start.\n\n` +
                      `**Try:**\n` +
                      `1. Run: \`npx playwright install chromium\`\n` +
                      `2. Then run this command again`,
                  }],
                };
              }
              throw browserErr;
            }

            // Track OTP field index for re-detection after clicks
            let otpAutoFillIndex: number | null = null;

            try {
              // If this is an existing session, we may need to navigate to a new page
              // Check if current URL matches target - if not, navigate
              const currentUrl = page.url();
              const targetOrigin = new URL(p.url).origin;
              if (!currentUrl.startsWith(targetOrigin)) {
                // Need a fresh page for this different origin
                page = await context.newPage();
                session.page = page;
              }

              // Capture API traffic — full HAR entries for skill generation
              const shouldCapture = p.captureTraffic !== false;
              const capturedRequests: Array<{
                method: string;
                url: string;
                status: number;
                resourceType: string;
              }> = [];
              const harEntries: Array<{
                request: {
                  method: string;
                  url: string;
                  headers: Array<{ name: string; value: string }>;
                  cookies: Array<{ name: string; value: string }>;
                  queryString: Array<{ name: string; value: string }>;
                  postData?: { mimeType: string; text: string };
                };
                response: {
                  status: number;
                  statusText: string;
                  headers: Array<{ name: string; value: string }>;
                  content: { mimeType: string; text?: string };
                };
              }> = [];

              if (shouldCapture) {
                page.on("response", async (resp: any) => {
                  const req = resp.request();
                  const rt = req.resourceType();
                  if (rt !== "xhr" && rt !== "fetch" && rt !== "document") return;

                  const url = req.url();
                  const method = req.method();

                  capturedRequests.push({ method, url, status: resp.status(), resourceType: rt });

                  // Build HAR entry for skill generation
                  try {
                    const reqHeaders = Object.entries(req.headers() ?? {}).map(([name, value]) => ({
                      name,
                      value: String(value),
                    }));
                    const respHeaders = Object.entries(resp.headers() ?? {}).map(([name, value]) => ({
                      name,
                      value: String(value),
                    }));

                    // Parse query string from URL
                    const queryString: Array<{ name: string; value: string }> = [];
                    try {
                      const u = new URL(url);
                      u.searchParams.forEach((value, name) => queryString.push({ name, value }));
                    } catch { /* ignore */ }

                    // Capture post data
                    let postData: { mimeType: string; text: string } | undefined;
                    if (method !== "GET" && method !== "HEAD") {
                      try {
                        const pd = req.postData();
                        if (pd) {
                          const ct = req.headers()["content-type"] ?? "application/octet-stream";
                          postData = { mimeType: ct, text: pd };
                        }
                      } catch { /* ignore */ }
                    }

                    // Capture response body (best-effort, skip large/binary)
                    let responseText: string | undefined;
                    try {
                      const ct = resp.headers()["content-type"] ?? "";
                      if (ct.includes("json") || ct.includes("text") || ct.includes("xml")) {
                        const body = await resp.text().catch(() => "");
                        if (body.length < 50_000) responseText = body;
                      }
                    } catch { /* ignore */ }

                    const cookies = Object.entries(authCookies).map(([name, value]) => ({ name, value }));

                    harEntries.push({
                      request: { method, url, headers: reqHeaders, cookies, queryString, postData },
                      response: {
                        status: resp.status(),
                        statusText: resp.statusText(),
                        headers: respHeaders,
                        content: {
                          mimeType: resp.headers()["content-type"] ?? "",
                          text: responseText,
                        },
                      },
                    });
                  } catch { /* non-critical — don't break interaction for HAR capture */ }
                });
              }

              // Inject localStorage/sessionStorage via addInitScript BEFORE page JS runs
              // This is critical for SPAs that check auth on load - inject BEFORE navigation
              const hasStorage = Object.keys(storedLocalStorage).length > 0 || Object.keys(storedSessionStorage).length > 0;
              if (hasStorage) {
                try {
                  // addInitScript runs before ANY page JavaScript - perfect for SPA auth
                  await context.addInitScript(`
                      (function() {
                        const ls = ${JSON.stringify(storedLocalStorage)};
                        const ss = ${JSON.stringify(storedSessionStorage)};
                        for (const [k, v] of Object.entries(ls)) {
                          try { window.localStorage.setItem(k, v); } catch {}
                        }
                        for (const [k, v] of Object.entries(ss)) {
                          try { window.sessionStorage.setItem(k, v); } catch {}
                        }
                      })();
                    `);
                  logger.info(`[unbrowse] Registered init script with ${Object.keys(storedLocalStorage).length} localStorage + ${Object.keys(storedSessionStorage).length} sessionStorage tokens`);
                } catch (err) {
                  // Fallback: try direct injection on current page
                  logger.warn(`[unbrowse] addInitScript failed, using fallback: ${(err as Error).message}`);
                  try {
                    await page.evaluate(
                      ({ ls, ss }: { ls: Record<string, string>; ss: Record<string, string> }) => {
                        for (const [k, v] of Object.entries(ls)) {
                          try { window.localStorage.setItem(k, v); } catch {}
                        }
                        for (const [k, v] of Object.entries(ss)) {
                          try { window.sessionStorage.setItem(k, v); } catch {}
                        }
                      },
                      { ls: storedLocalStorage, ss: storedSessionStorage },
                    );
                  } catch { /* page may block storage access */ }
                }
              }

              // Navigate to the target URL (init script will inject tokens before page JS runs)
              try {
                await page.goto(p.url, { waitUntil: "networkidle", timeout: 30_000 });
              } catch {
                // Navigation timeout - page may still be loading dynamic content
                await page.waitForTimeout(3000);
              }

              // Extract initial page state (indexed elements)
              let pageState = await extractPageState(page);

              // Auto-OTP detection — use persistent watcher that survives interact completion
              const otpDetection = detectOTPField(pageState);
              otpAutoFillIndex = otpDetection.hasOTP ? (otpDetection.elementIndex ?? null) : null;

              if (otpDetection.hasOTP && otpAutoFillIndex != null) {
                // Start persistent watcher (runs in background, doesn't stop when interact ends)
                await startPersistentOtpWatcher(page, otpAutoFillIndex);
              }

              // Execute actions (browser-use style — index-based)
              const actionResults: string[] = [];

              for (const act of p.actions) {
                try {
                  switch (act.action) {
                    // ── Index-based element actions ─────────────────────────
                    case "click_element": {
                      if (act.index == null && !act.selector) {
                        actionResults.push("click_element: missing index or selector");
                        break;
                      }
                      if (act.index != null) {
                        const el = await getElementByIndex(page, act.index);
                        if (!el || (await el.evaluate((e: any) => !e))) {
                          actionResults.push(`click_element: index ${act.index} not found — page may have changed`);
                          break;
                        }
                        await el.click();
                      } else if (act.selector) {
                        await page.waitForSelector(act.selector, { timeout: 10_000 });
                        await page.click(act.selector);
                      }
                      await page.waitForTimeout(500);
                      // Re-extract page state after click (page may have changed)
                      pageState = await extractPageState(page);

                      // Re-check for OTP fields after click (might have navigated to 2FA page)
                      if (!persistentOtpWatcher) {
                        const newOtpCheck = detectOTPField(pageState);
                        if (newOtpCheck.hasOTP && newOtpCheck.elementIndex != null) {
                          otpAutoFillIndex = newOtpCheck.elementIndex;
                          await startPersistentOtpWatcher(page, otpAutoFillIndex);
                          actionResults.push(`OTP field detected — auto-watching for SMS/notifications (5min TTL)`);
                        }
                      }

                      const desc = act.index != null
                        ? `[${act.index}] ${pageState.elements.find(e => e.index === act.index)?.text?.slice(0, 50) ?? ""}`
                        : act.selector;
                      actionResults.push(`click_element: ${desc} done`);
                      break;
                    }

                    case "input_text": {
                      if (act.index == null && !act.selector) {
                        actionResults.push("input_text: missing index or selector");
                        break;
                      }
                      const text = act.text ?? "";
                      const clear = act.clear !== false;
                      if (act.index != null) {
                        const el = await getElementByIndex(page, act.index);
                        if (!el || (await el.evaluate((e: any) => !e))) {
                          actionResults.push(`input_text: index ${act.index} not found`);
                          break;
                        }
                        if (clear) {
                          await el.fill(text);
                        } else {
                          await el.type(text);
                        }
                      } else if (act.selector) {
                        await page.waitForSelector(act.selector, { timeout: 10_000 });
                        if (clear) {
                          await page.fill(act.selector, text);
                        } else {
                          await page.type(act.selector, text);
                        }
                      }
                      await page.waitForTimeout(200);
                      actionResults.push(`input_text: [${act.index ?? act.selector}] = "${text.slice(0, 50)}" done`);
                      break;
                    }

                    case "select_option": {
                      if (act.index == null && !act.selector) {
                        actionResults.push("select_option: missing index or selector");
                        break;
                      }
                      const optText = act.text ?? "";
                      if (act.index != null) {
                        const el = await getElementByIndex(page, act.index);
                        if (!el || (await el.evaluate((e: any) => !e))) {
                          actionResults.push(`select_option: index ${act.index} not found`);
                          break;
                        }
                        // Try selecting by label text first, then by value
                        await el.selectOption({ label: optText }).catch(() =>
                          el.selectOption(optText),
                        );
                      } else if (act.selector) {
                        await page.waitForSelector(act.selector, { timeout: 10_000 });
                        await page.selectOption(act.selector, { label: optText }).catch(() =>
                          page.selectOption(act.selector!, optText),
                        );
                      }
                      await page.waitForTimeout(200);
                      pageState = await extractPageState(page);
                      actionResults.push(`select_option: [${act.index ?? act.selector}] = "${optText}" done`);
                      break;
                    }

                    case "get_dropdown_options": {
                      if (act.index == null) {
                        actionResults.push("get_dropdown_options: missing index");
                        break;
                      }
                      const el = pageState.elements.find(e => e.index === act.index);
                      if (el?.options) {
                        actionResults.push(`dropdown_options [${act.index}]: ${el.options.join(", ")}`);
                      } else {
                        // Try extracting from page
                        const elHandle = await getElementByIndex(page, act.index);
                        if (elHandle) {
                          const opts = await elHandle.evaluate((e: any) => {
                            if (e.tagName === "SELECT") {
                              return Array.from(e.options).map((o: any) => o.text.trim()).slice(0, 20);
                            }
                            return [];
                          });
                          actionResults.push(`dropdown_options [${act.index}]: ${(opts as string[]).join(", ") || "no options found"}`);
                        } else {
                          actionResults.push(`get_dropdown_options: index ${act.index} not found`);
                        }
                      }
                      break;
                    }

                    // ── Page-level actions ──────────────────────────────────
                    case "scroll": {
                      const down = (act.direction ?? "down") === "down";
                      const pages = act.amount ?? 1;
                      const pixels = Math.round(pages * (pageState.viewportHeight || 800));
                      await page.evaluate(
                        ({ px, d }: { px: number; d: boolean }) => window.scrollBy(0, d ? px : -px),
                        { px: pixels, d: down },
                      );
                      await page.waitForTimeout(300);
                      pageState = await extractPageState(page);
                      actionResults.push(`scroll: ${down ? "down" : "up"} ${pages} page(s) done`);
                      break;
                    }

                    case "send_keys": {
                      const keys = act.text ?? "Enter";
                      await page.keyboard.press(keys);
                      await page.waitForTimeout(300);
                      pageState = await extractPageState(page);
                      actionResults.push(`send_keys: "${keys}" done`);
                      break;
                    }

                    case "wait": {
                      if (act.selector) {
                        await page.waitForSelector(act.selector, { timeout: act.amount ?? 10_000 });
                        actionResults.push(`wait: ${act.selector} appeared`);
                      } else {
                        const ms = act.amount ?? 2000;
                        await page.waitForTimeout(ms);
                        actionResults.push(`wait: ${ms}ms done`);
                      }
                      pageState = await extractPageState(page);
                      break;
                    }

                    case "extract_content": {
                      const bodyText = await page.evaluate(() =>
                        document.body?.innerText?.slice(0, 5000) ?? "",
                      );
                      actionResults.push(`extract_content:\n${bodyText.slice(0, 3000)}`);
                      break;
                    }

                    case "go_to_url": {
                      const url = act.text;
                      if (!url) {
                        actionResults.push("go_to_url: missing URL in text field");
                        break;
                      }
                      try {
                        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
                      } catch {
                        await page.waitForTimeout(3000);
                      }
                      pageState = await extractPageState(page);
                      actionResults.push(`go_to_url: ${url} done`);
                      break;
                    }

                    case "go_back": {
                      await page.goBack({ waitUntil: "networkidle", timeout: 15_000 }).catch(() => { });
                      pageState = await extractPageState(page);
                      actionResults.push("go_back: done");
                      break;
                    }

                    case "done": {
                      actionResults.push(`done: ${act.text ?? "Task complete"}`);
                      break;
                    }

                    case "wait_for_otp": {
                      // Wait for OTP from SMS/notification and auto-fill
                      const { startOTPWatcher, stopOTPWatcher, getOTPWatcher } = await import("./src/otp-watcher.js");
                      const watcher = startOTPWatcher((otp) => {
                        logger.info(`[unbrowse] OTP detected: ${otp.code} from ${otp.source}`);
                      });

                      const timeoutMs = (act.amount ?? 60) * 1000;
                      actionResults.push(`wait_for_otp: Waiting up to ${timeoutMs / 1000}s for OTP from SMS/clipboard...`);

                      const otp = await watcher.waitForOTP(timeoutMs);

                      if (otp) {
                        actionResults.push(`wait_for_otp: Got OTP "${otp.code}" from ${otp.source}`);

                        // Auto-fill if index is provided
                        if (act.index != null) {
                          const el = await getElementByIndex(page, act.index);
                          if (el) {
                            await el.click();
                            await el.fill(otp.code);
                            actionResults.push(`wait_for_otp: Filled OTP into element [${act.index}]`);
                          }
                        }

                        watcher.clear(); // Clear so we don't reuse
                      } else {
                        actionResults.push(`wait_for_otp: No OTP received within ${timeoutMs / 1000}s`);
                      }

                      pageState = await extractPageState(page);
                      break;
                    }

                    default:
                      actionResults.push(`unknown action: ${act.action}`);
                  }
                } catch (err) {
                  actionResults.push(`${act.action}: FAILED — ${(err as Error).message}`);
                  // Re-extract page state so agent can recover
                  try { pageState = await extractPageState(page); } catch { /* ignore */ }
                }
              }

              // Capture updated cookies/storage for persistence
              const finalCookies = await context.cookies().catch(() => []);
              const updatedCookies: Record<string, string> = {};
              for (const c of finalCookies as Array<{ name: string; value: string }>) {
                updatedCookies[c.name] = c.value;
              }

              let updatedLocalStorage: Record<string, string> = {};
              let updatedSessionStorage: Record<string, string> = {};
              try {
                const freshState = await page.evaluate(() => {
                  const authKeywords =
                    /token|auth|session|jwt|access|refresh|csrf|xsrf|key|cred|user|login|bearer/i;
                  const ls: Record<string, string> = {};
                  for (let i = 0; i < window.localStorage.length; i++) {
                    const key = window.localStorage.key(i);
                    if (key && authKeywords.test(key)) {
                      const val = window.localStorage.getItem(key);
                      if (val) ls[key] = val;
                    }
                  }
                  const ss: Record<string, string> = {};
                  for (let i = 0; i < window.sessionStorage.length; i++) {
                    const key = window.sessionStorage.key(i);
                    if (key && authKeywords.test(key)) {
                      const val = window.sessionStorage.getItem(key);
                      if (val) ss[key] = val;
                    }
                  }
                  return { localStorage: ls, sessionStorage: ss };
                });
                updatedLocalStorage = freshState.localStorage;
                updatedSessionStorage = freshState.sessionStorage;
              } catch { /* page may be closed */ }

              // Persist updated auth state back to auth.json
              try {
                const { mkdirSync, writeFileSync } = await import("node:fs");
                mkdirSync(join(skillDir, "scripts"), { recursive: true });
                const existing = existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf-8")) : {};
                existing.cookies = { ...authCookies, ...updatedCookies };
                existing.localStorage = { ...storedLocalStorage, ...updatedLocalStorage };
                existing.sessionStorage = { ...storedSessionStorage, ...updatedSessionStorage };
                existing.lastInteractAt = new Date().toISOString();
                if (!existing.baseUrl) existing.baseUrl = baseUrl || new URL(p.url).origin;
                writeFileSync(authPath, JSON.stringify(existing, null, 2), "utf-8");
              } catch { /* non-critical */ }

              // Update session timestamp (don't close — reuse across calls)
              // Browser will be cleaned up after SESSION_TTL_MS inactivity
              if (session) {
                session.lastUsed = new Date();
              }

              const apiCalls = capturedRequests.filter(
                (r) => r.resourceType === "xhr" || r.resourceType === "fetch",
              );

              // Auto-generate skill from captured API traffic
              let skillResult: { service: string; endpointCount: number; changed: boolean; diff?: string; skillDir: string } | null = null;
              const apiHarEntries = harEntries.filter((e) => {
                const ct = e.response.content.mimeType ?? "";
                return ct.includes("json") || ct.includes("xml") || ct.includes("text/plain") || e.request.method !== "GET";
              });

              if (apiHarEntries.length >= 2) {
                try {
                  const har = { log: { entries: apiHarEntries } };
                  const apiData = parseHar(har as any, p.url);
                  // Merge cookies from auth
                  for (const [name, value] of Object.entries(authCookies)) {
                    if (!apiData.cookies[name]) apiData.cookies[name] = value;
                  }
                  // Merge auth headers
                  for (const [name, value] of Object.entries(authHeaders)) {
                    if (!apiData.authHeaders[name]) apiData.authHeaders[name] = value;
                  }

                  const result = await generateSkill(apiData, defaultOutputDir);
                  discovery.markLearned(result.service);
                  skillResult = result;

                  // Detect and save refresh token config
                  detectAndSaveRefreshConfig(apiHarEntries, join(result.skillDir, "auth.json"), logger);

                  logger.info(
                    `[unbrowse] Interact → auto-skill "${result.service}" (${result.endpointCount} endpoints${result.diff ? `, ${result.diff}` : ""})`,
                  );

                  // Auto-publish if changed
                  if (result.changed) {
                    autoPublishSkill(result.service, result.skillDir).catch(() => { });
                  }
                } catch (err) {
                  logger.warn(`[unbrowse] Interact skill generation failed: ${(err as Error).message}`);
                }
              }

              // Build result: page state + action results + API traffic + skill
              const formattedPageState = formatPageStateForLLM(pageState);
              const sessionInfo = session
                ? `Browser: ${session.method}${isReusedSession ? " (reused session)" : " (new session)"}${authSource !== "none" ? `, auth: ${authSource}` : ""}`
                : "";
              const resultLines = [
                `Interaction complete: ${p.actions.length} action(s)`,
                sessionInfo,
                "",
                formattedPageState,
                "",
                "Action results:",
                ...actionResults.map((r) => `  ${r}`),
              ];

              if (apiCalls.length > 0) {
                resultLines.push(
                  "",
                  `API traffic captured: ${apiCalls.length} request(s)`,
                  ...apiCalls.slice(0, 20).map(
                    (r) => `  ${r.method} ${r.url.slice(0, 100)} -> ${r.status}`,
                  ),
                );
                if (apiCalls.length > 20) {
                  resultLines.push(`  ... and ${apiCalls.length - 20} more`);
                }
              }

              if (skillResult) {
                resultLines.push(
                  "",
                  `Skill auto-generated: ${skillResult.service} (${skillResult.endpointCount} endpoints)`,
                );
                if (skillResult.diff) resultLines.push(`  Changes: ${skillResult.diff}`);
                resultLines.push(`  Use unbrowse_replay with service="${skillResult.service}" to call these APIs directly.`);
              }

              // Note: Persistent OTP watcher intentionally NOT stopped here
              // It continues running in background to fill OTP when it arrives

              logger.info(
                `[unbrowse] Interact: ${p.actions.length} actions on ${pageState.url} (${apiCalls.length} API calls, ${pageState.elements.length} elements${skillResult ? `, skill: ${skillResult.service}` : ""})`,
              );
              return { content: [{ type: "text", text: resultLines.join("\n") }] };
            } catch (err) {
              const msg = (err as Error).message;
              // On error, invalidate the session so next call gets fresh browser
              if (service && browserSessions.has(service)) {
                const deadSession = browserSessions.get(service)!;
                deadSession.context?.close().catch(() => { });
                deadSession.browser?.close().catch(() => { });
                browserSessions.delete(service);
              }
              if (msg.includes("playwright")) {
                return {
                  content: [{ type: "text", text: `Playwright not available: ${msg}. Install with: bun add playwright` }],
                };
              }
              return { content: [{ type: "text", text: `Interaction failed: ${msg}` }] };
            }
          },
        },

        // ── unbrowse_agent ─────────────────────────────────────────────
        {
          name: "unbrowse_agent",
          label: "AI Browser Agent",
          description:
            "Run an autonomous AI agent that browses the web to complete tasks. " +
            "Powered by browser-use. Give it a natural language task and it will " +
            "click, type, navigate, and extract data autonomously. Also captures " +
            "API traffic for skill generation.",
          parameters: AGENT_SCHEMA,
          async execute(_toolCallId: string, params: unknown) {
            const p = params as {
              task?: string;
              url?: string;
              maxSteps?: number;
              timeoutMinutes?: number;
              action?: "run" | "status" | "stop" | "list_profiles" | "create_profile";
              taskId?: string;
              profileId?: string;
              profileName?: string;
              llmProvider?: "openai" | "anthropic" | "browser-use";
              llmModel?: string;
            };

            const action = p.action ?? "run";

            // For non-run actions, use browser-use Cloud API
            if (action !== "run") {
              if (!browserUseCloudApiKey) {
                return {
                  content: [{
                    type: "text",
                    text: `browser-use Cloud API not configured. Set browserUseCloudApiKey in unbrowse plugin config.\n\n` +
                      `Get your API key at: https://cloud.browser-use.com/`,
                  }],
                };
              }

              const { createTask, getTask, stopTask, waitForTask, listProfiles, createProfile } =
                await import("./src/browser-use-cloud.js");

              try {
                if (action === "status" && p.taskId) {
                  const task = await getTask(browserUseCloudApiKey, p.taskId);
                  return {
                    content: [{
                      type: "text",
                      text: `Task ${task.id}:\n` +
                        `  Status: ${task.status}\n` +
                        `  Prompt: ${task.prompt}\n` +
                        (task.result ? `  Result: ${task.result}\n` : "") +
                        (task.error ? `  Error: ${task.error}\n` : ""),
                    }],
                  };
                }

                if (action === "stop" && p.taskId) {
                  await stopTask(browserUseCloudApiKey, p.taskId);
                  return { content: [{ type: "text", text: `Task ${p.taskId} stopped.` }] };
                }

                if (action === "list_profiles") {
                  const profiles = await listProfiles(browserUseCloudApiKey);
                  if (profiles.length === 0) {
                    return { content: [{ type: "text", text: "No browser profiles found." }] };
                  }
                  const lines = profiles.map((p) => `  ${p.id}: ${p.name}`);
                  return { content: [{ type: "text", text: `Browser profiles:\n${lines.join("\n")}` }] };
                }

                if (action === "create_profile" && p.profileName) {
                  const profile = await createProfile(browserUseCloudApiKey, p.profileName);
                  return {
                    content: [{
                      type: "text",
                      text: `Created profile: ${profile.id} (${profile.name})\n\nUse profileId="${profile.id}" in future agent tasks.`,
                    }],
                  };
                }

                return { content: [{ type: "text", text: `Unknown action: ${action}` }] };
              } catch (err) {
                return { content: [{ type: "text", text: `browser-use API error: ${(err as Error).message}` }] };
              }
            }

            // Run action - use local browser-use-typescript
            if (!p.task) {
              return { content: [{ type: "text", text: "Missing required parameter: task" }] };
            }

            try {
              const { runBrowserAgent, createLLM } = await import("./src/browser-use-agent.js");

              // Create LLM - prefer browser-use model if API key available, else use anthropic/openai
              const llmProvider = p.llmProvider ?? (browserUseCloudApiKey ? "browser-use" : "anthropic");
              const llm = await createLLM(llmProvider, {
                apiKey: llmProvider === "browser-use" ? browserUseCloudApiKey : undefined,
                model: p.llmModel,
              });

              logger.info(`[unbrowse] Agent starting: "${p.task.slice(0, 50)}..." (${llmProvider})`);

              const result = await runBrowserAgent({
                task: p.task,
                llm,
                startUrl: p.url,
                maxSteps: p.maxSteps ?? 50,
                useVision: true,
                onStep: (step, action) => {
                  logger.info(`[unbrowse] Agent step ${step}: ${action.slice(0, 100)}`);
                },
              });

              // Generate skill from captured requests if any
              let skillInfo = "";
              if (result.capturedRequests.length >= 3) {
                try {
                  const domain = p.url ? new URL(p.url).hostname : result.capturedRequests[0]?.url
                    ? new URL(result.capturedRequests[0].url).hostname
                    : null;

                  if (domain) {
                    const service = domain
                      .replace(/^(www|api|app)\./, "")
                      .replace(/\.(com|io|org|net)$/, "")
                      .replace(/\./g, "-");

                    skillInfo = `\n\nCaptured ${result.capturedRequests.length} API calls. Use unbrowse_replay service="${service}" to call them directly.`;
                  }
                } catch { /* ignore */ }
              }

              const stepSummary = result.steps.slice(-5).map((s) => `  ${s.step}: ${s.action.slice(0, 80)}`).join("\n");

              return {
                content: [{
                  type: "text",
                  text: `Agent ${result.success ? "completed" : "finished"} (${result.steps.length} steps)\n\n` +
                    (result.finalResult ? `Result: ${result.finalResult}\n\n` : "") +
                    `Recent steps:\n${stepSummary}` +
                    skillInfo,
                }],
              };
            } catch (err) {
              const msg = (err as Error).message;
              logger.warn(`[unbrowse] Agent failed: ${msg}`);

              if (msg.includes("langchain")) {
                return {
                  content: [{
                    type: "text",
                    text: `LLM dependency missing. Install with:\n\n` +
                      `npm install @langchain/openai @langchain/anthropic\n\n` +
                      `Then set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable.`,
                  }],
                };
              }

              return { content: [{ type: "text", text: `Agent failed: ${msg}` }] };
            }
          },
        },
      ];

      return toolList;
    };

    const toolNames = [
      "unbrowse_learn",
      "unbrowse_capture",
      "unbrowse_auth",
      "unbrowse_replay",
      "unbrowse_stealth",
      "unbrowse_skills",
      "unbrowse_publish",
      "unbrowse_search",
      "unbrowse_login",
      "unbrowse_wallet",
      "browser",
      "unbrowse_agent",
    ];

    api.registerTool(tools, { names: toolNames });

    // ── Token Refresh Scheduler ─────────────────────────────────────────────
    // Automatically refresh OAuth/JWT tokens before they expire
    const tokenRefreshScheduler = new TokenRefreshScheduler(defaultOutputDir, {
      intervalMinutes: 1, // Check every minute
      logger: {
        info: (msg) => logger.info(msg),
        warn: (msg) => logger.warn(msg),
      },
    });
    tokenRefreshScheduler.start();

    // ── Auto-Discovery Hook ───────────────────────────────────────────────
    if (autoDiscoverEnabled) {
      api.on("after_tool_call", async (event: any) => {
        // Only trigger on browser tool calls
        const toolName = event?.toolName ?? event?.tool ?? "";
        if (typeof toolName !== "string" || !toolName.startsWith("browser")) return;

        // Don't trigger on our own tools
        if (toolName.startsWith("unbrowse")) return;

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

      logger.info("[unbrowse] Auto-discovery hook active");
    }

    // ── Agent Context Hook — Unbrowse Capabilities + Wallet Prompt ─────────
    // Inject unbrowse capabilities and wallet status so the agent:
    // 1. Uses unbrowse tools (capture, replay, login) instead of asking user to attach Chrome
    // 2. Proactively tells the user about their wallet and prompts them to fund it
    api.on("before_agent_start", async () => {
      // Wait for wallet generation to complete (may still be running)
      await ensureWallet().catch(() => { });

      const lines: string[] = [
        "[Unbrowse] You have self-learning browser skills.",
        "When the user asks you to browse or interact with a website, use the `browser` tool — do NOT ask them to attach Chrome or use an extension.",
        "- Use `browser` tool to browse and interact with web pages. It returns indexed interactive elements [1] [2] [3]... Use click_element(index=N), input_text(index=N, text=...) to interact.",
        "- Use unbrowse_replay to call APIs directly using captured auth (auto-refreshes on 401)",
        "- Use unbrowse_search to find skills other agents have already discovered",
        "- Check unbrowse_skills first to see if you already have a skill for the service",
        "The browser launches automatically via Playwright — no Chrome extension, no manual steps needed.",
        "IMPORTANT: Do NOT ask the user to manually interact with a browser. Use the `browser` tool to drive pages yourself.",
        "",
      ];

      if (creatorWallet) {
        lines.push(`Skill marketplace wallet: ${creatorWallet}`);

        if (solanaPrivateKey) {
          lines.push(
            "The user has a Solana wallet for discovering and publishing skills.",
            "They can download skills from the marketplace ($0.01 USDC each) and earn USDC when others download theirs.",
            "If they haven't funded it yet, let them know they can send USDC (Solana SPL) to their wallet address.",
          );
        } else {
          lines.push(
            "The user has a wallet address but no spending key.",
            "Ask the user to send USDC (Solana SPL) to their wallet address to start discovering skills from the marketplace.",
            `Wallet address to fund: ${creatorWallet}`,
          );
        }
      } else {
        lines.push(
          "No skill marketplace wallet configured.",
          'The user can run unbrowse_wallet with action="setup" to generate a Solana wallet.',
          "This wallet lets them discover skills from other agents and earn USDC when others download their skills.",
        );
      }

      // Credential source info
      if (credentialProvider) {
        lines.push(
          "",
          `Credential source: ${credentialProvider.name} (auto-login enabled)`,
          "When using unbrowse_login, credentials are auto-looked up by domain — no need to ask the user for passwords.",
          "Just provide the loginUrl and the form will be auto-filled.",
        );
      } else {
        lines.push(
          "",
          "No credential source configured for auto-login.",
          "If the user needs to log into websites frequently, suggest they enable it in the unbrowse plugin settings:",
          '  credentialSource: "auto" (detects keychain/1password), "keychain" (macOS), or "1password" (1Password CLI).',
          "This is a config-only setting for security — it cannot be changed via a tool call.",
        );
      }

      return { prependContext: lines.join("\n") };
    });

    const toolCount = toolNames.length;
    const features = [
      `${toolCount} tools`,
      autoDiscoverEnabled ? "auto-discover" : null,
      browserUseApiKey ? "stealth browsers" : null,
      creatorWallet ? "x402 publishing" : null,
      credentialProvider ? `creds:${credentialProvider.name}` : null,
    ].filter(Boolean).join(", ");

    logger.info(`[unbrowse] Plugin registered (${features})`);
  },
};

function toPascalCase(s: string): string {
  return s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

export default plugin;
