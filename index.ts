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
import { readFileSync, existsSync, readdirSync } from "node:fs";
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
              "go_to_url", "go_back", "done",
            ],
            description:
              "Action type. Use element indices from the page state (e.g. click_element index=3). " +
              "Index-based actions: click_element, input_text, select_option, get_dropdown_options. " +
              "Page actions: scroll, send_keys, wait, extract_content, go_to_url, go_back, done.",
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
    const defaultOutputDir = (cfg.skillsOutputDir as string) ?? join(homedir(), ".clawdbot", "skills");
    const browserUseApiKey = cfg.browserUseApiKey as string | undefined;
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
    ensureWallet().catch(() => {});

    // ── Auto-Publish Helper ────────────────────────────────────────────────
    /** Publish a skill to the cloud index if creatorWallet is configured. */
    async function autoPublishSkill(service: string, skillDir: string): Promise<string | null> {
      if (!creatorWallet) return null;

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
        logger.warn(`[unbrowse] Auto-publish failed for ${service}: ${(err as Error).message}`);
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

              const { har, cookies, requestCount, method, crawlResult } = await captureFromChromeProfile(p.urls, {
                waitMs: p.waitMs,
                browserPort,
                crawl: shouldCrawl,
                crawlOptions: {
                  maxPages: p.maxPages ?? 15,
                  discoverOpenApi: true,
                },
              });

              if (requestCount === 0) {
                return { content: [{ type: "text", text: "No API requests captured. The pages may not make API calls, or try waiting longer (waitMs)." }] };
              }

              let apiData = parseHar(har);
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
            "Execute API calls using a skill's stored credentials. Automatically tries " +
            "direct fetch with stored auth headers/cookies. On 401/403, auto-refreshes " +
            "credentials by re-logging in (if loginConfig saved) and retries. " +
            "Can test all endpoints or call a specific one.",
          parameters: REPLAY_SCHEMA,
          async execute(_toolCallId: string, params: unknown) {
            const p = params as { service: string; endpoint?: string; body?: string; skillsDir?: string };
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

            function loadAuth() {
              if (!existsSync(authPath)) return;
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
              } catch { /* skip */ }
            }
            loadAuth();

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
                await chromePage.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});

                // Inject stored localStorage/sessionStorage into the page
                // This restores SPA auth state (JWTs, access tokens) captured during login
                const hasStorage = Object.keys(storedLocalStorage).length > 0 || Object.keys(storedSessionStorage).length > 0;
                if (hasStorage) {
                  try {
                    await chromePage.evaluate(({ ls, ss }: { ls: Record<string, string>; ss: Record<string, string> }) => {
                      for (const [k, v] of Object.entries(ls)) {
                        try { window.localStorage.setItem(k, v); } catch { /* ignore */ }
                      }
                      for (const [k, v] of Object.entries(ss)) {
                        try { window.sessionStorage.setItem(k, v); } catch { /* ignore */ }
                      }
                    }, { ls: storedLocalStorage, ss: storedSessionStorage });
                  } catch { /* page may block storage access — non-critical */ }
                }

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

            async function execInChrome(ep: { method: string; path: string }, body?: string): Promise<{ status: number; ok: boolean; data?: string } | null> {
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

            async function execViaFetch(ep: { method: string; path: string }, body?: string): Promise<{ status: number; ok: boolean; data?: string }> {
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
              return { status: resp.status, ok: resp.ok, data: text.slice(0, 2000) };
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
                    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});

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

            for (const ep of toTest) {
              const body = p.body ?? (["POST", "PUT", "PATCH"].includes(ep.method) ? "{}" : undefined);

              // Try 1: Chrome profile (live cookies)
              let result = await execInChrome(ep, body);
              if (result && result.ok) {
                results.push(`  ${ep.method} ${ep.path} → ${result.status} OK (Chrome)`);
                if (p.endpoint && result.data) results.push(`  Response: ${result.data.slice(0, 500)}`);
                passed++;
                continue;
              }

              // Try 2: Direct fetch with stored auth
              try {
                result = await execViaFetch(ep, body);
                if (result.ok) {
                  results.push(`  ${ep.method} ${ep.path} → ${result.status} OK (direct)`);
                  if (p.endpoint && result.data) results.push(`  Response: ${result.data.slice(0, 500)}`);
                  passed++;
                  continue;
                }
              } catch { /* fall through */ }

              // Try 3: If 401/403, refresh creds and retry
              const status = result?.status ?? 0;
              if ((status === 401 || status === 403) && !credsRefreshed) {
                results.push(`  ${ep.method} ${ep.path} → ${status} — refreshing credentials...`);
                const refreshed = await refreshCreds();
                if (refreshed) {
                  // Retry with fresh creds
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
                  results.push(`  Credential refresh unavailable — no loginConfig in auth.json and no Chrome profile`);
                }
                failed++;
              } else {
                // Not a 401/403, or already tried refresh
                results.push(`  ${ep.method} ${ep.path} → ${status || "FAILED"}`);
                failed++;
              }
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

            // Clean up browser session after capturing state
            await cleanupChrome();

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
            if (credsRefreshed) {
              results.push(`Credentials were refreshed and saved to auth.json`);
            }
            if (failed > 0 && !credsRefreshed && !loginConfig) {
              results.push(`Tip: use unbrowse_login to store login credentials for auto-refresh on expiry`);
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
                  const { har, entries } = await captureFromStealth(cdpUrl);

                  if (entries.length === 0) {
                    return { content: [{ type: "text", text: "No requests captured from stealth browser. Navigate to pages first." }] };
                  }

                  const apiData = parseHar(har);
                  const result = await generateSkill(apiData, defaultOutputDir);
                  discovery.markLearned(result.service);

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
                  const apiData = parseHar(result.har);
                  // Merge captured cookies into apiData
                  for (const [name, value] of Object.entries(result.cookies)) {
                    if (!apiData.cookies[name]) apiData.cookies[name] = value;
                  }
                  await generateSkill(apiData, defaultOutputDir);
                  discovery.markLearned(service);
                  skillGenerated = true;
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
              const lsCount = Object.keys(result.localStorage).length;
              const ssCount = Object.keys(result.sessionStorage).length;
              const metaCount = Object.keys(result.metaTokens).length;
              const summary = [
                `Session captured via ${backend}`,
                `Service: ${service}`,
                credentialUsed ? `Credentials: auto-filled from ${credentialUsed.source} (${credentialUsed.label})` : "",
                `Cookies: ${Object.keys(result.cookies).length}`,
                `Auth headers: ${Object.keys(result.authHeaders).length}`,
                lsCount > 0 ? `localStorage tokens: ${lsCount} (${Object.keys(result.localStorage).join(", ")})` : "",
                ssCount > 0 ? `sessionStorage tokens: ${ssCount}` : "",
                metaCount > 0 ? `Meta tokens: ${metaCount} (${Object.keys(result.metaTokens).join(", ")})` : "",
                `Network requests: ${result.requestCount}`,
                `Base URL: ${result.baseUrl}`,
                `Auth saved: ${join(skillDir, "auth.json")}`,
                skillGenerated ? `Skill generated with ${result.requestCount} captured requests` : "",
                "",
                `The session is ready. Use unbrowse_replay to execute API calls with these credentials.`,
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
        // ── unbrowse_interact ──────────────────────────────────────────
        // Browser-use-style interaction: index-based element targeting + page state
        {
          name: "unbrowse_interact",
          label: "Browser Interaction",
          description:
            "Drive a browser to interact with web pages — like browser-use. After navigation, returns indexed " +
            "interactive elements (e.g. [1] <button> Submit, [2] <input placeholder=\"Email\">). " +
            "Use element indices for actions: click_element(index=3), input_text(index=5, text=\"hello\"). " +
            "Captures API traffic throughout. Uses local Playwright with auth from skill's auth.json.",
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
            };

            const { extractPageState, getElementByIndex, formatPageStateForLLM } = await import("./src/dom-service.js");

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

            // Load auth from skill's auth.json
            const skillDir = join(defaultOutputDir, service);
            const authPath = join(skillDir, "auth.json");
            let authHeaders: Record<string, string> = {};
            let authCookies: Record<string, string> = {};
            let storedLocalStorage: Record<string, string> = {};
            let storedSessionStorage: Record<string, string> = {};
            let baseUrl = "";

            if (existsSync(authPath)) {
              try {
                const auth = JSON.parse(readFileSync(authPath, "utf-8"));
                authHeaders = auth.headers ?? {};
                authCookies = auth.cookies ?? {};
                baseUrl = auth.baseUrl ?? "";
                storedLocalStorage = auth.localStorage ?? {};
                storedSessionStorage = auth.sessionStorage ?? {};
              } catch { /* proceed without auth */ }
            }

            // Launch local Playwright (NOT stealth — stealth is for API execution only)
            let browser: any = null;
            let context: any = null;
            let page: any = null;

            try {
              const { chromium } = await import("playwright");

              browser = await chromium.launch({
                headless: true,
                args: [
                  "--disable-blink-features=AutomationControlled",
                  "--no-sandbox",
                  "--disable-dev-shm-usage",
                ],
              });

              context = await browser.newContext({
                userAgent:
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              });

              // Inject cookies
              if (Object.keys(authCookies).length > 0) {
                try {
                  const domain = new URL(p.url).hostname;
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

              page = await context.newPage();

              // Capture API traffic
              const shouldCapture = p.captureTraffic !== false;
              const capturedRequests: Array<{
                method: string;
                url: string;
                status: number;
                resourceType: string;
              }> = [];

              if (shouldCapture) {
                const pendingReqs = new Map<string, { method: string; url: string; resourceType: string }>();

                page.on("request", (req: any) => {
                  const rt = req.resourceType();
                  if (rt === "xhr" || rt === "fetch" || rt === "document") {
                    pendingReqs.set(req.url() + req.method(), {
                      method: req.method(),
                      url: req.url(),
                      resourceType: rt,
                    });
                  }
                });

                page.on("response", (resp: any) => {
                  const req = resp.request();
                  const key = req.url() + req.method();
                  const entry = pendingReqs.get(key);
                  if (entry) {
                    capturedRequests.push({ ...entry, status: resp.status() });
                    pendingReqs.delete(key);
                  }
                });
              }

              // Navigate to the URL
              try {
                await page.goto(p.url, { waitUntil: "networkidle", timeout: 30_000 });
              } catch {
                await page.waitForTimeout(3000);
              }

              // Inject localStorage/sessionStorage after navigation
              const hasStorage = Object.keys(storedLocalStorage).length > 0 || Object.keys(storedSessionStorage).length > 0;
              if (hasStorage) {
                try {
                  await page.evaluate(
                    ({ ls, ss }: { ls: Record<string, string>; ss: Record<string, string> }) => {
                      for (const [k, v] of Object.entries(ls)) {
                        try { window.localStorage.setItem(k, v); } catch { /* ignore */ }
                      }
                      for (const [k, v] of Object.entries(ss)) {
                        try { window.sessionStorage.setItem(k, v); } catch { /* ignore */ }
                      }
                    },
                    { ls: storedLocalStorage, ss: storedSessionStorage },
                  );
                } catch { /* page may block storage access */ }
              }

              // Extract initial page state (indexed elements)
              let pageState = await extractPageState(page);

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
                      await page.goBack({ waitUntil: "networkidle", timeout: 15_000 }).catch(() => {});
                      pageState = await extractPageState(page);
                      actionResults.push("go_back: done");
                      break;
                    }

                    case "done": {
                      actionResults.push(`done: ${act.text ?? "Task complete"}`);
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

              // Clean up
              await context?.close().catch(() => {});
              await browser?.close().catch(() => {});

              const apiCalls = capturedRequests.filter(
                (r) => r.resourceType === "xhr" || r.resourceType === "fetch",
              );

              // Build result: page state + action results + API traffic
              const formattedPageState = formatPageStateForLLM(pageState);
              const resultLines = [
                `Interaction complete: ${p.actions.length} action(s)`,
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

              logger.info(
                `[unbrowse] Interact: ${p.actions.length} actions on ${pageState.url} (${apiCalls.length} API calls, ${pageState.elements.length} elements)`,
              );
              return { content: [{ type: "text", text: resultLines.join("\n") }] };
            } catch (err) {
              const msg = (err as Error).message;
              await context?.close().catch(() => {});
              await browser?.close().catch(() => {});
              if (msg.includes("playwright")) {
                return {
                  content: [{ type: "text", text: `Playwright not available: ${msg}. Install with: bun add playwright` }],
                };
              }
              return { content: [{ type: "text", text: `Interaction failed: ${msg}` }] };
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
      "unbrowse_interact",
    ];

    api.registerTool(tools, { names: toolNames });

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
      await ensureWallet().catch(() => {});

      const lines: string[] = [
        "[Unbrowse] You have self-learning browser skills.",
        "When the user asks you to interact with a website, use unbrowse tools — do NOT ask them to attach Chrome or use a browser extension.",
        "- Use unbrowse_capture to visit URLs and capture API traffic automatically via Playwright",
        "- Use unbrowse_login to log into authenticated sites with credentials",
        "- Use unbrowse_replay to call APIs using captured auth (auto-refreshes on 401)",
        "- Use unbrowse_interact to drive pages — browser-use style. It returns indexed interactive elements [1] [2] [3]... Use click_element(index=N), input_text(index=N, text=...), select_option(index=N, text=...) to interact. For multi-step flows like booking.",
        "- Use unbrowse_search to find skills other agents have already discovered",
        "- Check unbrowse_skills first to see if you already have a skill for the service",
        "The browser launches automatically — no Chrome extension, no manual steps needed.",
        "IMPORTANT: Do NOT ask the user to manually interact with a browser. Use unbrowse_interact to drive pages yourself.",
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
