import type { ToolDeps } from "../deps.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiData, ParsedRequest } from "../../../types.js";
import { guessAuthMethod } from "../../../auth-extractor.js";
import { inferCsrfProvenance } from "../../../auth-provenance.js";
import { enrichApiData } from "../../../har-parser.js";
import { generateSkill } from "../../../skill-generator.js";
import { verifyAndPruneGetEndpoints } from "../../../endpoint-verification.js";
import { buildPublishPromptLines, isPayerPrivateKeyValid } from "../publish-prompts.js";
import { loadJsonOr } from "../../../disk-io.js";

type ToolResponse = { content: Array<{ type: "text"; text: string }> };

const AUTH_HEADER_NAMES = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "access-token",
  "x-access-token",
  "token",
  "x-token",
  "x-csrf-token",
  "x-xsrf-token",
]);

function filterAuthStorage(storage: Record<string, string>): Record<string, string> {
  const authKeywords = /token|auth|session|jwt|access|refresh|csrf|xsrf|key|cred|user|login|bearer/i;
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(storage ?? {})) {
    if (authKeywords.test(key)) filtered[key] = value;
  }
  return filtered;
}

function extractAuthHeadersFromRequests(
  captured: Array<{ headers?: Record<string, string> }>,
  localStorage: Record<string, string>,
  sessionStorage: Record<string, string>,
  metaTokens: Record<string, string>,
): Record<string, string> {
  const authHeaders: Record<string, string> = {};

  for (const entry of captured) {
    for (const [name, value] of Object.entries(entry.headers ?? {})) {
      if (AUTH_HEADER_NAMES.has(name.toLowerCase())) authHeaders[name.toLowerCase()] = value;
    }
  }

  for (const [key, value] of [...Object.entries(localStorage ?? {}), ...Object.entries(sessionStorage ?? {})]) {
    const lk = key.toLowerCase();
    // Promote JWT-like tokens to Authorization.
    if (value.startsWith("eyJ") || /^Bearer\s/i.test(value)) {
      const tokenValue = value.startsWith("eyJ") ? `Bearer ${value}` : value;
      if (lk.includes("access") || lk.includes("auth") || lk.includes("token")) {
        if (!authHeaders["authorization"]) authHeaders["authorization"] = tokenValue;
      }
    }
    // Promote CSRF-like storage keys.
    if (lk.includes("csrf") || lk.includes("xsrf")) {
      authHeaders["x-csrf-token"] = value;
    }
  }

  for (const [name, value] of Object.entries(metaTokens ?? {})) {
    const ln = name.toLowerCase();
    if (ln.includes("csrf") || ln.includes("xsrf")) authHeaders["x-csrf-token"] = value;
  }

  return authHeaders;
}

async function readJsonIfExists(path: string): Promise<any> {
  if (!existsSync(path)) return {};
  return loadJsonOr(path, {});
}

