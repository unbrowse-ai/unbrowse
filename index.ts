/**
 * Unbrowse — Reverse-engineer internal APIs from any website.
 *
 * Pure TypeScript implementation. Open source, no native binaries.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { parseHar } from "./src/har-parser.js";
import { generateSkill } from "./src/skill-generator.js";
import { guessAuthMethod } from "./src/auth-extractor.js";
import { Vault } from "./src/vault.js";
import { captureFromChromeProfile } from "./src/profile-capture.js";
import { createCredentialProvider, buildFormFields } from "./src/credential-providers.js";
import { getOpenClawBrowser } from "./src/openclaw-browser.js";
import { loginAndCapture } from "./src/session-login.js";
import { sanitizeApiTemplate, extractEndpoints, extractPublishableAuth } from "./src/skill-sanitizer.js";
import { SkillIndexClient } from "./src/skill-index.js";
import { getWorkflowRecorder } from "./src/workflow-recorder.js";
import { getWorkflowLearner } from "./src/workflow-learner.js";
import {
  walletCreate, walletGet, walletGetOrCreate, walletSign, walletSignPayment,
} from "./src/wallet.js";

import type { ApiData } from "./src/types.js";

// Re-export all src modules for library consumers
export { parseHar, mergeOpenApiEndpoints } from "./src/har-parser.js";
export { generateSkill } from "./src/skill-generator.js";
export { guessAuthMethod, generateAuthInfo } from "./src/auth-extractor.js";
export { Vault } from "./src/vault.js";
export { captureFromChromeProfile, captureFromChromeDebug } from "./src/profile-capture.js";
export {
  createCredentialProvider, lookupCredentials, buildFormFields,
  KeychainProvider, OnePasswordProvider, VaultCredentialProvider,
} from "./src/credential-providers.js";
export { getOpenClawBrowser, OpenClawBrowser } from "./src/openclaw-browser.js";
export { loginAndCapture } from "./src/session-login.js";
export { sanitizeApiTemplate, extractEndpoints, extractPublishableAuth } from "./src/skill-sanitizer.js";
export { SkillIndexClient } from "./src/skill-index.js";
export { getWorkflowRecorder, WorkflowRecorder } from "./src/workflow-recorder.js";
export { getWorkflowLearner, WorkflowLearner } from "./src/workflow-learner.js";
export {
  walletCreate, walletGet, walletGetOrCreate, walletSign, walletSignPayment,
  walletVerify, walletPubkey, walletDelete,
} from "./src/wallet.js";
export type * from "./src/types.js";

// ── Constants ────────────────────────────────────────────────────────────────

const SKILLS_DIR = join(homedir(), ".openclaw", "skills");
const MARKETPLACE_URL = "https://index.unbrowse.ai";

// Read version from package.json at module level
let PKG_VERSION = "0.0.0";
try {
  const pkgPath = new URL("./package.json", import.meta.url);
  PKG_VERSION = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
} catch {
  // Fallback — running from compiled dist
  try {
    const pkgPath = join(new URL(".", import.meta.url).pathname, "..", "package.json");
    PKG_VERSION = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
  } catch { /* ignore */ }
}

// ── Helper functions ─────────────────────────────────────────────────────────

/** List all locally captured skill service names. */
function listSkills(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(SKILLS_DIR, d.name, "SKILL.md")))
    .map(d => d.name);
}

/** Get basic info about a local skill by reading its SKILL.md frontmatter. */
function getSkillInfo(service: string): { name: string; endpointsCount: number; version?: string; authMethod?: string } | null {
  const skillMdPath = join(SKILLS_DIR, service, "SKILL.md");
  if (!existsSync(skillMdPath)) return null;

  const content = readFileSync(skillMdPath, "utf-8");
  const endpoints = extractEndpoints(content);

  // Parse YAML frontmatter
  const nameMatch = content.match(/^name:\s*(.+)$/m);
  const versionMatch = content.match(/version:\s*"?([^"\n]+)"?/m);
  const authMatch = content.match(/authMethod:\s*"?([^"\n]+)"?/m);

  return {
    name: nameMatch?.[1]?.trim() || service,
    endpointsCount: endpoints.length,
    version: versionMatch?.[1]?.trim(),
    authMethod: authMatch?.[1]?.trim(),
  };
}

