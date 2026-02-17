import type { ToolDeps } from "./deps.js";
import {
  existsSync,
  writeFileSync,
  mkdirSync,
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
import type { CaptureSessionFileV1, CapturedExchange } from "../../types.js";
import { applyCsrfProvenance, inferCsrfProvenance } from "../../auth-provenance.js";
import { inferCorrelationGraphV1, planChainForTarget } from "../../correlation-engine.js";
import { prepareRequestForStep, type StepResponseRuntime } from "../../sequence-executor.js";
import { fetchViaNodeStealth } from "../../transport.js";
import { loadJsonOr, loadText } from "../../disk-io.js";
import { summarizeHtmlContent } from "../../html-structurer.js";
import { safeParseJson } from "../../schema-inferrer.js";

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
    useStealth?: boolean;
    traceId?: string;
    intent?: string;
    storeTrace?: boolean;
    storeRaw?: boolean;
    autoChain?: boolean;
    skillId?: string;
    maxResponseChars?: number;
    previewChars?: number;
    debugReplayV2?: boolean;
  };
  const skillsDir = p.skillsDir ?? defaultOutputDir;
  const skillDir = join(skillsDir, p.service);
  const authPath = join(skillDir, "auth.json");
  const skillMdPath = join(skillDir, "SKILL.md");
  const marketplaceMetaPath = join(skillDir, "marketplace.json");

  if (!existsSync(skillDir)) {
    return { content: [{ type: "text", text: `Skill not found: ${skillDir}` }] };
  }

  const maxResponseChars =
    typeof p.maxResponseChars === "number" && Number.isFinite(p.maxResponseChars) && p.maxResponseChars >= 0
      ? Math.floor(p.maxResponseChars)
      : 2000;

  const previewCharsDefault = p.endpoint ? 4000 : 500;
  const previewChars =
    typeof p.previewChars === "number" && Number.isFinite(p.previewChars) && p.previewChars >= 0
      ? Math.floor(p.previewChars)
      : previewCharsDefault;

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

  // Browser fetch cannot set certain "forbidden" headers (User-Agent, etc).
  // Those must be provided by the browser itself.
  function filterBrowserUnsafeHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers ?? {})) {
      const lower = String(k).toLowerCase();
      if (lower === "user-agent") continue;
      if (lower === "accept-encoding") continue;
      if (lower === "host") continue;
      if (lower === "connection") continue;
      if (lower === "content-length") continue;
      if (lower === "transfer-encoding") continue;
      // Fetch sets Origin/Referer; attempting to set can be blocked in some browsers.
      if (lower === "origin") continue;
      if (lower === "referer") continue;
      out[k] = v;
    }
    return out;
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
        const auth = loadJsonOr<Record<string, any>>(authPath, {});
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

  async function execViaBackend(
    ep: { method: string; path: string },
    body?: string,
  ): Promise<{ status: number; ok: boolean; endpointId?: string; raw?: any; data?: string } | null> {
    const skillId = (() => {
      if (p.skillId) return p.skillId;
      if (existsSync(marketplaceMetaPath)) {
        try {
          const meta = loadJsonOr<Record<string, any>>(marketplaceMetaPath, {});
          if (typeof meta?.skillId === "string" && meta.skillId.trim().length > 0) return meta.skillId.trim();
        } catch { /* ignore */ }
      }
      return null;
    })();

    if (!skillId) {
      return { status: 0, ok: false, data: "backend mode requires marketplace skillId. Publish first (unbrowse_publish) or pass skillId." };
    }

    const resolveEndpointId = async (): Promise<string | null> => {
      const endpointsPath = join(skillDir, "references", "ENDPOINTS.json");
      if (existsSync(endpointsPath)) {
        try {
          const list = loadJsonOr<any[]>(endpointsPath, []);
          if (Array.isArray(list)) {
            for (const item of list) {
              if (!item) continue;
              const m = String(item.method || "").toUpperCase();
              const np = String(item.normalizedPath || item.normalized_path || "");
              const id = item.endpointId ?? item.endpoint_id;
              if (m === ep.method.toUpperCase() && np === ep.path && typeof id === "string" && id.length > 0) {
                return id;
              }
            }
          }
        } catch { /* ignore */ }
      }

      try {
        const list = await indexClient.getSkillEndpoints(skillId);
        for (const item of list) {
          const m = String(item.method || "").toUpperCase();
          const np = String(item.normalizedPath || "");
          const id = item.endpointId;
          if (m === ep.method.toUpperCase() && np === ep.path && typeof id === "string" && id.length > 0) {
            return id;
          }
        }
      } catch (err) {
        logger.warn(`[unbrowse] Failed to fetch canonical endpoint list for ${skillId}: ${(err as Error).message}`);
      }

      return null;
    };

    const traceId =
      p.traceId && p.traceId.trim().length > 0
        ? p.traceId.trim()
        : (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`);
    const storeTrace = typeof p.storeTrace === "boolean" ? p.storeTrace : true;
    const storeRaw = typeof p.storeRaw === "boolean" ? p.storeRaw : false;
    const autoChain = typeof p.autoChain === "boolean" ? p.autoChain : true;
    const intent = typeof p.intent === "string" && p.intent.trim().length > 0 ? p.intent.trim() : undefined;
    const targetUrl = new URL(ep.path, baseUrl).toString();
    const wantRawResponse = Boolean(p.endpoint) || storeRaw;

    // Backward compatibility: older injected clients in tests/custom setups may only expose executeEndpoint().
    const hasGateFlow =
      typeof (indexClient as any)?.requestExecutionGate === "function" &&
      typeof (indexClient as any)?.submitExecutionReceipt === "function";

    try {
      if (!hasGateFlow) {
        const endpointId = await resolveEndpointId();
        if (!endpointId) {
          return { status: 0, ok: false, data: `No canonical endpointId for ${ep.method} ${ep.path}. Re-publish skill or refresh marketplace mapping.` };
        }
        const resp: any = await indexClient.executeEndpoint(endpointId, {
          params: {},
          body: body && ["POST", "PUT", "PATCH"].includes(ep.method) ? (() => {
            try { return JSON.parse(body); } catch { return body; }
          })() : undefined,
          auth: {
            cookies: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; "),
            headers: filterPseudoHeaders(authHeaders),
          },
          context: {
            traceId,
            sessionId: p.service,
            autoChain,
            intent,
            responseMode: wantRawResponse ? "raw" : "summary",
          },
          privacy: {
            storeTrace,
            storeRaw,
          },
        });
        const ok = Boolean(resp?.ok);
        const status = typeof resp?.statusCode === "number" ? resp.statusCode : (ok ? 200 : 0);
        const raw = resp?.data;
        const data = (() => {
          if (typeof raw === "string") return raw.slice(0, 2000);
          try { return JSON.stringify(raw).slice(0, 2000); } catch { return String(raw ?? "").slice(0, 2000); }
        })();
        return { status, ok, endpointId, raw, data };
      }

      // Backend gate: policy/payment/tracing token minting (no auth material forwarded).
      const gate = await indexClient.requestExecutionGate({
        skillId,
        method: ep.method,
        url: targetUrl,
        context: {
          traceId,
          sessionId: p.service,
          autoChain,
          storeTrace,
          intent,
        },
      });

      if (!gate?.allowed || !gate?.executeUrl || !gate?.runToken) {
        return { status: 0, ok: false, data: gate?.error || "Execution gate rejected request." };
      }

      if (gate?.payment?.required) {
        return {
          status: 402,
          ok: false,
          endpointId: gate.endpointId,
          data: `Execution requires payment (${gate.payment.priceUsdc ?? "unknown"} USDC).`,
        };
      }

      // Client browser execution (auth/cookies stay local).
      const startedAt = Date.now();
      const browserResult = await execInChrome(
        { method: String(gate.method || ep.method).toUpperCase(), path: gate.executeUrl },
        body,
        Math.max(previewChars, p.storeRaw ? 20_000 : 4_000),
      );
      const executionTimeMs = Date.now() - startedAt;

      if (!browserResult) {
        return {
          status: 0,
          ok: false,
          endpointId: gate.endpointId,
          data: "No browser available for gated execution. Start OpenClaw browser (profile=openclaw) and retry.",
        };
      }

      const ok = Boolean(browserResult.ok);
      const status = typeof browserResult.status === "number" ? browserResult.status : (ok ? 200 : 0);
      const raw = browserResult.contentType?.includes("application/json")
        ? parseMaybeJson(browserResult.data ?? "", browserResult.contentType)
        : (browserResult.data ?? "");
      const data = (() => {
        if (typeof raw === "string") return raw.slice(0, 2000);
        try { return JSON.stringify(raw).slice(0, 2000); } catch { return String(raw ?? "").slice(0, 2000); }
      })();

      // Best-effort telemetry settle for trust + workflow learning.
      try {
        await indexClient.submitExecutionReceipt({
          runToken: gate.runToken,
          success: ok,
          statusCode: status,
          executionTimeMs,
          errorMessage: ok ? undefined : data,
          endpoint: `${ep.method} ${ep.path}`,
          metadata: {
            source: "unbrowse_replay",
            browserSource,
            contentType: browserResult.contentType ?? null,
            outputSummary: data,
            storeRaw,
          },
        });
      } catch (settleErr) {
        logger.warn(`[unbrowse] Failed to settle execution receipt: ${(settleErr as Error).message}`);
      }

      return { status, ok, endpointId: gate.endpointId, raw, data };
    } catch (err) {
      return { status: 0, ok: false, data: String((err as Error).message ?? err) };
    }
  }

  // Load header profile template (headers.json) for browser-like headers
  const headersJsonPath = join(skillDir, "headers.json");
  let headerProfile: HeaderProfileFile | undefined;
  if (existsSync(headersJsonPath)) {
    try {
      headerProfile = loadJsonOr<HeaderProfileFile>(headersJsonPath, {
        version: 1,
        domains: {},
        endpointOverrides: {},
      });
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
    const md = loadText(skillMdPath);
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

  // ── Replay-v2: capture-backed correlation + chaining ──────────────────
  const replayV2Debug: string[] = [];
  const loadLatestCaptureSession = async (): Promise<CaptureSessionFileV1 | null> => {
    try {
      const { readdirSync, readFileSync } = await import("node:fs");
      const capturesDir = join(skillDir, "captures");
      if (!existsSync(capturesDir)) {
        replayV2Debug.push(`capturesDir missing: ${capturesDir}`);
        return null;
      }
      const files = readdirSync(capturesDir)
        .filter((f) => f.startsWith("session-") && f.endsWith(".json"))
        .sort();
      const latest = files[files.length - 1];
      if (!latest) {
        replayV2Debug.push(`no session-*.json in capturesDir`);
        return null;
      }
      const sessionPath = join(capturesDir, latest);
      const raw = readFileSync(sessionPath, "utf-8");
      const parsed = JSON.parse(raw) as CaptureSessionFileV1;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.exchanges)) {
        replayV2Debug.push(`invalid session file: ${sessionPath}`);
        return null;
      }
      replayV2Debug.push(`session: ${latest} (exchanges=${parsed.exchanges.length})`);
      return parsed;
    } catch (err) {
      replayV2Debug.push(`load session failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
      return null;
    }
  };

  const captureSession = await loadLatestCaptureSession();
  const capturedExchanges: CapturedExchange[] | null = captureSession?.exchanges ?? null;
  const correlationGraph = (() => {
    if (!capturedExchanges || capturedExchanges.length === 0) return null;
    const refsDir = join(skillDir, "references");
    const path = join(refsDir, "CORRELATIONS.json");
    if (existsSync(path)) {
      try {
        const g = loadJsonOr<any>(path, null as any);
        if (g && g.version === 1 && Array.isArray(g.links)) return g;
      } catch { /* ignore */ }
    }
    try {
      const g = inferCorrelationGraphV1(capturedExchanges);
      replayV2Debug.push(`correlations inferred: links=${Array.isArray((g as any)?.links) ? (g as any).links.length : 0}`);
      return g;
    } catch {
      replayV2Debug.push(`correlations infer failed`);
      return null;
    }
  })();

  const autoChainLocal =
    typeof p.autoChain === "boolean"
      ? p.autoChain
      : Boolean(p.endpoint); // default: chain only for single-endpoint runs

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

  function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

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

  async function execInChrome(
    ep: { method: string; path: string },
    body: string | undefined,
    limit: number,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; ok: boolean; data?: string; isHtml?: boolean; contentType?: string; headers?: Record<string, string> } | null> {
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
      } else {
        resolvedHeaders = { ...cleanHeaders };
      }
      if (extraHeaders && Object.keys(extraHeaders).length > 0) {
        for (const [k, v] of Object.entries(extraHeaders)) resolvedHeaders[k] = v;
      }

      // Only attach Content-Type when a body is present (avoids CORS/preflight weirdness on some APIs).
      if (body && ["POST", "PUT", "PATCH"].includes(ep.method)) {
        if (!resolvedHeaders["Content-Type"] && !resolvedHeaders["content-type"]) {
          resolvedHeaders["Content-Type"] = "application/json";
        }
      }

      const fetchOpts: Record<string, unknown> = {
        method: ep.method,
        headers: filterBrowserUnsafeHeaders(resolvedHeaders),
        // Avoid CORS credential-mode failures for public APIs when we have no cookies to send.
        credentials: Object.keys(cookies).length > 0 ? "include" : "omit",
      };
      if (body && ["POST", "PUT", "PATCH"].includes(ep.method)) {
        fetchOpts.body = body;
      }

      const doEval = async () => {
        return await page.evaluate(async ({ url, opts, limit }: { url: string; opts: any; limit: number }) => {
          try {
            const resp = await fetch(url, opts);
            const text = await resp.text().catch(() => "");
            const ct = resp.headers.get("content-type") ?? "";
            const isHtml = ct.includes("text/html") || ct.includes("application/xhtml");
            const data = limit > 0 ? text.slice(0, limit) : text;
            const headers: Record<string, string> = {};
            try {
              resp.headers.forEach((value, key) => { headers[key] = value; });
            } catch { /* ignore */ }
            return { status: resp.status, ok: resp.ok, data, isHtml, contentType: ct, headers };
          } catch (err) {
            return { status: 0, ok: false, data: String(err) };
          }
        }, { url, opts: fetchOpts, limit });
      };

      let out = await doEval();
      // Some API hosts ship restrictive CSP that blocks connect-src even to itself.
      // If that happens, retry once from about:blank (relies on CORS instead of same-origin).
      if (out?.status === 0 && typeof out?.data === "string" && out.data.includes("Failed to fetch")) {
        try {
          await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => { });
          out = await doEval();
        } catch { /* ignore */ }
      }
      return out;
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

  async function execViaFetch(
    ep: { method: string; path: string },
    body: string | undefined,
    limit: number,
    extraHeaders?: Record<string, string>,
    opts?: { useStealth?: boolean },
  ): Promise<{ status: number; ok: boolean; data?: string; isHtml?: boolean; contentType?: string; headers?: Record<string, string>; usedStealth?: boolean }> {
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

    if (extraHeaders && Object.keys(extraHeaders).length > 0) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        reqHeaders[k] = v;
      }
    }

    // Optional: stealth transport (JA3/TLS impersonation) when available.
    if (opts?.useStealth !== false) {
      const stealth = await fetchViaNodeStealth(url, {
        method: ep.method,
        headers: reqHeaders,
        bodyText: body && ["POST", "PUT", "PATCH"].includes(ep.method) ? body : undefined,
        timeoutMs: 10_000,
        profile: "Chrome",
      });
      if (stealth) {
        const ct = stealth.headers["content-type"] ?? stealth.headers["Content-Type"] ?? "";
        const isHtml = ct.toLowerCase().includes("text/html") || ct.toLowerCase().includes("application/xhtml");
        const data = limit > 0 ? stealth.bodyText.slice(0, limit) : stealth.bodyText;
        return {
          status: stealth.status,
          ok: stealth.ok,
          data,
          isHtml,
          contentType: ct,
          headers: stealth.headers,
          usedStealth: true,
        };
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
    // HTML responses can still be a successful "endpoint" for SSR/scraping-style skills.
    const data = limit > 0 ? text.slice(0, limit) : text;
    const headers: Record<string, string> = {};
    for (const [k, v] of resp.headers.entries()) headers[k] = v;
    return { status: resp.status, ok: resp.ok, data, isHtml, contentType: ct, headers, usedStealth: false };
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
          ? loadJsonOr<Record<string, any>>(authPath, {})
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
              ? loadJsonOr<Record<string, any>>(authPath, {})
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

  function sanitizeFilenamePart(input: string): string {
    return String(input || "")
      .replace(/^https?:\/\//i, "")
      .replace(/[^\w.-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 120);
  }

  function maybePersistLocalReplay(
    ep: { method: string; path: string },
    result: { data?: string; isHtml?: boolean } | null,
  ): string | null {
    if (!p.storeRaw) return null;
    if (!result?.data) return null;
    try {
      const dir = join(skillDir, "replays");
      mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const ext = result.isHtml ? "html" : "txt";
      const file = join(dir, `${ts}-${sanitizeFilenamePart(ep.method)}-${sanitizeFilenamePart(ep.path)}.${ext}`);
      writeFileSync(file, result.data, "utf-8");
      return file;
    } catch {
      return null;
    }
  }

  function maybePersistTransformedReplay(
    ep: { method: string; path: string },
    transformed: unknown,
  ): string | null {
    if (!p.storeRaw) return null;
    try {
      const dir = join(skillDir, "replays");
      mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const file = join(dir, `${ts}-${sanitizeFilenamePart(ep.method)}-${sanitizeFilenamePart(ep.path)}.transformed.json`);
      writeFileSync(file, stringifyMaybeJson(transformed), "utf-8");
      return file;
    } catch {
      return null;
    }
  }

  function normalizePathForKey(input: string): string {
    const raw = String(input || "/").trim();
    if (!raw) return "/";
    try {
      if (raw.startsWith("http://") || raw.startsWith("https://")) {
        return new URL(raw).pathname || "/";
      }
    } catch { /* fall through */ }
    const noQuery = raw.split("?")[0]?.split("#")[0] ?? raw;
    return noQuery.startsWith("/") ? noQuery : `/${noQuery}`;
  }

  function toMethodPathKey(method: string, path: string): string {
    return `${String(method || "GET").toUpperCase()} ${normalizePathForKey(path)}`;
  }

  function toTemplateRegex(pathTemplate: string): RegExp | null {
    const pth = normalizePathForKey(pathTemplate);
    // Escape regex then replace {param} with a single-segment wildcard.
    const escaped = pth.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = escaped.replace(/\\\{[^}]+\\\}/g, "[^/]+");
    try {
      return new RegExp(`^${pattern}$`);
    } catch {
      return null;
    }
  }

  function capturedPathname(urlStr: string): string {
    try { return new URL(urlStr).pathname || "/"; } catch { return normalizePathForKey(urlStr); }
  }

  function findBestCapturedTargetIndex(ep: { method: string; path: string }): number | null {
    if (!capturedExchanges || capturedExchanges.length === 0) return null;
    const wantMethod = ep.method.toUpperCase();
    const wantPath = normalizePathForKey(ep.path);
    const re = wantPath.includes("{") ? toTemplateRegex(wantPath) : null;

    let best: { idx: number; score: number; ts: number } | null = null;
    for (const ex of capturedExchanges) {
      if (ex.request.method.toUpperCase() !== wantMethod) continue;
      const gotPath = capturedPathname(ex.request.url);
      let score = 0;
      if (gotPath === wantPath) score = 3;
      else if (re && re.test(gotPath)) score = 2;
      else continue;

      const ts = typeof ex.timestamp === "number" ? ex.timestamp : 0;
      if (!best || score > best.score || (score === best.score && ts > best.ts)) {
        best = { idx: ex.index, score, ts };
      }
    }
    return best?.idx ?? null;
  }

  function extractTransformCode(entry: Record<string, unknown>): string | undefined {
    const direct = [
      entry.transformCode,
      entry.transform_code,
      entry.postprocessTransform,
      entry.postProcessTransform,
      entry.postprocess,
      entry.post_process,
    ];
    for (const candidate of direct) {
      if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
    }
    const nested = entry.transform;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const n: any = nested;
      if (typeof n.code === "string" && n.code.trim().length > 0) return n.code.trim();
      if (typeof n.transformCode === "string" && n.transformCode.trim().length > 0) return n.transformCode.trim();
    }
    return undefined;
  }

  const transformsByMethodPath = (() => {
    const out = new Map<string, string>();
    const refsDir = join(skillDir, "references");
    const candidates = [
      join(refsDir, "TRANSFORMS.json"),
      join(refsDir, "transforms.json"),
      join(skillDir, "TRANSFORMS.json"),
      join(skillDir, "transforms.json"),
    ];
    const file = candidates.find((p) => existsSync(p));
    if (!file) return out;
    try {
      const catalog = loadJsonOr<unknown[]>(file, []);
      if (!Array.isArray(catalog)) return out;
      for (const rawEntry of catalog) {
        if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
        const entry = rawEntry as Record<string, unknown>;
        const code = extractTransformCode(entry);
        if (!code) continue;
        const method = typeof entry.method === "string" ? entry.method : "GET";
        const path =
          typeof (entry as any).normalizedPath === "string" ? (entry as any).normalizedPath :
          typeof (entry as any).normalized_path === "string" ? (entry as any).normalized_path :
          typeof (entry as any).path === "string" ? (entry as any).path :
          "/";
        const key = toMethodPathKey(method, path);
        out.set(key, code);
      }
    } catch {
      // ignore invalid transforms
    }
    return out;
  })();

  async function runResponseTransform(
    responseBody: unknown,
    transformCode: string,
  ): Promise<{ transformed: unknown; error?: string }> {
    const code = String(transformCode || "").trim();
    if (!code) return { transformed: responseBody };
    try {
      const vm = await import("node:vm");
      const sandbox: any = {
        data: responseBody,
        // Built-in helper for SSR/HTML endpoints. Matches server-side name.
        summarizeHtml: (html: string) => summarizeHtmlContent(html),
      };
      vm.createContext(sandbox);
      try {
        const functionScript = new vm.Script(`
          const __transform = (${code});
          if (typeof __transform !== 'function') {
            throw new Error('Transform expression must evaluate to a function');
          }
          __transform(data);
        `);
        const transformed = functionScript.runInContext(sandbox, { timeout: 5000 });
        return { transformed };
      } catch (functionErr: any) {
        try {
          const blockScript = new vm.Script(`(function() { ${code} })()`);
          const transformed = blockScript.runInContext(sandbox, { timeout: 5000 });
          return { transformed };
        } catch (blockErr: any) {
          const message = String(blockErr?.message || functionErr?.message || "Transform failed");
          return { transformed: responseBody, error: message };
        }
      }
    } catch (err: any) {
      return { transformed: responseBody, error: String(err?.message || err || "Transform failed") };
    }
  }

  function parseMaybeJson(text: string, contentType?: string): unknown {
    const ct = String(contentType || "").toLowerCase();
    if (ct.includes("application/json")) {
      try { return text ? JSON.parse(text) : null; } catch { return text; }
    }
    return text;
  }

  function stringifyMaybeJson(value: unknown): string {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }

  const toTest = endpoints.slice(0, p.endpoint ? 1 : 10);
  results.push(`Executing ${p.service} (${toTest.length} endpoint${toTest.length > 1 ? "s" : ""})`, `Base: ${baseUrl}`, "");

  // Default: if we can identify a marketplace skillId (marketplace.json or explicit param),
  // prefer backend gate + client browser execution so the index can track executions.
  const hasMarketplaceMeta = existsSync(marketplaceMetaPath);
  const hasSkillIdHint = typeof p.skillId === "string" && p.skillId.trim().length > 0;
  const executionMode = p.executionMode ?? ((hasMarketplaceMeta || hasSkillIdHint) ? "backend" : "browser");
  if (executionMode === "backend") {
    results.push(`Using backend gate + client browser executor (marketplace)`);
    if (p.intent) results.push(`Intent: ${p.intent}`);
    if (p.traceId) results.push(`TraceId: ${p.traceId}`);
    results.push("");

    const backendSkillId = (() => {
      if (p.skillId) return p.skillId;
      if (existsSync(marketplaceMetaPath)) {
        try {
          const meta = loadJsonOr<Record<string, any>>(marketplaceMetaPath, {});
          if (typeof meta?.skillId === "string" && meta.skillId.trim().length > 0) return meta.skillId.trim();
        } catch { /* ignore */ }
      }
      return null;
    })();

    const shouldAttemptTransforms = transformsByMethodPath.size > 0 && (Boolean(p.endpoint) || Boolean(p.storeRaw));
    const canonicalById = new Map<string, any>();
    if (backendSkillId && shouldAttemptTransforms) {
      try {
        const canonical = await indexClient.getSkillEndpoints(backendSkillId);
        for (const item of canonical || []) {
          if (!item?.endpointId) continue;
          canonicalById.set(String(item.endpointId), item);
        }
      } catch (err) {
        logger.warn(`[unbrowse] Failed to fetch canonical endpoint list for transforms: ${(err as Error).message}`);
      }
    }

    for (const ep of toTest) {
      const body = p.body ?? (["POST", "PUT", "PATCH"].includes(ep.method) ? "{}" : undefined);
      const result = await execViaBackend(ep, body);
      if (result && result.ok) {
        results.push(`  ${ep.method} ${ep.path} → ${result.status} OK`);
        const raw = result.raw;

        let display = result.data ?? "";
        let savedRawPath: string | null = null;
        let savedTransformedPath: string | null = null;

        if (p.storeRaw && typeof raw === "string" && raw.length > 0) {
          const isHtml = /<!doctype html|<html\b|<body\b/i.test(raw);
          savedRawPath = maybePersistLocalReplay(ep, { data: raw, isHtml });
        }

        if (shouldAttemptTransforms && result.endpointId) {
          const canonical = canonicalById.get(result.endpointId);
          const upstreamPath = String(canonical?.rawPath || canonical?.normalizedPath || "");
          const key = toMethodPathKey(ep.method, upstreamPath || ep.path);
          const transformCode = transformsByMethodPath.get(key);
          if (transformCode) {
            const transformed = await runResponseTransform(raw, transformCode);
            if (transformed.error) {
              results.push(`  Transform failed: ${transformed.error}`);
            } else {
              logger.info(`[unbrowse] Applied transform (${key})`);
              display = stringifyMaybeJson(transformed.transformed);
              savedTransformedPath = maybePersistTransformedReplay(ep, transformed.transformed);
            }
          }
        }

        if (p.endpoint && display) {
          const raw = String(display);
          const preview = previewChars > 0 ? raw.slice(0, previewChars) : raw;
          results.push(`  Response: ${preview}`);
        }
        if (savedRawPath) results.push(`  Saved: ${savedRawPath}`);
        if (savedTransformedPath) results.push(`  Saved (transformed): ${savedTransformedPath}`);
        passed++;
      } else {
        results.push(`  ${ep.method} ${ep.path} → ${result?.status || "FAILED"}${result?.data ? ` (${String(result.data).slice(0, 120)})` : ""}`);
        failed++;
      }
    }

    results.push("", `Results: ${passed} passed, ${failed} failed`);
    return { content: [{ type: "text", text: results.join("\n") }] };
  }

  // Check if browser is available upfront.
  // If node mode is forced, don't probe CDP ports (saves time + avoids noisy logs).
  const browserPage = executionMode === "node" ? null : await getChromePage();
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

  const useStealth = typeof p.useStealth === "boolean" ? p.useStealth : true;

  const execPreparedRequest = async (
    prepared: { method: string; url: string; headers: Record<string, string>; bodyText?: string },
    limit: number,
  ): Promise<{ status: number; ok: boolean; data?: string; isHtml?: boolean; contentType?: string; headers?: Record<string, string>; usedStealth?: boolean } | null> => {
    const ep2 = { method: prepared.method, path: prepared.url };
    if (hasBrowser) {
      return await execInChrome(ep2, prepared.bodyText, limit, prepared.headers);
    }
    return await execViaFetch(ep2, prepared.bodyText, limit, prepared.headers, { useStealth });
  };

  for (const ep of toTest) {
    const body = p.body ?? (["POST", "PUT", "PATCH"].includes(ep.method) ? "{}" : undefined);
    const transformCode = transformsByMethodPath.get(toMethodPathKey(ep.method, ep.path));
    const wantsFull = Boolean(p.storeRaw) || maxResponseChars === 0 || Boolean(transformCode);
    const limit = wantsFull ? 0 : maxResponseChars;
    let result: { status: number; ok: boolean; data?: string; isHtml?: boolean; contentType?: string } | null = null;

    // Replay-v2 chain execution (captures + correlations).
    const targetIdx = autoChainLocal && correlationGraph ? findBestCapturedTargetIndex(ep) : null;
    if (p.debugReplayV2) {
      replayV2Debug.push(`targetIdx=${targetIdx == null ? "null" : String(targetIdx)} for ${ep.method} ${ep.path}`);
    }
    if (targetIdx != null && capturedExchanges && correlationGraph) {
      const chain = planChainForTarget(correlationGraph as any, targetIdx);
      if (p.debugReplayV2) replayV2Debug.push(`chain=${chain.join(",")}`);
      const runtimeByIndex = new Map<number, StepResponseRuntime>();
      let final: StepResponseRuntime | null = null;

      for (const stepIdx of chain) {
        const prepared = prepareRequestForStep(
          capturedExchanges,
          correlationGraph as any,
          stepIdx,
          runtimeByIndex,
          {
            sessionHeaders: filterPseudoHeaders(authHeaders),
            bodyOverrideText: (stepIdx === targetIdx && typeof p.body === "string") ? p.body : undefined,
          },
        );
        if (!prepared) continue;
        if (!prepared.bodyText && ["POST", "PUT", "PATCH"].includes(prepared.method)) {
          prepared.bodyText = "{}";
        }

        const internalLimit = stepIdx === targetIdx ? limit : 100_000;
        const stepResult = await execPreparedRequest(prepared, internalLimit);
        const stepHeaders = stepResult?.headers ?? {};
        const bodyText = String(stepResult?.data ?? "");
        const ct = stepResult?.contentType ?? "";

        // Promote session headers (CSRF/auth refresh) into the running header set.
        for (const [name, value] of Object.entries(stepHeaders)) {
          if (SESSION_HEADER_NAMES.has(name.toLowerCase())) {
            authHeaders[name.toLowerCase()] = value;
          }
        }

        const runtime: StepResponseRuntime = {
          status: stepResult?.status ?? 0,
          headers: stepHeaders,
          bodyText,
          contentType: ct,
          bodyJson: undefined,
        };
        runtime.bodyJson = (() => {
          const parsed = (ct.includes("json") || bodyText.trim().startsWith("{") || bodyText.trim().startsWith("["))
            ? safeParseJson(bodyText)
            : null;
          return parsed !== null ? parsed : undefined;
        })();

        runtimeByIndex.set(stepIdx, runtime);
        if (stepIdx === targetIdx) final = runtime;

        // Rate limit intelligence (minimal): respect Retry-After and/or common JSON `backoff`.
        // This prevents false negatives on APIs like StackExchange which return 400 throttle violations if you ignore backoff.
        if (stepIdx !== chain[chain.length - 1]) {
          const retryAfterRaw = stepHeaders["retry-after"] ?? stepHeaders["Retry-After"];
          const retryAfterSec = (() => {
            const n = Number(String(retryAfterRaw ?? "").trim());
            return Number.isFinite(n) && n > 0 ? n : 0;
          })();
          const backoffSec = (() => {
            const b = (runtime.bodyJson && typeof runtime.bodyJson === "object") ? (runtime.bodyJson as any).backoff : undefined;
            const n = Number(b);
            return Number.isFinite(n) && n > 0 ? n : 0;
          })();
          const waitSec = Math.min(30, Math.max(retryAfterSec, backoffSec));
          if (waitSec > 0) {
            if (p.debugReplayV2) replayV2Debug.push(`backoff=${waitSec}s after step=${stepIdx}`);
            await sleepMs(waitSec * 1000);
          }
        }
      }

      if (final) {
        const ok = final.status >= 200 && final.status < 300;
        const isHtml = /<!doctype html|<html\b|<body\b/i.test(final.bodyText) || String(final.contentType ?? "").includes("text/html");
        result = { status: final.status, ok, data: final.bodyText, isHtml, contentType: final.contentType };
      }
    }

    // Strategy: Always use browser if available (authentic fingerprint)
    // Only fall back to Node.js fetch if no browser at all
    if (hasBrowser) {
      result = result ?? await execInChrome(ep, body, limit);
      if (result && result.ok) {
        const saved = maybePersistLocalReplay(ep, result);
        if (transformCode && typeof result.data === "string") {
          const source = parseMaybeJson(result.data, result.contentType);
          const transformed = await runResponseTransform(source, transformCode);
          if (transformed.error) {
            results.push(`  Transform failed: ${transformed.error}`);
          } else {
            logger.info(`[unbrowse] Applied transform (${toMethodPathKey(ep.method, ep.path)})`);
            result.data = stringifyMaybeJson(transformed.transformed);
            const savedTransformed = maybePersistTransformedReplay(ep, transformed.transformed);
            if (savedTransformed) results.push(`  Saved (transformed): ${savedTransformed}`);
          }
        }
        results.push(`  ${ep.method} ${ep.path} → ${result.status} OK`);
        if (p.endpoint && result.data) {
          const preview = previewChars > 0 ? result.data.slice(0, previewChars) : result.data;
          results.push(`  Response: ${preview}`);
        }
        if (saved) results.push(`  Saved: ${saved}`);
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
          result = await execInChrome(ep, body, limit);
          if (result && result.ok) {
            const saved = maybePersistLocalReplay(ep, result);
            if (transformCode && typeof result.data === "string") {
              const source = parseMaybeJson(result.data, result.contentType);
              const transformed = await runResponseTransform(source, transformCode);
              if (transformed.error) {
                results.push(`  Transform failed: ${transformed.error}`);
              } else {
                logger.info(`[unbrowse] Applied transform (${toMethodPathKey(ep.method, ep.path)})`);
                result.data = stringifyMaybeJson(transformed.transformed);
                const savedTransformed = maybePersistTransformedReplay(ep, transformed.transformed);
                if (savedTransformed) results.push(`  Saved (transformed): ${savedTransformed}`);
              }
            }
            results.push(`  ${ep.method} ${ep.path} → ${result.status} OK (refreshed)`);
            if (p.endpoint && result.data) {
              const preview = previewChars > 0 ? result.data.slice(0, previewChars) : result.data;
              results.push(`  Response: ${preview}`);
            }
            if (saved) results.push(`  Saved: ${saved}`);
            passed++;
            continue;
          }
          results.push(`  ${ep.method} ${ep.path} → ${result?.status ?? "FAILED"} (still failed after refresh)`);
        } else {
          results.push(`  Credential refresh unavailable — use unbrowse_login to authenticate`);
        }
      }

      // Browser request failed (not auth issue or refresh didn't help)
      results.push(`  ${ep.method} ${ep.path} → ${status || "FAILED"}${result?.data ? ` (${String(result.data).slice(0, 140)})` : ""}`);
      failed++;
    } else {
      // No browser available - fall back to Node.js fetch
      // This will likely be blocked by sophisticated bot detection
      try {
        result = result ?? await execViaFetch(ep, body, limit, undefined, { useStealth });
        if (result.ok) {
          const saved = maybePersistLocalReplay(ep, result);
          if (transformCode && typeof result.data === "string") {
            const source = parseMaybeJson(result.data, result.contentType);
            const transformed = await runResponseTransform(source, transformCode);
            if (transformed.error) {
              results.push(`  Transform failed: ${transformed.error}`);
            } else {
              logger.info(`[unbrowse] Applied transform (${toMethodPathKey(ep.method, ep.path)})`);
              result.data = stringifyMaybeJson(transformed.transformed);
              const savedTransformed = maybePersistTransformedReplay(ep, transformed.transformed);
              if (savedTransformed) results.push(`  Saved (transformed): ${savedTransformed}`);
            }
          }
          results.push(`  ${ep.method} ${ep.path} → ${result.status} OK (Node.js)${result.isHtml ? " (HTML)" : ""}`);
          if (p.endpoint && result.data) {
            const preview = previewChars > 0 ? result.data.slice(0, previewChars) : result.data;
            results.push(`  Response: ${preview}`);
          }
          if (saved) results.push(`  Saved: ${saved}`);
          passed++;
          continue;
        }

        // Check for auth failure
        const status = result?.status ?? 0;
        if ((status === 401 || status === 403) && !credsRefreshed) {
          results.push(`  ${ep.method} ${ep.path} → ${status} — refreshing credentials...`);
          const refreshed = await refreshCreds();
          if (refreshed) {
            result = await execViaFetch(ep, body, limit, undefined, { useStealth });
            if (result.ok) {
              results.push(`  ${ep.method} ${ep.path} → ${result.status} OK (refreshed)`);
              if (p.endpoint && result.data) {
                const preview = previewChars > 0 ? result.data.slice(0, previewChars) : result.data;
                results.push(`  Response: ${preview}`);
              }
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
      ? loadJsonOr<Record<string, any>>(authPath, {})
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
  if (p.debugReplayV2 && replayV2Debug.length > 0) {
    results.push("", `[debug replay-v2] ${replayV2Debug.join(" | ")}`);
  }
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