async function writeAuthJson(opts: {
  authPath: string;
  baseUrl: string;
  cookies: Record<string, string>;
  authHeaders: Record<string, string>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  metaTokens: Record<string, string>;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const existing = await readJsonIfExists(opts.authPath);
  const merged = {
    ...existing,
    baseUrl: opts.baseUrl,
    headers: { ...(existing.headers ?? {}), ...opts.authHeaders },
    cookies: { ...(existing.cookies ?? {}), ...opts.cookies },
    localStorage: { ...(existing.localStorage ?? {}), ...opts.localStorage },
    sessionStorage: { ...(existing.sessionStorage ?? {}), ...opts.sessionStorage },
    metaTokens: { ...(existing.metaTokens ?? {}), ...opts.metaTokens },
    lastOpenClawBrowseAt: new Date().toISOString(),
  };
  merged.csrfProvenance = inferCsrfProvenance({
    authHeaders: merged.headers,
    cookies: merged.cookies,
    localStorage: merged.localStorage,
    sessionStorage: merged.sessionStorage,
    metaTokens: merged.metaTokens,
    authInfo: existing.authInfo ?? {},
    existing: existing.csrfProvenance,
  });

  try {
    writeFileSync(opts.authPath, JSON.stringify(merged, null, 2), "utf-8");
    opts.logger.info(`[unbrowse] Saved auth state to ${opts.authPath}`);
  } catch (err) {
    opts.logger.warn(`[unbrowse] Failed to write auth.json: ${(err as Error).message}`);
  }
}

export async function runOpenClawBrowse(
  deps: ToolDeps,
  p: {
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
    learnOnFly?: boolean;
  },
): Promise<ToolResponse | null> {
  const { logger, browserPort, browserProfile, defaultOutputDir, discovery } = deps;

  // OpenClaw browser API (preferred) - uses native browser control.
  const { getOpenClawBrowser } = await import("../../../openclaw-browser.js");
  const openclawBrowser = getOpenClawBrowser(browserPort, browserProfile);
  const openclawAvailable = await openclawBrowser.isAvailable();

  if (!openclawAvailable) return null;

  logger.info(
    `[unbrowse] Using native OpenClaw browser API on port ${browserPort}` +
    `${browserProfile ? ` (profile=${browserProfile})` : ""}`,
  );

  // Native OpenClaw /act flow is ref-based; selector-based writes should use fallback flow.
  const hasSelectorDrivenWrite = p.actions.some(
    (act) =>
      Boolean(act.selector) &&
      (act.action === "click_element" || act.action === "input_text" || act.action === "select_option"),
  );
  if (hasSelectorDrivenWrite) return null;

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

  // Ensure browser is running
  const browserStarted = await openclawBrowser.ensureRunning();
  if (!browserStarted) {
    logger.warn(`[unbrowse] OpenClaw browser failed to start, falling back to Playwright`);
    return null;
  }

  // Clear captured requests so we only persist/report the current interaction's traffic.
  await openclawBrowser.requests({ clear: true }).catch(() => []);

  // Navigate to URL
  const navigated = await openclawBrowser.navigate(p.url);
  if (!navigated) {
    return { content: [{ type: "text", text: `Failed to navigate to ${p.url}` }] };
  }

  const snapshotOpts = {
    format: "ai" as const,
    mode: "efficient" as const,
    refs: "role" as const,
    interactive: true,
    labels: true,
  };

  // Wait for page to settle
  await openclawBrowser.wait({ loadState: "networkidle", timeoutMs: 10000 });

  // Get initial snapshot with interactive elements
  let snapshot = await openclawBrowser.snapshot(snapshotOpts);
  if (!snapshot) {
    return { content: [{ type: "text", text: "Failed to get page snapshot" }] };
  }

  // Build index-to-ref mapping (refs are like "e1", "e2", etc.)
  const buildRefMap = (elements: typeof snapshot.elements) => {
    const map = new Map<number, string>();
    (elements ?? []).forEach((el, i) => {
      map.set(i + 1, el.ref); // 1-indexed
    });
    return map;
  };

  let refMap = buildRefMap(snapshot.elements);

  // Execute actions
  const actionResults: string[] = [];

  for (const act of p.actions) {
    try {
      switch (act.action) {
        case "click_element": {
          if (act.index == null) {
            actionResults.push("click_element: missing index");
            break;
          }
          const ref = refMap.get(act.index);
          if (!ref) {
            actionResults.push(`click_element: index ${act.index} not found (max: ${refMap.size})`);
            break;
          }
          const result = await openclawBrowser.act({
            kind: "click",
            ref,
          });
          if (!result.ok) {
            actionResults.push(`click_element: failed - ${result.error}`);
            break;
          }
          // Re-snapshot after click
          await new Promise((r) => setTimeout(r, 500));
          snapshot = (await openclawBrowser.snapshot(snapshotOpts)) ?? snapshot;
          refMap = buildRefMap(snapshot.elements);
          actionResults.push(`click_element: [${act.index}] done`);
          break;
        }

        case "input_text": {
          if (act.index == null) {
            actionResults.push("input_text: missing index");
            break;
          }
          const ref = refMap.get(act.index);
          if (!ref) {
            actionResults.push(`input_text: index ${act.index} not found`);
            break;
          }
          // Clear first if needed (default true)
          if (act.clear !== false) {
            await openclawBrowser.act({ kind: "click", ref });
            await openclawBrowser.act({ kind: "press", key: "Control+a" });
          }
          const result = await openclawBrowser.act({
            kind: "type",
            ref,
            text: act.text ?? "",
          });
          if (!result.ok) {
            actionResults.push(`input_text: failed - ${result.error}`);
            break;
          }
          actionResults.push(`input_text: [${act.index}] = "${(act.text ?? "").slice(0, 50)}" done`);
          break;
        }

        case "select_option": {
          if (act.index == null) {
            actionResults.push("select_option: missing index");
            break;
          }
          const ref = refMap.get(act.index);
          if (!ref) {
            actionResults.push(`select_option: index ${act.index} not found`);
            break;
          }
          const result = await openclawBrowser.act({
            kind: "select",
            ref,
            values: act.text ? [act.text] : [],
          });
          if (!result.ok) {
            actionResults.push(`select_option: failed - ${result.error}`);
            break;
          }
          snapshot = (await openclawBrowser.snapshot(snapshotOpts)) ?? snapshot;
          refMap = buildRefMap(snapshot.elements);
          actionResults.push(`select_option: [${act.index}] = "${act.text}" done`);
          break;
        }

        case "get_dropdown_options": {
          if (act.index == null) {
            actionResults.push("get_dropdown_options: missing index");
            break;
          }
          const el = snapshot.elements?.[act.index - 1];
          if (!el) {
            actionResults.push(`get_dropdown_options: index ${act.index} not found`);
            break;
          }
          const opts = (el.options ?? []).map((o: any) => String(o?.text ?? o?.value ?? "")).filter(Boolean);
          actionResults.push(`get_dropdown_options [${act.index}]: ${opts.join(", ")}`);
          break;
        }

        case "scroll": {
          const direction = act.direction ?? "down";
          const amount = act.amount ?? 600;
          const steps = Math.max(1, Math.ceil(amount / 600));
          for (let i = 0; i < steps; i++) {
            const result = await openclawBrowser.act({
              kind: "press",
              key: direction === "up" ? "PageUp" : "PageDown",
            });
            if (!result.ok) {
              actionResults.push(`scroll: failed - ${result.error}`);
              break;
            }
          }
          if (actionResults.at(-1)?.startsWith("scroll: failed")) break;
          snapshot = (await openclawBrowser.snapshot(snapshotOpts)) ?? snapshot;
          refMap = buildRefMap(snapshot.elements);
          actionResults.push(`scroll: ${direction} ${amount}px done (${steps}x)`);
          break;
        }

        case "send_keys": {
          const keys = act.text;
          if (!keys) {
            actionResults.push("send_keys: missing keys in text field");
            break;
          }
          const result = await openclawBrowser.act({ kind: "press", key: keys });
          if (!result.ok) {
            actionResults.push(`send_keys: failed - ${result.error}`);
            break;
          }
          snapshot = (await openclawBrowser.snapshot(snapshotOpts)) ?? snapshot;
          refMap = buildRefMap(snapshot.elements);
          actionResults.push(`send_keys: ${keys} done`);
          break;
        }

        case "wait": {
          const ms = Math.max(0, Number(act.amount ?? 1000));
          const waited = await openclawBrowser.wait({
            timeMs: ms,
            selector: act.selector,
            timeoutMs: Math.max(10_000, ms + 5_000),
          });
          actionResults.push(waited ? `wait: ${ms}ms done` : `wait: failed after ${ms}ms`);
          snapshot = (await openclawBrowser.snapshot(snapshotOpts)) ?? snapshot;
          refMap = buildRefMap(snapshot.elements);
          break;
        }

        case "go_to_url": {
          const url = act.text;
          if (!url) {
            actionResults.push("go_to_url: missing URL in text field");
            break;
          }
          const navigatedToUrl = await openclawBrowser.navigate(url);
          if (!navigatedToUrl) {
            actionResults.push(`go_to_url: failed to navigate to ${url}`);
            break;
          }
          await openclawBrowser.wait({ loadState: "networkidle", timeoutMs: 10000 });
          snapshot = (await openclawBrowser.snapshot(snapshotOpts)) ?? snapshot;
          refMap = buildRefMap(snapshot.elements);
          actionResults.push(`go_to_url: ${url} done`);
          break;
        }

        case "extract_content": {
          const text = snapshot.snapshot?.slice(0, 3000) ?? "";
          actionResults.push(`extract_content:\n${text}`);
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
      actionResults.push(`${act.action}: FAILED - ${(err as Error).message}`);
      // Re-snapshot so agent can recover
      try {
        snapshot = (await openclawBrowser.snapshot(snapshotOpts)) ?? snapshot;
        refMap = buildRefMap(snapshot.elements);
      } catch {
        // ignore
      }
    }
  }

  // Get captured API traffic
  const capturedRequests = await openclawBrowser.requests();
  const apiCalls = capturedRequests.filter((r: any) => r.resourceType === "xhr" || r.resourceType === "fetch");

  // Persist auth state for future browserless (or browser-backed) replay.
  // For many sites, CSRF tokens + session cookies + SPA storage are the key ingredients.
  // Some sites still require a real browser fetch fingerprint, but persisting the auth
  // state keeps later tool calls deterministic.
  let persistedCookies: Record<string, string> = {};
  let persistedLocalStorage: Record<string, string> = {};
  let persistedSessionStorage: Record<string, string> = {};
  let persistedMetaTokens: Record<string, string> = {};
  let persistedAuthHeaders: Record<string, string> = {};
  try {
    const skillDir = join(defaultOutputDir, service);
    mkdirSync(skillDir, { recursive: true });
    const authPath = join(skillDir, "auth.json");

    const [cookies, localStorageRaw, sessionStorageRaw] = await Promise.all([
      openclawBrowser.cookies(),
      openclawBrowser.storage("local"),
      openclawBrowser.storage("session"),
    ]);
    persistedCookies = cookies;

    const metaTokens =
      ((await openclawBrowser.evaluate(
        String.raw`(() => {
          const out = {};
          const metas = Array.from(document.querySelectorAll("meta"));
          for (const m of metas) {
            const name = (m.getAttribute("name") || m.getAttribute("property") || "").trim();
            const content = (m.getAttribute("content") || "").trim();
            if (!name || !content) continue;
            const ln = name.toLowerCase();
            if (ln.includes("csrf") || ln.includes("xsrf") || ln.includes("auth") || ln.includes("token")) {
              out[name] = content;
            }
          }
          return out;
        })()`,
      )) as Record<string, string> | null) ?? {};

    const localStorage = filterAuthStorage(localStorageRaw);
    const sessionStorage = filterAuthStorage(sessionStorageRaw);
    const authHeaders = extractAuthHeadersFromRequests(capturedRequests, localStorage, sessionStorage, metaTokens);
    persistedLocalStorage = localStorage;
    persistedSessionStorage = sessionStorage;
    persistedMetaTokens = metaTokens;
    persistedAuthHeaders = authHeaders;

    // Best-effort baseUrl; callers can override later.
    const baseUrl = new URL(p.url).origin;

    // Always persist; if fields are empty, merge keeps previous state.
    await writeAuthJson({
      authPath,
      baseUrl,
      cookies,
      authHeaders,
      localStorage,
      sessionStorage,
      metaTokens,
      logger,
    });
  } catch (err) {
    logger.warn(`[unbrowse] Failed to persist OpenClaw auth state: ${(err as Error).message}`);
  }

  // Learn on the fly: if no marketplace skill exists, generate a skill from captured API calls.
  // OpenClaw /requests doesn't include bodies yet; we still learn structure (method/path/domain) + auth headers/cookies.
  let skillResult: { service: string; endpointCount: number; changed: boolean; diff?: string; skillDir: string } | null = null;
  let getVerification: { total: number; verified: number; pruned: number } | null = null;
  if (p.captureTraffic !== false && apiCalls.length >= (p.learnOnFly ? 1 : 2)) {
    try {
      const seedOrigin = new URL(p.url).origin;
      const requests: ParsedRequest[] = [];
      for (const r of apiCalls) {
        try {
          const u = new URL(String(r.url));
          requests.push({
            method: String(r.method || "GET").toUpperCase(),
            url: u.toString(),
            path: u.pathname,
            domain: u.host,
            status: Number(r.status ?? 0),
            resourceType: r.resourceType,
            responseContentType: String(r.responseHeaders?.["content-type"] ?? r.responseHeaders?.["Content-Type"] ?? ""),
          });
        } catch { /* ignore */ }
      }

      const apiData: ApiData = {
        service,
        baseUrls: [seedOrigin],
        baseUrl: seedOrigin,
        authHeaders: persistedAuthHeaders,
        authMethod: guessAuthMethod(persistedAuthHeaders, persistedCookies),
        cookies: persistedCookies,
        authInfo: {},
        requests,
        endpoints: {},
      };

      // Match HarParser behavior: endpoints grouped by domain:path
      for (const req of requests) {
        const key = `${req.domain}:${req.path}`;
        if (!apiData.endpoints[key]) apiData.endpoints[key] = [];
        apiData.endpoints[key].push(req);
      }

      enrichApiData(apiData);
      const testSummary = await verifyAndPruneGetEndpoints(apiData, persistedCookies, { maxEndpoints: 30 });
      if (testSummary) {
        getVerification = {
          total: testSummary.total,
          verified: testSummary.verified,
          pruned: testSummary.pruned,
        };
      }
      const result = await generateSkill(apiData, defaultOutputDir);
      discovery?.markLearned?.(result.service);
      skillResult = result;

      // generateSkill overwrites auth.json; restore storage/meta tokens captured from the browser session.
      try {
        const authPath = join(result.skillDir, "auth.json");
        const existing = existsSync(authPath) ? loadJsonOr<Record<string, any>>(authPath, {}) : {};
        existing.cookies = { ...(existing.cookies ?? {}), ...(persistedCookies ?? {}) };
        existing.headers = { ...(existing.headers ?? {}), ...(persistedAuthHeaders ?? {}) };
        existing.localStorage = { ...(existing.localStorage ?? {}), ...(persistedLocalStorage ?? {}) };
        existing.sessionStorage = { ...(existing.sessionStorage ?? {}), ...(persistedSessionStorage ?? {}) };
        existing.metaTokens = { ...(existing.metaTokens ?? {}), ...(persistedMetaTokens ?? {}) };
        existing.csrfProvenance = inferCsrfProvenance({
          authHeaders: existing.headers,
          cookies: existing.cookies,
          localStorage: existing.localStorage,
          sessionStorage: existing.sessionStorage,
          metaTokens: existing.metaTokens,
          authInfo: existing.authInfo ?? {},
          existing: existing.csrfProvenance,
        });
        writeFileSync(authPath, JSON.stringify(existing, null, 2), "utf-8");
      } catch { /* ignore */ }

      // Publish is explicit; ask user after unbrowse flow completes.
    } catch (err) {
      logger.warn(`[unbrowse] OpenClaw learn-on-fly failed: ${(err as Error).message}`);
    }
  }

  // Format page state for LLM (index-based display)
  const formatOpenClawSnapshot = (snap: typeof snapshot) => {
    const lines: string[] = [
      `URL: ${snap.url}`,
      `Title: ${snap.title ?? "(n/a)"}`,
      "",
      "Interactive elements:",
    ];
    (snap.elements ?? []).forEach((el: any, i: number) => {
      const idx = i + 1;
      const tag = el.tag ?? el.role ?? "element";
      const label = el.name ?? el.text ?? el.value ?? "";
      lines.push(`  [${idx}] <${tag}> ${label.slice(0, 60)}`);
    });
    if ((snap.elements ?? []).length === 0) {
      lines.push("  (no interactive elements)");
    }
    return lines.join("\n");
  };

  const resultLines = [
    `Interaction complete: ${p.actions.length} action(s)`,
    `Browser: OpenClaw native API`,
    "",
    formatOpenClawSnapshot(snapshot),
    "",
    "Action results:",
    ...actionResults.map((r) => `  ${r}`),
  ];

  if (apiCalls.length > 0) {
    resultLines.push(
      "",
      `API traffic captured: ${apiCalls.length} request(s)`,
      ...apiCalls.slice(0, 20).map((r: any) => `  ${r.method} ${String(r.url).slice(0, 100)} -> ${r.status ?? "?"}`),
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
    if (getVerification && getVerification.total > 0) {
      resultLines.push(`  Verified GET: ${getVerification.verified}/${getVerification.total}`);
      if (getVerification.pruned > 0) {
        resultLines.push(`  Pruned failing GETs: ${getVerification.pruned}`);
      }
    }
    if (skillResult.diff) resultLines.push(`  Changes: ${skillResult.diff}`);
    if (skillResult.changed) {
      const hasPayerKey = Boolean(deps.walletState?.solanaPrivateKey);
      const payerKeyValid = hasPayerKey
        ? await isPayerPrivateKeyValid(deps.walletState?.solanaPrivateKey)
        : false;
      const promptLines = buildPublishPromptLines({
        service: skillResult.service,
        skillsDir: defaultOutputDir,
        hasCreatorWallet: Boolean(deps.walletState?.creatorWallet),
        hasPayerKey,
        payerKeyValid,
      });
      resultLines.push(...promptLines.map((line) => `  ${line}`));
    }
    resultLines.push(`  Use unbrowse_replay with service="${skillResult.service}" to call these APIs directly.`);
  }

  logger.info(
    `[unbrowse] OpenClaw browse: ${p.actions.length} actions on ${snapshot.url} (${apiCalls.length} API calls, ${(snapshot.elements ?? []).length} elements)`,
  );
  return { content: [{ type: "text", text: resultLines.join("\n") }] };
}
