import type { ToolDeps } from "./deps.js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  join,
  resolve,
  homedir,
  REPLAY_SCHEMA,
  loginAndCapture,
  resolveHeaders,
  primeHeaders,
} from "./shared.js";
import type { HeaderProfileFile, PrimeResult } from "./shared.js";
import type { CsrfProvenance } from "../../types.js";
import { applyCsrfProvenance, inferCsrfProvenance } from "../../auth-provenance.js";

export function makeUnbrowseReplayTool(deps: ToolDeps) {
  const {
    logger,
    browserPort,
    defaultOutputDir,
    enableChromeCookies,
    vaultDbPath,
    credentialProvider,
    getOrCreateBrowserSession,
    indexClient,
  } = deps;

  return {
name: "unbrowse_replay",
label: "Call Internal API",
description:
  "Call internal API endpoints using captured auth. Executes requests THROUGH THE BROWSER " +
  "(via page.evaluate) for authentic TLS/HTTP2 fingerprints that bypass bot detection. " +
  "Uses session cookies, tokens, and headers from capture. Auto-refreshes auth on 401/403.",
parameters: REPLAY_SCHEMA,
async execute(_toolCallId: string, params: unknown) {
  const p = params as {
    service: string;
    endpoint?: string;
    body?: string;
    skillsDir?: string;
    executionMode?: "browser" | "node" | "backend";
    traceId?: string;
    intent?: string;
    storeTrace?: boolean;
    storeRaw?: boolean;
    autoChain?: boolean;
    skillId?: string;
  };
  const skillsDir = p.skillsDir ?? defaultOutputDir;
  const skillDir = join(skillsDir, p.service);
  const authPath = join(skillDir, "auth.json");
  const skillMdPath = join(skillDir, "SKILL.md");
  const marketplaceMetaPath = join(skillDir, "marketplace.json");

  if (!existsSync(skillDir)) {
    return { content: [{ type: "text", text: `Skill not found: ${skillDir}` }] };
  }

  // Filter out HTTP/2 pseudo-headers that break fetch()
  // These are protocol-level headers (e.g., :authority, :method, :path, :scheme)
  // that get captured from CDP but cause "invalid header" errors when replayed
  function filterPseudoHeaders(headers: Record<string, string>): Record<string, string> {
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      // Skip HTTP/2 pseudo-headers (start with :)
      if (key.startsWith(":")) continue;
      // Skip other protocol-level headers
      if (["host", "connection", "content-length", "transfer-encoding"].includes(key.toLowerCase())) continue;
      filtered[key] = value;
    }
    return filtered;
  }

  // Load auth state (mutable — refreshed on 401/403)
  let authHeaders: Record<string, string> = {};
  let cookies: Record<string, string> = {};
  let baseUrl = "https://api.example.com";
  let storedLocalStorage: Record<string, string> = {};
  let storedSessionStorage: Record<string, string> = {};
  let storedMetaTokens: Record<string, string> = {};
  let csrfProvenance: CsrfProvenance | undefined;
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
        csrfProvenance = auth.csrfProvenance;

        // Restore client-side auth tokens (JWTs from localStorage/sessionStorage)
        // These were captured by session-login from the SPA's browser state.
        const ls = auth.localStorage as Record<string, string> | undefined;
        const ss = auth.sessionStorage as Record<string, string> | undefined;
        const meta = auth.metaTokens as Record<string, string> | undefined;
        storedLocalStorage = ls ?? {};
        storedSessionStorage = ss ?? {};
        storedMetaTokens = meta ?? {};

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
      const { Vault } = await import("../../vault.js");
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

    // Fallback: try loading cookies from Chrome's cookie database (opt-in only)
    if (Object.keys(cookies).length === 0 && enableChromeCookies) {
      try {
        const { readChromeCookies, chromeCookiesAvailable } = await import("../../chrome-cookies.js");
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
  {
    const resolved = applyCsrfProvenance({
      authHeaders,
      cookies,
      localStorage: storedLocalStorage,
      sessionStorage: storedSessionStorage,
      metaTokens: storedMetaTokens,
      csrfProvenance,
    });
    authHeaders = resolved.authHeaders;
    if (resolved.applied.length > 0) {
      logger.info(`[unbrowse] Applied CSRF provenance: ${resolved.applied.join(", ")}`);
    }
  }

  function toCookieHeader(c: Record<string, string>): string {
    return Object.entries(c).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async function execViaBackend(
    ep: { method: string; path: string },
    body?: string,
  ): Promise<{ status: number; ok: boolean; data?: string; isHtml?: boolean } | null> {
    const skillId = (() => {
      if (p.skillId) return p.skillId;
      if (existsSync(marketplaceMetaPath)) {
        try {
          const meta = JSON.parse(readFileSync(marketplaceMetaPath, "utf-8"));
          if (typeof meta?.skillId === "string" && meta.skillId.trim().length > 0) return meta.skillId.trim();
        } catch { /* ignore */ }
      }
      return null;
    })();

    if (!skillId) {
      return { status: 0, ok: false, data: "backend mode requires marketplace skillId. Publish first (unbrowse_publish) or pass skillId." };
    }

    let endpointId: string | null = null;
    const endpointsPath = join(skillDir, "references", "ENDPOINTS.json");
    if (existsSync(endpointsPath)) {
      try {
        const list = JSON.parse(readFileSync(endpointsPath, "utf-8"));
        if (Array.isArray(list)) {
          for (const item of list) {
            if (!item) continue;
            const m = String(item.method || "").toUpperCase();
            const np = String(item.normalizedPath || item.normalized_path || "");
            const id = item.endpointId ?? item.endpoint_id;
            if (m === ep.method.toUpperCase() && np === ep.path && typeof id === "string" && id.length > 0) {
              endpointId = id;
              break;
            }
          }
        }
      } catch { /* ignore */ }
    }

    if (!endpointId) {
      try {
        const list = await indexClient.getSkillEndpoints(skillId);
        for (const item of list) {
          const m = String(item.method || "").toUpperCase();
          const np = String(item.normalizedPath || "");
          const id = item.endpointId;
          if (m === ep.method.toUpperCase() && np === ep.path && typeof id === "string" && id.length > 0) {
            endpointId = id;
            break;
          }
        }
      } catch (err) {
        logger.warn(`[unbrowse] Failed to fetch canonical endpoint list for ${skillId}: ${(err as Error).message}`);
      }
    }

    if (!endpointId) {
      return { status: 0, ok: false, data: `No canonical endpointId for ${ep.method} ${ep.path}. Re-publish skill or refresh marketplace mapping.` };
    }

    let parsedBody: any = undefined;
    if (body && ["POST", "PUT", "PATCH"].includes(ep.method)) {
      try { parsedBody = JSON.parse(body); } catch { parsedBody = body; }
    }

    const traceId =
      p.traceId && p.traceId.trim().length > 0
        ? p.traceId.trim()
        : (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`);
    const storeTrace = typeof p.storeTrace === "boolean" ? p.storeTrace : true;
    const storeRaw = typeof p.storeRaw === "boolean" ? p.storeRaw : false;
    const autoChain = typeof p.autoChain === "boolean" ? p.autoChain : true;
    const intent = typeof p.intent === "string" && p.intent.trim().length > 0 ? p.intent.trim() : undefined;

    try {
      const resp: any = await indexClient.executeEndpoint(endpointId, {
        params: {},
        body: parsedBody,
        auth: {
          cookies: Object.keys(cookies).length > 0 ? toCookieHeader(cookies) : undefined,
          headers: filterPseudoHeaders(authHeaders),
        },
        context: {
          traceId,
          sessionId: p.service,
          autoChain,
          intent,
        },
        privacy: {
          storeTrace,
          storeRaw,
        },
      });

      const ok = Boolean(resp?.ok);
      const status = typeof resp?.statusCode === "number" ? resp.statusCode : (ok ? 200 : 0);
      const data = (() => {
        const v = resp?.data;
        if (typeof v === "string") return v.slice(0, 2000);
        try { return JSON.stringify(v).slice(0, 2000); } catch { return String(v ?? "").slice(0, 2000); }
      })();

      return { status, ok, data };
    } catch (err) {
      return { status: 0, ok: false, data: String((err as Error).message ?? err) };
    }
  }

  // Load header profile template (headers.json) for browser-like headers
  const headersJsonPath = join(skillDir, "headers.json");
  let headerProfile: HeaderProfileFile | undefined;
  if (existsSync(headersJsonPath)) {
    try {
      headerProfile = JSON.parse(readFileSync(headersJsonPath, "utf-8"));
      logger.info(`[unbrowse] Loaded header profile from headers.json`);
    } catch {
      // Invalid headers.json — skip
    }
  }

  // Hydrated header profile + cookies (populated on first Node.js fetch if browser available)
  let primeResult: PrimeResult | undefined;

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
  //
  // IMPORTANT: Always prefer browser-based fetch over Node.js fetch.
  // Browser fetch has authentic TLS fingerprint (JA3/JA4), HTTP/2 settings,
  // header ordering, and Sec-CH-UA headers. Node.js fetch is easily detected.
  //
  // Priority:
  // 1. OpenClaw browser API (port 18791) - managed browser with request capture
  // 2. CDP connection (ports 9222, 9229) - direct Chrome DevTools Protocol
  // 3. Node.js fetch - ONLY if no browser available (will likely be blocked)

  let chromeBrowser: any = null;
  let chromePage: any = null;
  let chromeContext: any = null;
  let browserSource: "openclaw" | "cdp" | "none" = "none";
  let ownsBrowser = false;
  const fallbackCdpPorts = Array.from(new Set([18792, browserPort, 9222, 9229]))
    .filter((port) => Number.isInteger(port) && port > 0 && port !== 18800);

  async function getChromePage(): Promise<any | null> {
    if (chromePage) return chromePage;

    let chromium: any;
    try {
      ({ chromium } = await import("playwright-core"));
    } catch {
      // Can't do browser-eval execution; caller will fall back to node/backend.
      return null;
    }

    // Strategy 1: OpenClaw-managed Chrome (preserves logins, best fingerprint).
    // Default CDP port for profile "openclaw" is 18800.
    try {
      chromeBrowser = await chromium.connectOverCDP(`http://127.0.0.1:18800`, { timeout: 5000 });
      browserSource = "openclaw";
      logger.info(`[unbrowse] Connected to OpenClaw-managed Chrome via CDP (:18800)`);
    } catch {
      // No shell-based auto-start in this build. Continue to fallback CDP probes.
    }

    // Strategy 2: Try fallback CDP ports (most reliable first from observed runs)
    if (!chromeBrowser) {
      for (const port of fallbackCdpPorts) {
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
          if (!resp.ok) continue;
          const data = await resp.json() as { webSocketDebuggerUrl?: string };
          const wsUrl = data.webSocketDebuggerUrl ?? `http://127.0.0.1:${port}`;
          chromeBrowser = await chromium.connectOverCDP(wsUrl, { timeout: 5000 });
          browserSource = "cdp";
          logger.info(`[unbrowse] Connected to Chrome via CDP port ${port}`);
          break;
        } catch { continue; }
      }
    }

    // No headless launch fallback. Native-only: require OpenClaw/Chrome CDP.
    if (!chromeBrowser) {
      browserSource = "none";
      return null;
    }

    chromeContext = chromeBrowser.contexts()[0];
    if (!chromeContext) {
      chromeContext = await chromeBrowser.newContext();
    }

    // Inject stored cookies into the browser context
    if (Object.keys(cookies).length > 0) {
      try {
        const domain = new URL(baseUrl).hostname;
        const cookieObjects = Object.entries(cookies).map(([name, value]) => ({
          name, value, domain, path: "/",
        }));
        await chromeContext.addCookies(cookieObjects);
      } catch { /* non-critical */ }
    }

    chromePage = chromeContext.pages()[0] ?? await chromeContext.newPage();

    // Inject localStorage/sessionStorage via addInitScript BEFORE navigation
    const hasStorage = Object.keys(storedLocalStorage).length > 0 || Object.keys(storedSessionStorage).length > 0;
    if (hasStorage) {
      try {
        await chromeContext.addInitScript(`
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
      } catch { /* addInitScript may fail on reused contexts */ }
    }

    // Navigate to establish origin context
    await chromePage.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => { });

    return chromePage;
  }

  async function cleanupChrome() {
    // Only close the browser if we launched it (don't close user's browser)
    if (ownsBrowser) {
      try { await chromeBrowser?.close(); } catch { /* ignore */ }
    }
    chromeBrowser = null;
    chromePage = null;
  }

  async function execInChrome(ep: { method: string; path: string }, body?: string): Promise<{ status: number; ok: boolean; data?: string; isHtml?: boolean } | null> {
    const page = await getChromePage();
    if (!page) return null;

    try {
      const url = new URL(ep.path, baseUrl).toString();
      // Filter out HTTP/2 pseudo-headers before sending
      const cleanHeaders = filterPseudoHeaders(authHeaders);

      // In browser mode, use full header profile (context + app headers).
      // The browser's TLS fingerprint matches User-Agent so no mismatch detection.
      let resolvedHeaders: Record<string, string>;
      if (headerProfile) {
        const domain = new URL(baseUrl).hostname;
        const pathStr = new URL(url).pathname;
        resolvedHeaders = resolveHeaders(headerProfile, domain, ep.method, pathStr, cleanHeaders, {}, "browser");
        if (!resolvedHeaders["Content-Type"] && !resolvedHeaders["content-type"]) {
          resolvedHeaders["Content-Type"] = "application/json";
        }
      } else {
        resolvedHeaders = { "Content-Type": "application/json", ...cleanHeaders };
      }

      const fetchOpts: Record<string, unknown> = {
        method: ep.method,
        headers: resolvedHeaders,
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

    // Prime headers + cookies from browser on first Node.js fetch (one-time)
    if (headerProfile && !primeResult) {
      try {
        primeResult = await primeHeaders(baseUrl, headerProfile, browserPort);
        if (Object.keys(primeResult.headers).length > 0) {
          logger.info(`[unbrowse] Primed ${Object.keys(primeResult.headers).length} headers from browser`);
        }
        // Merge primed cookies into session cookies (primed fills gaps, doesn't override existing)
        if (Object.keys(primeResult.cookies).length > 0) {
          for (const [name, value] of Object.entries(primeResult.cookies)) {
            if (!cookies[name]) {
              cookies[name] = value;
            }
          }
          logger.info(`[unbrowse] Primed ${Object.keys(primeResult.cookies).length} cookies from browser`);
        }
      } catch {
        primeResult = { headers: {}, cookies: {} }; // Mark as attempted so we don't retry
      }
    }

    // Build headers using the profile resolution (template → overrides → auth → cookies)
    const cleanHeaders = filterPseudoHeaders(authHeaders);
    let reqHeaders: Record<string, string>;
    if (headerProfile) {
      const domain = new URL(baseUrl).hostname;
      const pathStr = new URL(url).pathname;
      // Use "node" mode — excludes context headers (user-agent, accept, referer)
      // to avoid TLS fingerprint mismatch detection by Cloudflare/Akamai.
      // Only includes app-specific custom headers (x-requested-with, etc.)
      reqHeaders = resolveHeaders(headerProfile, domain, ep.method, pathStr, cleanHeaders, cookies, "node");
      // Layer primed (fresh browser) header values over template sample values
      if (primeResult?.headers) {
        for (const [name, value] of Object.entries(primeResult.headers)) {
          // Don't override auth headers or cookies from resolveHeaders
          const lower = name.toLowerCase();
          if (lower !== "cookie" && !cleanHeaders[name] && !cleanHeaders[lower]) {
            reqHeaders[name] = value;
          }
        }
      }
      // Ensure Content-Type is present
      if (!reqHeaders["Content-Type"] && !reqHeaders["content-type"]) {
        reqHeaders["Content-Type"] = "application/json";
      }
    } else {
      // No profile — original behavior
      reqHeaders = { ...cleanHeaders, "Content-Type": "application/json" };
      if (Object.keys(cookies).length > 0) {
        reqHeaders["Cookie"] = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
      }
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
          captureUrls: loginConfig.captureUrls,
        });

        // Update in-memory creds
        authHeaders = result.authHeaders;
        cookies = result.cookies;
        csrfProvenance = inferCsrfProvenance({
          authHeaders,
          cookies,
          localStorage: storedLocalStorage,
          sessionStorage: storedSessionStorage,
          metaTokens: storedMetaTokens,
          authInfo: {},
          existing: csrfProvenance,
        });

        // Persist refreshed creds to auth.json
        const { writeFileSync } = await import("node:fs");
        const existing = existsSync(authPath)
          ? JSON.parse(readFileSync(authPath, "utf-8"))
          : {};
        existing.headers = result.authHeaders;
        existing.cookies = result.cookies;
        existing.csrfProvenance = csrfProvenance;
        existing.timestamp = new Date().toISOString();
        existing.refreshedAt = new Date().toISOString();
        writeFileSync(authPath, JSON.stringify(existing, null, 2), "utf-8");

        return true;
      } catch {
        // Re-login failed — try next strategy
      }
    }

    // Strategy 2: re-grab cookies via CDP connect (reliability-ordered ports)
    try {
      const { chromium } = await import("playwright-core");
      let browser: any = null;
      for (const port of [18800, ...fallbackCdpPorts]) {
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
            csrfProvenance = inferCsrfProvenance({
              authHeaders,
              cookies,
              localStorage: storedLocalStorage,
              sessionStorage: storedSessionStorage,
              metaTokens: storedMetaTokens,
              authInfo: {},
              existing: csrfProvenance,
            });

            const { writeFileSync } = await import("node:fs");
            const existing = existsSync(authPath)
              ? JSON.parse(readFileSync(authPath, "utf-8"))
              : {};
            existing.cookies = freshCookies;
            existing.csrfProvenance = csrfProvenance;
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

  // Default: marketplace-installed skills run via backend executor so we trace workflows (LAM training).
  // If wallet isn't configured, fall back to browser.
  const hasMarketplaceMeta = existsSync(marketplaceMetaPath);
  const hasWallet = Boolean(deps.walletState?.creatorWallet && deps.walletState?.solanaPrivateKey);
  const executionMode = p.executionMode ?? (hasMarketplaceMeta && hasWallet ? "backend" : "browser");
  if (executionMode === "backend") {
    results.push(`Using backend executor (marketplace) for trace capture`);
    if (p.intent) results.push(`Intent: ${p.intent}`);
    if (p.traceId) results.push(`TraceId: ${p.traceId}`);
    results.push("");

    for (const ep of toTest) {
      const body = p.body ?? (["POST", "PUT", "PATCH"].includes(ep.method) ? "{}" : undefined);
      const result = await execViaBackend(ep, body);
      if (result && result.ok) {
        results.push(`  ${ep.method} ${ep.path} → ${result.status} OK`);
        if (p.endpoint && result.data) results.push(`  Response: ${result.data.slice(0, 500)}`);
        passed++;
      } else {
        results.push(`  ${ep.method} ${ep.path} → ${result?.status || "FAILED"}${result?.data ? ` (${String(result.data).slice(0, 120)})` : ""}`);
        failed++;
      }
    }

    results.push("", `Results: ${passed} passed, ${failed} failed`);
    return { content: [{ type: "text", text: results.join("\n") }] };
  }

  // Check if browser is available upfront
  const browserPage = await getChromePage();
  const hasBrowser = browserPage !== null && executionMode !== "node";

  if (hasBrowser) {
    results.push(`Using browser (${browserSource}) for authentic TLS/HTTP2 fingerprint`);
  } else {
    results.push(
      executionMode === "node"
        ? `Using Node.js fetch (forced) — may be blocked by bot detection`
        : `⚠️  No browser available — using Node.js fetch (may be blocked by bot detection)`,
    );
  }
  results.push("");

  for (const ep of toTest) {
    const body = p.body ?? (["POST", "PUT", "PATCH"].includes(ep.method) ? "{}" : undefined);
    let result: { status: number; ok: boolean; data?: string; isHtml?: boolean } | null = null;

    // Strategy: Always use browser if available (authentic fingerprint)
    // Only fall back to Node.js fetch if no browser at all
    if (hasBrowser) {
      result = await execInChrome(ep, body);
      if (result && result.ok) {
        results.push(`  ${ep.method} ${ep.path} → ${result.status} OK`);
        if (p.endpoint && result.data) results.push(`  Response: ${result.data.slice(0, 500)}`);
        passed++;
        continue;
      }

      // Browser request failed - check if auth issue
      const status = result?.status ?? 0;
      if ((status === 401 || status === 403) && !credsRefreshed) {
        results.push(`  ${ep.method} ${ep.path} → ${status} — refreshing credentials...`);
        const refreshed = await refreshCreds();
        if (refreshed) {
          // Re-inject fresh cookies into browser context
          if (chromeContext && Object.keys(cookies).length > 0) {
            try {
              const domain = new URL(baseUrl).hostname;
              const cookieObjects = Object.entries(cookies).map(([name, value]) => ({
                name, value, domain, path: "/",
              }));
              await chromeContext.addCookies(cookieObjects);
            } catch { /* non-critical */ }
          }
          // Retry via browser (not Node.js fetch!)
          result = await execInChrome(ep, body);
          if (result && result.ok) {
            results.push(`  ${ep.method} ${ep.path} → ${result.status} OK (refreshed)`);
            if (p.endpoint && result.data) results.push(`  Response: ${result.data.slice(0, 500)}`);
            passed++;
            continue;
          }
          results.push(`  ${ep.method} ${ep.path} → ${result?.status ?? "FAILED"} (still failed after refresh)`);
        } else {
          results.push(`  Credential refresh unavailable — use unbrowse_login to authenticate`);
        }
      }

      // Browser request failed (not auth issue or refresh didn't help)
      results.push(`  ${ep.method} ${ep.path} → ${status || "FAILED"}`);
      failed++;
    } else {
      // No browser available - fall back to Node.js fetch
      // This will likely be blocked by sophisticated bot detection
      try {
        result = await execViaFetch(ep, body);
        if (result.isHtml) {
          results.push(`  ${ep.method} ${ep.path} → ${result.status} (HTML page, not API)`);
          failed++;
          continue;
        }
        if (result.ok) {
          results.push(`  ${ep.method} ${ep.path} → ${result.status} OK (Node.js)`);
          if (p.endpoint && result.data) results.push(`  Response: ${result.data.slice(0, 500)}`);
          passed++;
          continue;
        }

        // Check for auth failure
        const status = result?.status ?? 0;
        if ((status === 401 || status === 403) && !credsRefreshed) {
          results.push(`  ${ep.method} ${ep.path} → ${status} — refreshing credentials...`);
          const refreshed = await refreshCreds();
          if (refreshed) {
            result = await execViaFetch(ep, body);
            if (result.ok) {
              results.push(`  ${ep.method} ${ep.path} → ${result.status} OK (refreshed)`);
              if (p.endpoint && result.data) results.push(`  Response: ${result.data.slice(0, 500)}`);
              passed++;
              continue;
            }
          }
        }

        results.push(`  ${ep.method} ${ep.path} → ${result.status || "FAILED"}`);
        failed++;
      } catch (err) {
        results.push(`  ${ep.method} ${ep.path} → ERROR: ${String(err).slice(0, 100)}`);
        failed++;
      }
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

  // Clean up browser sessions after capturing state
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
    existing.metaTokens = { ...(existing.metaTokens ?? {}), ...storedMetaTokens };
    existing.csrfProvenance = inferCsrfProvenance({
      authHeaders,
      cookies,
      localStorage: storedLocalStorage,
      sessionStorage: storedSessionStorage,
      metaTokens: existing.metaTokens ?? storedMetaTokens,
      authInfo: existing.authInfo ?? {},
      existing: existing.csrfProvenance ?? csrfProvenance,
    });
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
    results.push(`Tip: use unbrowse_login to store credentials for auto-refresh`);
  }
  return { content: [{ type: "text", text: results.join("\n") }] };
},
};
}
