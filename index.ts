/**
 * Unbrowse — Self-learning API skill generator.
 *
 * Captures APIs directly from Chrome using the user's real browser profile.
 * No browser extension needed — Playwright launches Chrome with the user's
 * cookies, sessions, and logged-in state to capture all network traffic.
 *
 * Generates complete skill packages (SKILL.md, auth.json, TypeScript API
 * client) and auto-refreshes credentials when they expire.
 *
 * Tools:
 *   unbrowse_capture   — Launch Chrome with real profile, visit URLs, capture API traffic
 *   unbrowse_replay    — Execute API calls (Chrome → direct fetch → auto-refresh on 401)
 *   unbrowse_login     — Log in with credentials via Playwright/stealth (Docker/cloud)
 *   unbrowse_learn     — Parse a HAR file → generate skill
 *   unbrowse_skills    — List all discovered skills
 *   unbrowse_stealth   — Launch stealth cloud browser (BrowserBase)
 *   unbrowse_auth      — Extract auth from clawdbot's managed browser (legacy)
 *   unbrowse_publish   — Publish skill to cloud index (earn USDC via x402)
 *   unbrowse_search    — Search & install skills from the cloud index
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
import { captureFromBrowser, fetchBrowserCookies, fetchCapturedRequests } from "./src/cdp-capture.js";
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
    outputDir: {
      type: "string" as const,
      description: "Directory to save generated skill (default: ~/.clawdbot/skills)",
    },
    profile: {
      type: "string" as const,
      enum: ["chrome", "browser"],
      description:
        "Capture source. 'chrome' (default): launch Chrome with user's real profile — " +
        "all cookies, sessions, and logged-in state available. Requires Chrome to be closed. " +
        "'browser': capture from clawdbot's managed browser (rarely needed).",
    },
    urls: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "URLs to visit. Chrome navigates to each and captures all API traffic. Required for chrome mode.",
    },
    waitMs: {
      type: "number" as const,
      description: "How long to wait on each page for network activity in ms (default: 5000).",
    },
  },
  required: [] as string[],
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
  },
  required: ["loginUrl"],
};

// ── Plugin ────────────────────────────────────────────────────────────────────

const plugin = {
  id: "unbrowse",
  name: "Unbrowse",
  description:
    "Self-learning API skill generator. Captures APIs directly from Chrome using the user's " +
    "real browser profile (cookies, sessions, logged-in state). No browser extension needed — " +
    "uses Playwright to launch Chrome with the user's profile and capture all network traffic. " +
    "Falls back to stealth cloud browsers or credential-based login for Docker/cloud environments.",

  register(api: ClawdbotPluginApi) {
    const cfg = api.pluginConfig ?? {};
    const logger = api.logger;
    const browserPort = (cfg.browserPort as number) ?? 18791;
    const defaultOutputDir = (cfg.skillsOutputDir as string) ?? join(homedir(), ".clawdbot", "skills");
    const browserUseApiKey = cfg.browserUseApiKey as string | undefined;
    const autoDiscoverEnabled = (cfg.autoDiscover as boolean) ?? true;
    const skillIndexUrl = (cfg.skillIndexUrl as string) ?? process.env.UNBROWSE_INDEX_URL ?? "https://skills.unbrowse.ai";
    const creatorWallet = (cfg.creatorWallet as string) ?? process.env.UNBROWSE_CREATOR_WALLET;
    const evmPrivateKey = (cfg.skillIndexEvmPrivateKey as string) ?? process.env.UNBROWSE_EVM_PRIVATE_KEY;

    // ── Skill Index Client ─────────────────────────────────────────────────
    const indexClient = new SkillIndexClient({
      indexUrl: skillIndexUrl,
      creatorWallet,
      evmPrivateKey,
    });

    // ── Auto-Discovery Engine ─────────────────────────────────────────────
    const discovery = new AutoDiscovery({
      outputDir: defaultOutputDir,
      port: browserPort,
      logger,
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

              const summary = [
                `Skill generated: ${result.service}`,
                `Auth: ${result.authMethod}`,
                `Endpoints: ${result.endpointCount}`,
                `Auth headers: ${result.authHeaderCount} | Cookies: ${result.cookieCount}`,
                `Installed: ${result.skillDir}`,
                "",
                `Use ${toPascalCase(result.service)}Client from scripts/api.ts`,
              ].join("\n");

              logger.info(`[unbrowse] Skill: ${result.service} (${result.endpointCount} endpoints)`);
              return { content: [{ type: "text", text: summary }] };
            } catch (err) {
              return { content: [{ type: "text", text: `Skill generation failed: ${(err as Error).message}` }] };
            }
          },
        },

        // ── unbrowse_capture ────────────────────────────────────────
        {
          name: "unbrowse_capture",
          label: "Capture from Chrome",
          description:
            "Capture API traffic using Chrome with the user's real profile. All cookies, " +
            "sessions, and logged-in state are available — no extension needed. Provide URLs to visit " +
            "and Playwright captures all network requests directly. Generates a complete skill package. " +
            "Works whether Chrome is open or closed (auto-detects and connects via CDP or launches). " +
            "Use profile=browser only if connecting to clawdbot's managed browser.",
          parameters: CAPTURE_SCHEMA,
          async execute(_toolCallId: string, params: unknown) {
            const p = params as {
              outputDir?: string;
              profile?: "browser" | "chrome";
              urls?: string[];
              waitMs?: number;
            };

            // Default to chrome profile mode
            const profile = p.profile ?? (p.urls?.length ? "chrome" : "browser");

            // ── Chrome profile mode ──
            if (profile === "chrome") {
              if (!p.urls || p.urls.length === 0) {
                return { content: [{ type: "text", text: "Chrome profile mode requires urls to visit. Provide at least one URL." }] };
              }

              try {
                const { captureFromChromeProfile } = await import("./src/profile-capture.js");
                const { har, cookies, requestCount } = await captureFromChromeProfile(p.urls, {
                  waitMs: p.waitMs,
                });

                if (requestCount === 0) {
                  return { content: [{ type: "text", text: "No API requests captured. The pages may not make API calls, or try waiting longer (waitMs)." }] };
                }

                const apiData = parseHar(har);
                for (const [name, value] of Object.entries(cookies)) {
                  if (!apiData.cookies[name]) apiData.cookies[name] = value;
                }

                const result = await generateSkill(apiData, p.outputDir ?? defaultOutputDir);
                discovery.markLearned(result.service);

                const summary = [
                  `Chrome profile capture: ${requestCount} requests from ${p.urls.length} page(s)`,
                  `Skill: ${result.service}`,
                  `Auth: ${result.authMethod}`,
                  `Endpoints: ${result.endpointCount}`,
                  `Auth headers: ${result.authHeaderCount} | Cookies: ${result.cookieCount}`,
                  `Installed: ${result.skillDir}`,
                ].join("\n");

                logger.info(`[unbrowse] Chrome profile capture → ${result.service} (${result.endpointCount} endpoints)`);
                return { content: [{ type: "text", text: summary }] };
              } catch (err) {
                const msg = (err as Error).message;
                if (msg.includes("Target page, context or browser has been closed")) {
                  return { content: [{ type: "text", text: "Browser context closed unexpectedly. Try again." }] };
                }
                if (msg.includes("playwright")) {
                  return { content: [{ type: "text", text: `Playwright not available: ${msg}. Install with: bun add playwright` }] };
                }
                return { content: [{ type: "text", text: `Chrome capture failed: ${msg}` }] };
              }
            }

            // ── Default: clawdbot browser mode ──
            try {
              const { har, cookies, requestCount } = await captureFromBrowser(browserPort);

              if (requestCount === 0) {
                return { content: [{ type: "text", text: "No requests captured. Open browser and visit pages first." }] };
              }

              const apiData = parseHar(har);
              for (const [name, value] of Object.entries(cookies)) {
                if (!apiData.cookies[name]) apiData.cookies[name] = value;
              }

              const result = await generateSkill(apiData, p.outputDir ?? defaultOutputDir);
              discovery.markLearned(result.service);

              const summary = [
                `Captured ${requestCount} requests`,
                `Skill: ${result.service}`,
                `Auth: ${result.authMethod}`,
                `Endpoints: ${result.endpointCount}`,
                `Installed: ${result.skillDir}`,
              ].join("\n");

              logger.info(`[unbrowse] Capture → ${result.service} (${result.endpointCount} endpoints)`);
              return { content: [{ type: "text", text: summary }] };
            } catch (err) {
              const msg = (err as Error).message;
              if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
                return { content: [{ type: "text", text: `Browser not running on port ${browserPort}. Start browser first, or use profile=chrome to capture with your real Chrome.` }] };
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
            "Extract auth credentials (cookies, headers, tokens) from clawdbot's managed browser. " +
            "For most use cases, prefer unbrowse_capture (uses Chrome profile directly) or " +
            "unbrowse_login (credential-based login for Docker/cloud).",
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
            "Execute API calls using a skill's stored credentials. Cascade: " +
            "1) Run fetch inside Chrome with real cookies/session, " +
            "2) Direct fetch with stored auth headers, " +
            "3) On 401/403 — auto-refresh creds by re-logging in or re-grabbing from Chrome, then retry. " +
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

            async function execInChrome(ep: { method: string; path: string }, body?: string): Promise<{ status: number; ok: boolean; data?: string } | null> {
              try {
                const { chromium } = await import("playwright");
                const { homedir: getHome } = await import("node:os");
                const profilePath = join(getHome(), "Library", "Application Support", "Google", "Chrome");

                const context = await chromium.launchPersistentContext(profilePath, {
                  channel: "chrome",
                  headless: true,
                  args: ["--disable-blink-features=AutomationControlled"],
                  ignoreDefaultArgs: ["--enable-automation"],
                });

                const page = context.pages()[0] ?? await context.newPage();
                await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});

                const url = new URL(ep.path, baseUrl).toString();
                const fetchOpts: Record<string, unknown> = {
                  method: ep.method,
                  headers: { "Content-Type": "application/json", ...authHeaders },
                  credentials: "include",
                };
                if (body && ["POST", "PUT", "PATCH"].includes(ep.method)) {
                  fetchOpts.body = body;
                }

                const result = await page.evaluate(async ({ url, opts }: { url: string; opts: any }) => {
                  try {
                    const resp = await fetch(url, opts);
                    const text = await resp.text().catch(() => "");
                    return { status: resp.status, ok: resp.ok, data: text.slice(0, 2000) };
                  } catch (err) {
                    return { status: 0, ok: false, data: String(err) };
                  }
                }, { url, opts: fetchOpts });

                await context.close();
                return result;
              } catch {
                return null;
              }
            }

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
                signal: AbortSignal.timeout(10_000),
              });
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

              // Strategy 2: re-grab cookies from Chrome profile
              try {
                const { chromium } = await import("playwright");
                const { homedir: getHome } = await import("node:os");
                const profilePath = join(getHome(), "Library", "Application Support", "Google", "Chrome");

                const context = await chromium.launchPersistentContext(profilePath, {
                  channel: "chrome",
                  headless: true,
                  args: ["--disable-blink-features=AutomationControlled"],
                  ignoreDefaultArgs: ["--enable-automation"],
                });

                const page = context.pages()[0] ?? await context.newPage();
                await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});

                // Grab fresh cookies from the browser
                const browserCookies = await context.cookies();
                const freshCookies: Record<string, string> = {};
                for (const c of browserCookies) {
                  freshCookies[c.name] = c.value;
                }
                await context.close();

                if (Object.keys(freshCookies).length > 0) {
                  cookies = freshCookies;

                  // Persist
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
              } catch {
                // Chrome not available
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

                  const summary = [
                    `Stealth capture: ${entries.length} requests`,
                    `Skill: ${result.service}`,
                    `Auth: ${result.authMethod}`,
                    `Endpoints: ${result.endpointCount}`,
                    `Installed: ${result.skillDir}`,
                  ].join("\n");

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
            "List all auto-discovered and manually generated API skills. " +
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

            if (skills.length === 0) {
              return { content: [{ type: "text", text: "No skills discovered yet. Use unbrowse_learn, unbrowse_capture, or browse APIs to auto-discover." }] };
            }

            const autoLabel = autoDiscoverEnabled ? " (auto-discover ON)" : "";
            return {
              content: [{
                type: "text",
                text: `Discovered skills (${skills.length})${autoLabel}:\n${skills.join("\n")}`,
              }],
            };
          },
        },

        // ── unbrowse_publish ───────────────────────────────────────────
        {
          name: "unbrowse_publish",
          label: "Publish Skill",
          description:
            "Publish a locally generated skill to the cloud skill index. " +
            "Only the API definition is published (endpoints, auth method type, base URL). " +
            "Credentials stay local. Your wallet address is embedded for x402 profit sharing.",
          parameters: PUBLISH_SCHEMA,
          async execute(_toolCallId: string, params: unknown) {
            const p = params as { service: string; skillsDir?: string };

            if (!creatorWallet) {
              return {
                content: [{
                  type: "text",
                  text: "No creator wallet configured. Set creatorWallet in unbrowse plugin config or UNBROWSE_CREATOR_WALLET env var (0x address).",
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
            "Search the cloud skill index for API skills discovered by others. " +
            "Searching is free. Installing a skill costs $0.01 USDC via x402 on Base. " +
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
                return { content: [{ type: "text", text: `Install failed: ${(err as Error).message}` }] };
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
            "or inject headers/cookies directly. Captured session is saved to auth.json for the skill.",
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

            const credentials: LoginCredentials = {
              formFields: p.formFields,
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

              const backend = browserUseApiKey ? "stealth cloud (BrowserBase)" : "local Playwright";
              const summary = [
                `Session captured via ${backend}`,
                `Service: ${service}`,
                `Cookies: ${Object.keys(result.cookies).length}`,
                `Auth headers: ${Object.keys(result.authHeaders).length}`,
                `Network requests: ${result.requestCount}`,
                `Base URL: ${result.baseUrl}`,
                `Auth saved: ${join(skillDir, "auth.json")}`,
                skillGenerated ? `Skill generated with ${result.requestCount} captured requests` : "",
                "",
                `The session is ready. Use unbrowse_replay to execute API calls with these credentials.`,
                !skillGenerated && (p.captureUrls?.length ?? 0) === 0
                  ? `Tip: add captureUrls to visit authenticated pages and auto-generate a skill.`
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

    const toolCount = toolNames.length;
    const features = [
      `${toolCount} tools`,
      autoDiscoverEnabled ? "auto-discover" : null,
      browserUseApiKey ? "stealth browsers" : null,
      creatorWallet ? "x402 publishing" : null,
    ].filter(Boolean).join(", ");

    logger.info(`[unbrowse] Plugin registered (${features})`);
  },
};

function toPascalCase(s: string): string {
  return s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

export default plugin;