/** Extract auth from current browser session (cookies, storage, captured headers). */
async function extractBrowserAuth(domain: string, port?: number): Promise<{
  service: string;
  baseUrl: string;
  authMethod: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
}> {
  const browser = getOpenClawBrowser(port);
  const [cookies, localStorage, sessionStorage, requests] = await Promise.all([
    browser.cookies(),
    browser.storage("local"),
    browser.storage("session"),
    browser.requests(),
  ]);

  // Extract auth headers from captured requests
  const authHeaders: Record<string, string> = {};
  const AUTH_NAMES = new Set([
    "authorization", "x-api-key", "api-key", "apikey",
    "x-auth-token", "access-token", "x-access-token",
    "token", "x-token", "x-csrf-token", "x-xsrf-token",
  ]);

  for (const req of requests) {
    if (!req.headers) continue;
    for (const [name, value] of Object.entries(req.headers)) {
      if (AUTH_NAMES.has(name.toLowerCase())) {
        authHeaders[name.toLowerCase()] = value;
      }
    }
  }

  // Promote JWT tokens from storage
  for (const [key, value] of [...Object.entries(localStorage), ...Object.entries(sessionStorage)]) {
    const lk = key.toLowerCase();
    if (value && (value.startsWith("eyJ") || /^Bearer\s/i.test(value))) {
      const tokenValue = value.startsWith("eyJ") ? `Bearer ${value}` : value;
      if (lk.includes("access") || lk.includes("auth") || lk.includes("token")) {
        authHeaders["authorization"] = tokenValue;
      }
    }
    if (lk.includes("csrf") || lk.includes("xsrf")) {
      authHeaders["x-csrf-token"] = value;
    }
  }

  const serviceName = domain
    .replace(/^(www|api|v\d+|.*serv)\./, "")
    .replace(/\.(com|org|net|co|io|ai|app|sg|dev|xyz)\.?$/g, "")
    .replace(/\./g, "-")
    .toLowerCase() || "unknown-api";

  const baseUrl = `https://${domain}`;
  const authMethod = guessAuthMethod(authHeaders, cookies);

  return {
    service: serviceName,
    baseUrl,
    authMethod,
    headers: authHeaders,
    cookies,
  };
}

/** Test a single endpoint with auth. */
async function testSingleEndpoint(
  baseUrl: string,
  method: string,
  path: string,
  authHeaders: Record<string, string>,
  cookies: Record<string, string>,
  timeoutMs = 30000,
): Promise<{
  status: number;
  latencyMs: number;
  responseShape?: string;
  responseSize?: number;
  error?: string;
}> {
  let url: string;
  try {
    url = new URL(path, baseUrl).toString();
  } catch {
    url = `${baseUrl.replace(/\/$/, "")}${path}`;
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...authHeaders,
  };
  if (Object.keys(cookies).length > 0) {
    headers["Cookie"] = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: method !== "GET" && method !== "HEAD" ? undefined : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await resp.text().catch(() => "");
    const latencyMs = Date.now() - start;

    let responseShape = "empty";
    if (text.length > 0) {
      try {
        const json = JSON.parse(text);
        if (Array.isArray(json)) {
          responseShape = `array[${json.length}]`;
        } else if (typeof json === "object" && json !== null) {
          const keys = Object.keys(json);
          responseShape = `object{${keys.slice(0, 5).join(",")}}`;
        } else {
          responseShape = typeof json;
        }
      } catch {
        responseShape = text.length > 200 ? "html/text" : "non-json";
      }
    }

    return {
      status: resp.status,
      latencyMs,
      responseShape,
      responseSize: text.length,
    };
  } catch (err: any) {
    return {
      status: 0,
      latencyMs: Date.now() - start,
      error: err?.message || "Request failed",
    };
  }
}

