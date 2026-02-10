import type { ToolDeps } from "../deps.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
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
  },
): Promise<ToolResponse | null> {
  const { logger, browserPort, defaultOutputDir } = deps;

  // OpenClaw browser API (preferred) - uses native browser control.
  const { getOpenClawBrowser } = await import("../../../openclaw-browser.js");
  const openclawBrowser = getOpenClawBrowser(browserPort);
  const openclawAvailable = await openclawBrowser.isAvailable();

  if (!openclawAvailable) return null;

  logger.info(`[unbrowse] Using native OpenClaw browser API on port ${browserPort}`);

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

  // Wait for page to settle
  await openclawBrowser.wait({ load: "networkidle", timeoutMs: 10000 });

  // Get initial snapshot with interactive elements
  let snapshot = await openclawBrowser.snapshot({ interactive: true, labels: true });
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
          if (act.index == null && !act.selector) {
            actionResults.push("click_element: missing index or selector");
            break;
          }
          const ref = act.index != null ? refMap.get(act.index) : undefined;
          if (act.index != null && !ref) {
            actionResults.push(`click_element: index ${act.index} not found (max: ${refMap.size})`);
            break;
          }
          const result = await openclawBrowser.act({
            kind: "click",
            ref: ref,
            selector: act.selector,
          });
          if (!result.ok) {
            actionResults.push(`click_element: failed - ${result.error}`);
            break;
          }
          // Re-snapshot after click
          await new Promise((r) => setTimeout(r, 500));
          snapshot = (await openclawBrowser.snapshot({ interactive: true, labels: true })) ?? snapshot;
          refMap = buildRefMap(snapshot.elements);
          actionResults.push(`click_element: [${act.index ?? act.selector}] done`);
          break;
        }

        case "input_text": {
          if (act.index == null && !act.selector) {
            actionResults.push("input_text: missing index or selector");
            break;
          }
          const ref = act.index != null ? refMap.get(act.index) : undefined;
          if (act.index != null && !ref) {
            actionResults.push(`input_text: index ${act.index} not found`);
            break;
          }
          // Clear first if needed (default true)
          if (act.clear !== false && ref) {
            await openclawBrowser.act({ kind: "click", ref });
            await openclawBrowser.act({ kind: "press", text: "Control+a" });
          }
          const result = await openclawBrowser.act({
            kind: "type",
            ref: ref,
            selector: act.selector,
            text: act.text ?? "",
          });
          if (!result.ok) {
            actionResults.push(`input_text: failed - ${result.error}`);
            break;
          }
          actionResults.push(`input_text: [${act.index ?? act.selector}] = "${(act.text ?? "").slice(0, 50)}" done`);
          break;
        }

        case "select_option": {
          if (act.index == null && !act.selector) {
            actionResults.push("select_option: missing index or selector");
            break;
          }
          const ref = act.index != null ? refMap.get(act.index) : undefined;
          if (act.index != null && !ref) {
            actionResults.push(`select_option: index ${act.index} not found`);
            break;
          }
          const result = await openclawBrowser.act({
            kind: "select",
            ref: ref,
            selector: act.selector,
            text: act.text ?? "",
          });
          if (!result.ok) {
            actionResults.push(`select_option: failed - ${result.error}`);
            break;
          }
          snapshot = (await openclawBrowser.snapshot({ interactive: true, labels: true })) ?? snapshot;
          refMap = buildRefMap(snapshot.elements);
          actionResults.push(`select_option: [${act.index ?? act.selector}] = "${act.text}" done`);
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
            const result = await openclawBrowser.act({ kind: "scroll", direction });
            if (!result.ok) {
              actionResults.push(`scroll: failed - ${result.error}`);
              break;
            }
          }
          if (actionResults.at(-1)?.startsWith("scroll: failed")) break;
          snapshot = (await openclawBrowser.snapshot({ interactive: true, labels: true })) ?? snapshot;
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
          const result = await openclawBrowser.act({ kind: "press", text: keys });
          if (!result.ok) {
            actionResults.push(`send_keys: failed - ${result.error}`);
            break;
          }
          snapshot = (await openclawBrowser.snapshot({ interactive: true, labels: true })) ?? snapshot;
          refMap = buildRefMap(snapshot.elements);
          actionResults.push(`send_keys: ${keys} done`);
          break;
        }

        case "wait": {
          const ms = Math.max(0, Number(act.amount ?? 1000));
          await new Promise((r) => setTimeout(r, ms));
          actionResults.push(`wait: ${ms}ms done`);
          snapshot = (await openclawBrowser.snapshot({ interactive: true, labels: true })) ?? snapshot;
          refMap = buildRefMap(snapshot.elements);
          break;
        }

        case "go_to_url": {
          const url = act.text;
          if (!url) {
            actionResults.push("go_to_url: missing URL in text field");
            break;
          }
          await openclawBrowser.navigate(url);
          await openclawBrowser.wait({ load: "networkidle", timeoutMs: 10000 });
          snapshot = (await openclawBrowser.snapshot({ interactive: true, labels: true })) ?? snapshot;
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
        snapshot = (await openclawBrowser.snapshot({ interactive: true, labels: true })) ?? snapshot;
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
  try {
    const skillDir = join(defaultOutputDir, service);
    mkdirSync(skillDir, { recursive: true });
    const authPath = join(skillDir, "auth.json");

    const [cookies, localStorageRaw, sessionStorageRaw] = await Promise.all([
      openclawBrowser.cookies(),
      openclawBrowser.storage("local"),
      openclawBrowser.storage("session"),
    ]);

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

  // Format page state for LLM (index-based display)
  const formatOpenClawSnapshot = (snap: typeof snapshot) => {
    const lines: string[] = [
      `URL: ${snap.url}`,
      `Title: ${snap.title}`,
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

  logger.info(
    `[unbrowse] OpenClaw browse: ${p.actions.length} actions on ${snapshot.url} (${apiCalls.length} API calls, ${(snapshot.elements ?? []).length} elements)`,
  );
  return { content: [{ type: "text", text: resultLines.join("\n") }] };
}
