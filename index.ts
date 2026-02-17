import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { fetchBrowserCookies, captureFromBrowser } from "./src/cdp-capture.js";
import { parseHar } from "./src/har-parser.js";
import { generateSkill } from "./src/skill-generator.js";

type StringMap = Record<string, string>;

type VaultEntry = {
  baseUrl?: string;
  authMethod?: string;
  headers?: StringMap;
  cookies?: StringMap;
  updatedAt?: string;
};

type VaultDb = Record<string, VaultEntry>;

const SKILLS_DIR = join(homedir(), ".openclaw", "skills");
const UNBROWSE_DIR = join(homedir(), ".openclaw", "unbrowse");
const VAULT_PATH = join(UNBROWSE_DIR, "vault.json");
const INDEX_URL = (process.env.UNBROWSE_INDEX_URL ?? "https://index.unbrowse.ai").replace(/\/$/, "");

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function toServiceName(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/^www\./, "")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/\./g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "unknown-service";
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function loadVault(): VaultDb {
  if (!existsSync(VAULT_PATH)) return {};
  return safeJsonParse<VaultDb>(readFileSync(VAULT_PATH, "utf-8"), {});
}

function saveVault(vault: VaultDb): void {
  ensureDir(UNBROWSE_DIR);
  writeFileSync(VAULT_PATH, JSON.stringify(vault, null, 2), "utf-8");
}

function upsertVault(service: string, next: VaultEntry): VaultEntry {
  const vault = loadVault();
  const merged: VaultEntry = {
    ...(vault[service] ?? {}),
    ...next,
    headers: { ...((vault[service]?.headers ?? {}) as StringMap), ...(next.headers ?? {}) },
    cookies: { ...((vault[service]?.cookies ?? {}) as StringMap), ...(next.cookies ?? {}) },
    updatedAt: new Date().toISOString(),
  };
  vault[service] = merged;
  saveVault(vault);
  return merged;
}

function detectAuthMethod(headers: StringMap, cookies: StringMap): string {
  const keys = Object.keys(headers).map((k) => k.toLowerCase());
  if (keys.includes("authorization")) return "bearer";
  if (keys.some((k) => k.includes("api-key") || k === "x-api-key" || k === "apikey")) return "api_key";
  if (Object.keys(cookies).length > 0) return "cookie";
  return "none";
}

function readSkillAuth(service: string): VaultEntry | null {
  const authPath = join(SKILLS_DIR, service, "auth.json");
  if (!existsSync(authPath)) return null;
  const auth = safeJsonParse<any>(readFileSync(authPath, "utf-8"), {});
  return {
    baseUrl: typeof auth.baseUrl === "string" ? auth.baseUrl : `https://${service.replace(/-/g, ".")}`,
    authMethod: typeof auth.authMethod === "string" ? auth.authMethod : detectAuthMethod(auth.headers ?? {}, auth.cookies ?? {}),
    headers: (auth.headers ?? {}) as StringMap,
    cookies: (auth.cookies ?? {}) as StringMap,
  };
}

function getAuth(service: string): VaultEntry | null {
  const vault = loadVault();
  const entry = vault[service];
  if (entry) {
    return {
      baseUrl: entry.baseUrl ?? `https://${service.replace(/-/g, ".")}`,
      authMethod: entry.authMethod ?? detectAuthMethod(entry.headers ?? {}, entry.cookies ?? {}),
      headers: entry.headers ?? {},
      cookies: entry.cookies ?? {},
      updatedAt: entry.updatedAt,
    };
  }
  const fromSkill = readSkillAuth(service);
  if (fromSkill) {
    return upsertVault(service, fromSkill);
  }
  return null;
}