/** Prepare a skill for publishing (strip credentials). */
function prepareForPublish(
  skillMd: string,
  apiTs?: string,
  authJsonStr?: string,
): {
  service: string;
  skillMd: string;
  apiTs?: string;
  authMethod: string;
  baseUrl: string;
  endpoints: { method: string; path: string; description: string }[];
  description?: string;
  tags?: string[];
  priceUsdc?: number;
} {
  const sanitizedApiTs = apiTs ? sanitizeApiTemplate(apiTs) : undefined;
  const endpoints = extractEndpoints(skillMd);
  const { baseUrl, authMethodType } = extractPublishableAuth(authJsonStr || "{}");

  const nameMatch = skillMd.match(/^name:\s*(.+)$/m);
  const service = nameMatch?.[1]?.trim() || "unknown";

  return {
    service,
    skillMd,
    apiTs: sanitizedApiTs,
    authMethod: authMethodType,
    baseUrl,
    endpoints,
  };
}

// ── Plugin Entry Point ───────────────────────────────────────────────────────

export default function unbrowsePlugin(api: any) {
  // =========================================================================
  // Tool: unbrowse_capture
  // =========================================================================
  api.registerTool({
    name: "unbrowse_capture",
    description: `Capture internal API traffic from browser and generate a skill.

Visit URLs in the browser, capture all API calls, extract auth tokens, and generate a reusable skill package.

Returns: Skill with endpoints, auth method, and generated TypeScript client.`,
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "URLs to visit and capture API traffic from",
        },
        output_dir: {
          type: "string",
          description: "Optional output directory for skill files",
        },
      },
      required: ["urls"],
    },
    async execute(args: { urls: string[]; output_dir?: string }) {
      const captureResult = await captureFromChromeProfile(args.urls);
      const seedUrl = args.urls[0];
      const apiData = parseHar(captureResult.har, seedUrl);
      const result = await generateSkill(apiData, args.output_dir);

      return {
        success: true,
        service: result.service,
        skill_dir: result.skillDir,
        endpoints_count: result.endpointCount,
        auth_method: result.authMethod,
        message: `Captured ${result.endpointCount} endpoints from ${result.service}. Skill saved to ${result.skillDir}`,
      };
    },
  });

  // =========================================================================
  // Tool: unbrowse_replay
  // =========================================================================
  api.registerTool({
    name: "unbrowse_replay",
    description: `Call an internal API endpoint using captured auth.

Execute HTTP requests against internal APIs with proper authentication headers and cookies.

Returns: Response status, body, and timing.`,
    parameters: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Service name (skill name) to use for auth",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method",
        },
        path: {
          type: "string",
          description: "API path (e.g., /api/users)",
        },
        body: {
          type: "string",
          description: "Request body (JSON string)",
        },
      },
      required: ["service", "method", "path"],
    },
    async execute(args: { service: string; method: string; path: string; body?: string }) {
      const skillInfo = getSkillInfo(args.service);
      if (!skillInfo) {
        return { success: false, error: `Skill not found: ${args.service}` };
      }

      let authHeaders: Record<string, string> = {};
      let cookies: Record<string, string> = {};
      let baseUrl = `https://${args.service}`;

      try {
        const vault = new Vault();
        const vaultEntry = vault.get(args.service);
        vault.close();
        if (vaultEntry) {
          authHeaders = vaultEntry.headers || {};
          cookies = vaultEntry.cookies || {};
          baseUrl = vaultEntry.baseUrl || baseUrl;
        }
      } catch {
        // Vault not available — try auth.json fallback
        const authJsonPath = join(SKILLS_DIR, args.service, "auth.json");
        if (existsSync(authJsonPath)) {
          try {
            const auth = JSON.parse(readFileSync(authJsonPath, "utf-8"));
            authHeaders = auth.headers || {};
            cookies = auth.cookies || {};
            baseUrl = auth.baseUrl || baseUrl;
          } catch { /* ignore parse errors */ }
        }
      }

      const result = await testSingleEndpoint(baseUrl, args.method, args.path, authHeaders, cookies, 30000);

      return {
        success: result.status >= 200 && result.status < 400,
        status: result.status,
        latency_ms: result.latencyMs,
        response_shape: result.responseShape,
        response_size: result.responseSize,
        error: result.error,
      };
    },
  });

  // =========================================================================
  // Tool: unbrowse_login
  // =========================================================================
  api.registerTool({
    name: "unbrowse_login",
    description: `Login to a website and capture session auth.

Navigates to login page, fills credentials, and captures resulting session cookies/tokens.

Returns: Captured auth headers and cookies.`,
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Login page URL",
        },
        username: {
          type: "string",
          description: "Username or email (optional - will lookup from keychain)",
        },
        password: {
          type: "string",
          description: "Password (optional - will lookup from keychain)",
        },
      },
      required: ["url"],
    },
    async execute(args: { url: string; username?: string; password?: string }) {
      const domain = new URL(args.url).hostname;
      let username = args.username;
      let password = args.password;

      if (!username || !password) {
        const provider = createCredentialProvider("auto");
        if (provider) {
          const creds = await provider.lookup(domain);
          if (creds.length > 0) {
            username = username || creds[0].username;
            password = password || creds[0].password;
          }
        }
      }

      if (!username || !password) {
        return { success: false, error: "Credentials not provided and not found in keychain" };
      }

      const formFields = buildFormFields({ username, password, source: "keychain" });

      const loginResult = await loginAndCapture(args.url, { formFields });

      // Derive service name
      const serviceName = domain
        .replace(/^(www|api|v\d+|.*serv)\./, "")
        .replace(/\.(com|org|net|co|io|ai|app|sg|dev|xyz)\.?$/g, "")
        .replace(/\./g, "-")
        .toLowerCase() || "unknown-api";

      const authMethod = guessAuthMethod(loginResult.authHeaders, loginResult.cookies);

      // Store in vault
      try {
        const vault = new Vault();
        vault.store(serviceName, {
          baseUrl: loginResult.baseUrl,
          authMethod,
          headers: Object.keys(loginResult.authHeaders).length > 0 ? loginResult.authHeaders : undefined,
          cookies: Object.keys(loginResult.cookies).length > 0 ? loginResult.cookies : undefined,
        });
        vault.close();
      } catch { /* vault not available */ }

      return {
        success: true,
        service: serviceName,
        auth_method: authMethod,
        headers_count: Object.keys(loginResult.authHeaders).length,
        cookies_count: Object.keys(loginResult.cookies).length,
        message: `Logged in and captured auth for ${serviceName}`,
      };
    },
  });

  // =========================================================================
  // Tool: unbrowse_learn
  // =========================================================================
  api.registerTool({
    name: "unbrowse_learn",
    description: `Parse a HAR file and generate an API skill.

Takes a HAR file (from browser DevTools export) and generates a complete skill package.

Returns: Generated skill with endpoints and auth.`,
    parameters: {
      type: "object",
      properties: {
        har_path: {
          type: "string",
          description: "Path to HAR file",
        },
        seed_url: {
          type: "string",
          description: "Seed URL to determine service name",
        },
        output_dir: {
          type: "string",
          description: "Optional output directory",
        },
      },
      required: ["har_path"],
    },
    async execute(args: { har_path: string; seed_url?: string; output_dir?: string }) {
      if (!existsSync(args.har_path)) {
        return { success: false, error: `HAR file not found: ${args.har_path}` };
      }

      const harJson = readFileSync(args.har_path, "utf-8");
      const har = JSON.parse(harJson);
      const apiData = parseHar(har, args.seed_url);
      const result = await generateSkill(apiData, args.output_dir);

      // Store in vault
      try {
        const vault = new Vault();
        vault.store(apiData.service, {
          baseUrl: apiData.baseUrl,
          authMethod: apiData.authMethod,
          headers: Object.keys(apiData.authHeaders).length > 0 ? apiData.authHeaders : undefined,
          cookies: Object.keys(apiData.cookies).length > 0 ? apiData.cookies : undefined,
        });
        vault.close();
      } catch { /* vault not available */ }

      return {
        success: true,
        service: result.service,
        skill_dir: result.skillDir,
        endpoints_count: result.endpointCount,
        auth_method: result.authMethod,
      };
    },
  });

  // =========================================================================
  // Tool: unbrowse_skills
  // =========================================================================
  api.registerTool({
    name: "unbrowse_skills",
    description: `List all captured API skills.

Shows locally learned skills with their endpoints and auth methods.`,
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      const skills = listSkills();
      const details = skills.map((service: string) => {
        const info = getSkillInfo(service);
        return {
          service,
          name: info?.name,
          endpoints: info?.endpointsCount || 0,
          version: info?.version,
        };
      });

      return { success: true, count: skills.length, skills: details };
    },
  });

  // =========================================================================
  // Tool: unbrowse_auth
  // =========================================================================
  api.registerTool({
    name: "unbrowse_auth",
    description: `Extract auth from current browser session.

Captures cookies, localStorage, and request headers from the browser.`,
    parameters: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Domain to extract auth for",
        },
      },
      required: ["domain"],
    },
    async execute(args: { domain: string }) {
      const authJson = await extractBrowserAuth(args.domain);

      try {
        const vault = new Vault();
        vault.store(authJson.service, {
          baseUrl: authJson.baseUrl,
          authMethod: authJson.authMethod,
          headers: Object.keys(authJson.headers).length > 0 ? authJson.headers : undefined,
          cookies: Object.keys(authJson.cookies).length > 0 ? authJson.cookies : undefined,
        });
        vault.close();
      } catch { /* vault not available */ }

      return {
        success: true,
        service: authJson.service,
        auth_method: authJson.authMethod,
        base_url: authJson.baseUrl,
        headers: Object.keys(authJson.headers),
        cookies: Object.keys(authJson.cookies),
      };
    },
  });

  // =========================================================================
  // Tool: unbrowse_publish
  // =========================================================================
  api.registerTool({
    name: "unbrowse_publish",
    description: `Publish a skill to the marketplace.

Shares your API skill for others to use. Credentials are stripped before publishing.`,
    parameters: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Service name to publish",
        },
        description: {
          type: "string",
          description: "Description of the skill",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for discoverability",
        },
        price_usdc: {
          type: "number",
          description: "Price in USDC (0 for free)",
        },
      },
      required: ["service"],
    },
    async execute(args: { service: string; description?: string; tags?: string[]; price_usdc?: number }) {
      const skillDir = join(SKILLS_DIR, args.service);
      const skillMdPath = join(skillDir, "SKILL.md");
      const apiTsPath = join(skillDir, "scripts", "api.ts");
      const authJsonPath = join(skillDir, "auth.json");

      if (!existsSync(skillMdPath)) {
        return { success: false, error: `Skill not found: ${args.service}` };
      }

      const skillMd = readFileSync(skillMdPath, "utf-8");
      const apiTs = existsSync(apiTsPath) ? readFileSync(apiTsPath, "utf-8") : undefined;
      const authJsonStr = existsSync(authJsonPath) ? readFileSync(authJsonPath, "utf-8") : "{}";

      const payload = prepareForPublish(skillMd, apiTs, authJsonStr);

      const wallet = walletGetOrCreate();
      const message = JSON.stringify({ service: args.service, timestamp: Date.now() });
      const signature = walletSign(message);

      const client = new SkillIndexClient({ indexUrl: MARKETPLACE_URL, creatorWallet: wallet.pubkey });
      const result = await client.publish({
        name: payload.service,
        description: args.description || payload.service,
        skillMd: payload.skillMd,
        scripts: payload.apiTs ? { "api.ts": payload.apiTs } : undefined,
        authType: payload.authMethod,
        serviceName: payload.service,
        domain: payload.baseUrl,
        creatorWallet: wallet.pubkey,
        priceUsdc: args.price_usdc !== undefined ? String(args.price_usdc) : undefined,
      });

      return {
        success: result.success,
        id: result.skill.skillId,
        name: result.skill.name,
        service: payload.service,
      };
    },
  });

  // =========================================================================
  // Tool: unbrowse_search
  // =========================================================================
  api.registerTool({
    name: "unbrowse_search",
    description: `Search the skill marketplace.

Find API skills others have created and shared.`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
      },
      required: ["query"],
    },
    async execute(args: { query: string }) {
      const client = new SkillIndexClient({ indexUrl: MARKETPLACE_URL });
      const searchResult = await client.search(args.query);

      return {
        success: true,
        count: searchResult.skills.length,
        skills: searchResult.skills.map((s) => ({
          id: s.skillId,
          name: s.name,
          service: s.serviceName,
          description: s.description,
          author: s.creatorWallet,
          endpoints: 0,
          installs: s.downloadCount,
          price_usdc: s.priceUsdc,
          badge: s.badge,
        })),
      };
    },
  });

  // =========================================================================
  // Tool: unbrowse_download
  // =========================================================================
  api.registerTool({
    name: "unbrowse_download",
    description: `Download a skill from the marketplace.

Install a skill locally. May require x402 payment for paid skills.`,
    parameters: {
      type: "object",
      properties: {
        skill_id: {
          type: "string",
          description: "Skill ID to download",
        },
      },
      required: ["skill_id"],
    },
    async execute(args: { skill_id: string }) {
      const client = new SkillIndexClient({ indexUrl: MARKETPLACE_URL });

      const skillInfo = await client.getSkillSummary(args.skill_id);
      if (!skillInfo) {
        return { success: false, error: `Skill not found: ${args.skill_id}` };
      }

      const pkg = await client.download(args.skill_id);

      const skillDir = join(SKILLS_DIR, pkg.skillId);
      mkdirSync(join(skillDir, "scripts"), { recursive: true });
      mkdirSync(join(skillDir, "references"), { recursive: true });

      writeFileSync(join(skillDir, "SKILL.md"), pkg.skillMd);
      if (pkg.scripts) {
        for (const [name, content] of Object.entries(pkg.scripts)) {
          writeFileSync(join(skillDir, "scripts", name), content);
        }
      }
      if (pkg.references) {
        for (const [name, content] of Object.entries(pkg.references)) {
          writeFileSync(join(skillDir, "references", name), content);
        }
      }

      await client.reportInstallation({ skillId: args.skill_id }).catch(() => {});

      return {
        success: true,
        id: pkg.skillId,
        skill_dir: skillDir,
        endpoints: extractEndpoints(pkg.skillMd).length,
        auth_method: pkg.authType,
      };
    },
  });

  // =========================================================================
  // Tool: unbrowse_wallet
  // =========================================================================
  api.registerTool({
    name: "unbrowse_wallet",
    description: `Manage your marketplace wallet.

Create or view your Ed25519 wallet for x402 payments.`,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get", "create"],
          description: "Action to perform",
        },
      },
      required: ["action"],
    },
    async execute(args: { action: "get" | "create" }) {
      if (args.action === "create") {
        const existing = walletGet();
        if (existing) {
          return { success: true, pubkey: existing.pubkey, created_at: existing.createdAt, message: "Wallet already exists" };
        }
        const wallet = walletCreate();
        return { success: true, pubkey: wallet.pubkey, created_at: wallet.createdAt, message: "Created new wallet" };
      } else {
        const wallet = walletGet();
        if (!wallet) {
          return { success: false, error: "No wallet found. Use action: create" };
        }
        return { success: true, pubkey: wallet.pubkey, created_at: wallet.createdAt };
      }
    },
  });

  // =========================================================================
  // Tool: unbrowse_record
  // =========================================================================
  api.registerTool({
    name: "unbrowse_record",
    description: `Record a workflow session.

Start/stop recording browser interactions to learn multi-step workflows.`,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "stop", "status"],
          description: "Recording action",
        },
      },
      required: ["action"],
    },
    async execute(args: { action: "start" | "stop" | "status" }) {
      const recorder = getWorkflowRecorder();

      if (args.action === "start") {
        const id = recorder.startSession();
        return { success: true, session_id: id, message: "Recording started" };
      } else if (args.action === "stop") {
        const session = recorder.stopSession();
        if (!session) {
          return { success: false, error: "No active recording" };
        }

        const learner = getWorkflowLearner();
        const learned = learner.learnFromSession(session);
        const skillDir = learner.saveSkill(learned);

        return {
          success: true,
          session_id: session.sessionId,
          steps: session.entries.length,
          domains: session.domains,
          workflow_name: learned.skill.name,
          skill_dir: skillDir,
        };
      } else {
        const info = recorder.getSessionInfo();
        return {
          success: true,
          is_active: recorder.isRecording(),
          session: info ? { id: info.sessionId, steps: info.entryCount, domains: info.domains } : null,
        };
      }
    },
  });

  return {
    name: "unbrowse",
    version: PKG_VERSION,
    native: false,
  };
}
