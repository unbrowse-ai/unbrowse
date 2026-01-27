/**
 * Unbrowse — Self-learning API skill generator.
 *
 * Automatically discovers APIs as the agent browses, generates clawdbot
 * skills on the fly (SKILL.md, auth.json, TypeScript API client), and
 * supports stealth cloud browsers for bypassing restrictions.
 *
 * Tools:
 *   unbrowse_learn     — Parse a HAR file → generate skill
 *   unbrowse_capture   — Capture live browser traffic → generate skill
 *   unbrowse_auth      — Extract auth from running browser session
 *   unbrowse_replay    — Test discovered endpoints with extracted auth
 *   unbrowse_stealth   — Launch stealth cloud browser (Browser Use)
 *   unbrowse_skills    — List all auto-discovered skills
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

// ── Plugin ────────────────────────────────────────────────────────────────────

const plugin = {
  id: "unbrowse",
  name: "Unbrowse",
  description:
    "Self-learning API skill generator. Auto-discovers APIs as the agent browses, " +
    "generates skills on the fly, and supports stealth cloud browsers for bypassing restrictions.",

  register(api: ClawdbotPluginApi) {
    const cfg = api.pluginConfig ?? {};
    const logger = api.logger;
    const browserPort = (cfg.browserPort as number) ?? 18791;
    const defaultOutputDir = (cfg.skillsOutputDir as string) ?? join(homedir(), ".clawdbot", "skills");
    const browserUseApiKey = cfg.browserUseApiKey as string | undefined;
    const autoDiscoverEnabled = (cfg.autoDiscover as boolean) ?? true;

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
          label: "Capture from Browser",
          description:
            "Capture network traffic from the current browser session and generate " +
            "a skill. Browser must be open with pages visited.",
          parameters: CAPTURE_SCHEMA,
          async execute(_toolCallId: string, params: unknown) {
            const p = params as { outputDir?: string };

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
                return { content: [{ type: "text", text: `Browser not running on port ${browserPort}. Start browser first.` }] };
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
            "Extract auth credentials (cookies, headers, tokens) from a running browser session.",
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
          label: "Test Endpoints",
          description:
            "Test discovered endpoints for a skill. Loads auth.json and verifies endpoints are alive.",
          parameters: REPLAY_SCHEMA,
          async execute(_toolCallId: string, params: unknown) {
            const p = params as { service: string; skillsDir?: string };
            const skillsDir = p.skillsDir ?? defaultOutputDir;
            const skillDir = join(skillsDir, p.service);
            const authPath = join(skillDir, "auth.json");
            const skillMdPath = join(skillDir, "SKILL.md");

            if (!existsSync(skillDir)) {
              return { content: [{ type: "text", text: `Skill not found: ${skillDir}` }] };
            }

            let headers: Record<string, string> = {};
            let cookieHeader = "";
            let baseUrl = "https://api.example.com";

            if (existsSync(authPath)) {
              try {
                const auth = JSON.parse(readFileSync(authPath, "utf-8"));
                headers = auth.headers ?? {};
                baseUrl = auth.baseUrl ?? baseUrl;
                if (auth.cookies && Object.keys(auth.cookies).length > 0) {
                  cookieHeader = Object.entries(auth.cookies as Record<string, string>)
                    .map(([k, v]) => `${k}=${v}`)
                    .join("; ");
                }
              } catch {
                return { content: [{ type: "text", text: "Failed to load auth.json" }] };
              }
            }

            const endpoints: { method: string; path: string }[] = [];
            if (existsSync(skillMdPath)) {
              const md = readFileSync(skillMdPath, "utf-8");
              const re = /`(GET|POST|PUT|DELETE|PATCH)\s+([^`]+)`/g;
              let m;
              while ((m = re.exec(md)) !== null) {
                endpoints.push({ method: m[1], path: m[2] });
              }
            }

            if (endpoints.length === 0) {
              return { content: [{ type: "text", text: "No endpoints found in SKILL.md" }] };
            }

            const results: string[] = [`Testing ${p.service} (${endpoints.length} endpoints)`, `Base: ${baseUrl}`, ""];
            let passed = 0;
            let failed = 0;

            for (const ep of endpoints.slice(0, 10)) {
              const reqHeaders: Record<string, string> = { ...headers, "Content-Type": "application/json" };
              if (cookieHeader) reqHeaders["Cookie"] = cookieHeader;

              try {
                const url = new URL(ep.path, baseUrl).toString();
                const resp = await fetch(url, {
                  method: ep.method,
                  headers: reqHeaders,
                  body: ["POST", "PUT", "PATCH"].includes(ep.method) ? "{}" : undefined,
                  signal: AbortSignal.timeout(10_000),
                });
                results.push(`  ${ep.method} ${ep.path} → ${resp.status} ${resp.ok ? "OK" : resp.statusText}`);
                if (resp.ok) passed++; else failed++;
              } catch (err) {
                results.push(`  ${ep.method} ${ep.path} → FAILED: ${String(err).slice(0, 60)}`);
                failed++;
              }
            }

            results.push("", `Results: ${passed} passed, ${failed} failed`);
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
    ].filter(Boolean).join(", ");

    logger.info(`[unbrowse] Plugin registered (${features})`);
  },
};

function toPascalCase(s: string): string {
  return s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

export default plugin;