function countEndpoints(skillMd: string): number {
  const matches = skillMd.match(/^- `(GET|POST|PUT|PATCH|DELETE)\s+[^`]+`/gm);
  return matches ? matches.length : 0;
}

function buildResponseShape(data: unknown): string {
  if (Array.isArray(data)) return `array(${data.length})`;
  if (data && typeof data === "object") return `object(${Object.keys(data as Record<string, unknown>).slice(0, 10).join(",")})`;
  return typeof data;
}

function trimText(text: string, max = 60000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...<truncated ${text.length - max} chars>`;
}

function withContent(payload: Record<string, unknown>): Record<string, unknown> {
  const text = trimText(JSON.stringify(payload, null, 2));
  return {
    ...payload,
    content: [{ type: "text", text }],
  };
}

function resolveRequestUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

async function readMarketplaceSkillSummary(skillId: string): Promise<any | null> {
  const resp = await fetch(`${INDEX_URL}/marketplace/skills/${encodeURIComponent(skillId)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.skill ?? null;
}

export default function unbrowsePlugin(api: any) {
  api.registerTool({
    name: "unbrowse_capture",
    description: `Capture internal API traffic from an active OpenClaw browser session and generate a skill.`,
    parameters: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "Visited URLs (seed URL first)." },
        output_dir: { type: "string", description: "Optional output directory for generated skill files." },
      },
      required: ["urls"],
    },
    async execute(args: { urls: string[]; output_dir?: string }) {
      try {
        const capture = await captureFromBrowser();
        if (!capture.requestCount) {
          return withContent({
            success: false,
            error: "No browser requests captured. Start OpenClaw browser, browse target site, then retry.",
          });
        }

        const apiData = parseHar(capture.har as any, args.urls?.[0]);
        if (!Object.keys(apiData.endpoints ?? {}).length) {
          return withContent({ success: false, error: "Capture had no API-like endpoints." });
        }

        const result = await generateSkill(apiData as any, args.output_dir);
        upsertVault(result.service, {
          baseUrl: apiData.baseUrl,
          authMethod: apiData.authMethod,
          headers: apiData.authHeaders,
          cookies: apiData.cookies,
        });

        return withContent({
          success: true,
          service: result.service,
          skill_dir: result.skillDir,
          endpoints_count: result.endpointCount,
          auth_method: apiData.authMethod,
          captured_requests: capture.requestCount,
          changed: result.changed,
          diff: result.diff ?? null,
          version_hash: result.versionHash ?? null,
        });
      } catch (err) {
        return withContent({ success: false, error: (err as Error).message });
      }
    },
  });

  api.registerTool({
    name: "unbrowse_replay",
    description: `Call an endpoint using locally captured auth (JS runtime, no native module).`,
    parameters: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service/skill name." },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method." },
        path: { type: "string", description: "API path or absolute URL." },
        body: { type: "string", description: "Optional JSON/string body." },
      },
      required: ["service", "method", "path"],
    },
    async execute(args: { service: string; method: string; path: string; body?: string }) {
      const auth = getAuth(args.service);
      if (!auth) return withContent({ success: false, error: `No auth found for service: ${args.service}` });

      const baseUrl = auth.baseUrl ?? `https://${args.service.replace(/-/g, ".")}`;
      const url = resolveRequestUrl(baseUrl, args.path);
      const method = args.method.toUpperCase();

      const headers: StringMap = { ...(auth.headers ?? {}) };
      const cookies = auth.cookies ?? {};
      if (Object.keys(cookies).length > 0 && !headers.cookie && !headers.Cookie) {
        headers.Cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
      }

      let parsedBody: unknown = undefined;
      if (typeof args.body === "string" && args.body.length > 0) {
        parsedBody = safeJsonParse(args.body, args.body);
        if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
      }

      const started = Date.now();
      try {
        const resp = await fetch(url, {
          method,
          headers,
          body: parsedBody === undefined ? undefined : (typeof parsedBody === "string" ? parsedBody : JSON.stringify(parsedBody)),
          signal: AbortSignal.timeout(30000),
        });

        const raw = await resp.text();
        const parsed = safeJsonParse(raw, raw);

        return withContent({
          success: resp.ok,
          status: resp.status,
          latency_ms: Date.now() - started,
          response_size: raw.length,
          response_shape: buildResponseShape(parsed),
          body: typeof parsed === "string" ? trimText(parsed, 20000) : parsed,
        });
      } catch (err) {
        return withContent({
          success: false,
          status: 0,
          latency_ms: Date.now() - started,
          error: (err as Error).message,
        });
      }
    },
  });

  api.registerTool({
    name: "unbrowse_login",
    description: `Seed auth from an already logged-in browser session (cookie capture).`,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Site URL (used for service naming/base URL)." },
        headers: { type: "object", description: "Optional manual headers to store." },
        cookies: { type: "object", description: "Optional manual cookies to store." },
      },
      required: ["url"],
    },
    async execute(args: { url: string; headers?: StringMap; cookies?: StringMap }) {
      let parsed: URL;
      try {
        parsed = new URL(args.url);
      } catch {
        return withContent({ success: false, error: `Invalid URL: ${args.url}` });
      }

      const service = toServiceName(parsed.hostname);
      let cookies = (args.cookies ?? {}) as StringMap;
      if (!Object.keys(cookies).length) {
        try {
          cookies = await fetchBrowserCookies();
        } catch {
          cookies = {};
        }
      }

      const headers = (args.headers ?? {}) as StringMap;
      if (!Object.keys(headers).length && !Object.keys(cookies).length) {
        return withContent({
          success: false,
          error: "No auth material captured. Log in via OpenClaw browser first or pass headers/cookies manually.",
        });
      }

      const saved = upsertVault(service, {
        baseUrl: `${parsed.protocol}//${parsed.host}`,
        authMethod: detectAuthMethod(headers, cookies),
        headers,
        cookies,
      });

      return withContent({
        success: true,
        service,
        base_url: saved.baseUrl,
        auth_method: saved.authMethod,
        headers_count: Object.keys(saved.headers ?? {}).length,
        cookies_count: Object.keys(saved.cookies ?? {}).length,
      });
    },
  });

  api.registerTool({
    name: "unbrowse_learn",
    description: `Parse a HAR file and generate a local skill package (JS runtime).`,
    parameters: {
      type: "object",
      properties: {
        har_path: { type: "string", description: "Path to HAR file." },
        seed_url: { type: "string", description: "Optional seed URL for domain/service resolution." },
        output_dir: { type: "string", description: "Optional output directory for skill files." },
      },
      required: ["har_path"],
    },
    async execute(args: { har_path: string; seed_url?: string; output_dir?: string }) {
      if (!existsSync(args.har_path)) return withContent({ success: false, error: `HAR file not found: ${args.har_path}` });

      try {
        const har = safeJsonParse<any>(readFileSync(args.har_path, "utf-8"), null);
        if (!har?.log?.entries) return withContent({ success: false, error: "Invalid HAR format: missing log.entries" });

        const apiData = parseHar(har, args.seed_url);
        if (!Object.keys(apiData.endpoints ?? {}).length) {
          return withContent({ success: false, error: "No API endpoints discovered in HAR." });
        }

        const result = await generateSkill(apiData as any, args.output_dir);
        upsertVault(result.service, {
          baseUrl: apiData.baseUrl,
          authMethod: apiData.authMethod,
          headers: apiData.authHeaders,
          cookies: apiData.cookies,
        });

        return withContent({
          success: true,
          service: result.service,
          skill_dir: result.skillDir,
          endpoints_count: result.endpointCount,
          auth_method: apiData.authMethod,
          changed: result.changed,
          diff: result.diff ?? null,
          version_hash: result.versionHash ?? null,
        });
      } catch (err) {
        return withContent({ success: false, error: (err as Error).message });
      }
    },
  });

  api.registerTool({
    name: "unbrowse_skills",
    description: `List locally available unbrowse skills and auth summary.`,
    parameters: { type: "object", properties: {} },
    async execute() {
      ensureDir(SKILLS_DIR);
      const dirs = readdirSync(SKILLS_DIR)
        .filter((name) => {
          const full = join(SKILLS_DIR, name);
          return statSync(full).isDirectory() && existsSync(join(full, "SKILL.md"));
        })
        .sort();

      const skills = dirs.map((service) => {
        const skillMdPath = join(SKILLS_DIR, service, "SKILL.md");
        const skillMd = readFileSync(skillMdPath, "utf-8");
        const auth = getAuth(service);
        return {
          service,
          endpoints: countEndpoints(skillMd),
          auth_method: auth?.authMethod ?? "unknown",
          base_url: auth?.baseUrl ?? null,
          headers_count: Object.keys(auth?.headers ?? {}).length,
          cookies_count: Object.keys(auth?.cookies ?? {}).length,
          updated_at: auth?.updatedAt ?? null,
        };
      });

      return withContent({ success: true, count: skills.length, skills });
    },
  });

  api.registerTool({
    name: "unbrowse_auth",
    description: `Get stored auth for a domain/service and optionally seed from browser cookies.`,
    parameters: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Domain or service name." },
      },
      required: ["domain"],
    },
    async execute(args: { domain: string }) {
      const service = toServiceName(args.domain);
      let auth = getAuth(service);

      if (!auth) {
        try {
          const cookies = await fetchBrowserCookies();
          if (Object.keys(cookies).length) {
            auth = upsertVault(service, {
              baseUrl: `https://${args.domain.replace(/^https?:\/\//, "").split("/")[0]}`,
              authMethod: detectAuthMethod({}, cookies),
              cookies,
              headers: {},
            });
          }
        } catch {
          // no-op
        }
      }

      if (!auth) {
        return withContent({ success: false, error: `No auth found for ${args.domain}` });
      }

      return withContent({
        success: true,
        service,
        base_url: auth.baseUrl,
        auth_method: auth.authMethod,
        headers: Object.keys(auth.headers ?? {}),
        cookies: Object.keys(auth.cookies ?? {}),
      });
    },
  });

  api.registerTool({
    name: "unbrowse_publish",
    description: `Publish a local skill package to marketplace (JS runtime path).`,
    parameters: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service/skill name to publish." },
        description: { type: "string", description: "Optional description override." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
        price_usdc: { type: "number", description: "Optional price in USDC." },
      },
      required: ["service"],
    },
    async execute(args: { service: string; description?: string; tags?: string[]; price_usdc?: number }) {
      const skillDir = join(SKILLS_DIR, args.service);
      const skillMdPath = join(skillDir, "SKILL.md");
      if (!existsSync(skillMdPath)) return withContent({ success: false, error: `Skill not found: ${args.service}` });

      const skillMd = readFileSync(skillMdPath, "utf-8");
      const apiTsPath = join(skillDir, "scripts", "api.ts");
      const refPath = join(skillDir, "references", "REFERENCE.md");
      const auth = getAuth(args.service);

      const payload: Record<string, unknown> = {
        name: args.service,
        description: args.description ?? `Unofficial API skill for ${args.service}`,
        skillMd,
        scripts: existsSync(apiTsPath) ? { "api.ts": readFileSync(apiTsPath, "utf-8") } : undefined,
        references: existsSync(refPath) ? { "REFERENCE.md": readFileSync(refPath, "utf-8") } : undefined,
        serviceName: args.service,
        domain: auth?.baseUrl ? new URL(auth.baseUrl).hostname : args.service.replace(/-/g, "."),
        authType: auth?.authMethod ?? "unknown",
        category: "api",
        priceUsdc: typeof args.price_usdc === "number" ? String(args.price_usdc) : "0",
        tags: args.tags ?? [],
      };

      const resp = await fetch(`${INDEX_URL}/marketplace/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return withContent({ success: false, status: resp.status, error: trimText(text, 3000) });
      }

      const data = await resp.json();
      const skill = data?.skill ?? {};
      return withContent({
        success: true,
        id: skill.skillId ?? skill.id ?? null,
        name: skill.name ?? args.service,
        service: skill.serviceName ?? args.service,
      });
    },
  });

  api.registerTool({
    name: "unbrowse_search",
    description: `Search skill marketplace by query.`,
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query." } },
      required: ["query"],
    },
    async execute(args: { query: string }) {
      const url = new URL(`${INDEX_URL}/marketplace/skills`);
      url.searchParams.set("q", args.query);
      url.searchParams.set("limit", "50");

      const resp = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return withContent({ success: false, status: resp.status, error: trimText(text, 3000) });
      }

      const data = await resp.json();
      const skills = (data?.skills ?? []).map((s: any) => ({
        id: s.skillId ?? s.id,
        name: s.name,
        service: s.serviceName ?? s.service,
        description: s.description,
        author: s.creatorWallet ?? s.author,
        endpoints: s.endpointCount ?? s.endpointsCount ?? null,
        installs: s.downloadCount ?? s.installs ?? 0,
        price_usdc: s.priceUsdc ?? "0",
        badge: s.badge ?? null,
      }));

      return withContent({ success: true, count: skills.length, skills });
    },
  });

  api.registerTool({
    name: "unbrowse_download",
    description: `Download and install a marketplace skill locally.`,
    parameters: {
      type: "object",
      properties: { skill_id: { type: "string", description: "Marketplace skill id." } },
      required: ["skill_id"],
    },
    async execute(args: { skill_id: string }) {
      const summary = await readMarketplaceSkillSummary(args.skill_id);
      if (!summary) return withContent({ success: false, error: `Skill not found: ${args.skill_id}` });

      const resp = await fetch(`${INDEX_URL}/marketplace/skill-downloads/${encodeURIComponent(args.skill_id)}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });

      if (resp.status === 402) {
        return withContent({
          success: false,
          status: 402,
          error: "Paid skill requires x402 wallet flow. JS-only runtime does not perform payment signing.",
        });
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return withContent({ success: false, status: resp.status, error: trimText(text, 3000) });
      }

      const data = await resp.json();
      const skill = data?.skill;
      if (!skill) return withContent({ success: false, error: "Malformed marketplace response." });

      const service = toServiceName(skill.serviceName ?? skill.name ?? args.skill_id);
      const skillDir = join(SKILLS_DIR, service);
      ensureDir(join(skillDir, "scripts"));
      ensureDir(join(skillDir, "references"));

      writeFileSync(join(skillDir, "SKILL.md"), skill.skillMd ?? "", "utf-8");

      const scripts = (skill.scripts ?? {}) as Record<string, string>;
      for (const [filename, content] of Object.entries(scripts)) {
        writeFileSync(join(skillDir, "scripts", filename), content, "utf-8");
      }

      const refs = (skill.references ?? {}) as Record<string, string>;
      for (const [filename, content] of Object.entries(refs)) {
        writeFileSync(join(skillDir, "references", filename), content, "utf-8");
      }

      return withContent({
        success: true,
        id: skill.skillId ?? args.skill_id,
        service,
        skill_dir: skillDir,
        price_usdc: summary.priceUsdc ?? "0",
      });
    },
  });

  api.registerTool({
    name: "unbrowse_wallet",
    description: `Wallet operations are disabled in JS-only mode.`,
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["get", "create"], description: "Action." } },
      required: ["action"],
    },
    async execute() {
      return withContent({
        success: false,
        error: "Wallet functions removed from plugin runtime. Use external wallet flow for x402.",
      });
    },
  });

  api.registerTool({
    name: "unbrowse_record",
    description: `Workflow recording is disabled in JS-only mode.`,
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["start", "stop", "status"], description: "Action." } },
      required: ["action"],
    },
    async execute() {
      return withContent({
        success: false,
        error: "Recording functions removed from plugin runtime.",
      });
    },
  });

  return {
    name: "unbrowse",
    version: "0.5.1-js-only",
    native: false,
  };
}
