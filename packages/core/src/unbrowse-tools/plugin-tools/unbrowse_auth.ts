import { fetchBrowserCookies, fetchCapturedRequests } from "../../cdp-capture.js";
import { AUTH_SCHEMA } from "../schemas.js";
import type { ToolDeps } from "./deps.js";

export function makeUnbrowseAuthTool(deps: ToolDeps) {
  const { logger, browserPort } = deps;

  function looksLikeJwt(v: string): boolean {
    const s = v.trim();
    if (s.length < 40) return false;
    const parts = s.split(".");
    return parts.length === 3 && parts.every((p) => p.length >= 10);
  }

  function filterAuthyStorage(storage: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(storage ?? {})) {
      const lk = k.toLowerCase();
      if (
        lk.includes("auth") ||
        lk.includes("token") ||
        lk.includes("jwt") ||
        lk.includes("session") ||
        lk.includes("csrf") ||
        lk.includes("xsrf") ||
        lk.includes("api_key") ||
        lk.includes("apikey")
      ) {
        out[k] = String(v ?? "");
      }
    }
    return out;
  }

  return {
    name: "unbrowse_auth",
    label: "Extract Session Auth",
    description:
      "Extract auth from a running browser session — session cookies, auth tokens, API keys, " +
      "CSRF tokens, and custom headers. Low-level tool; prefer unbrowse_capture or unbrowse_login " +
      "which automatically extract auth while capturing internal APIs.",
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

        for (const entry of entries as any[]) {
          if (p.domain) {
            try {
              if (!new URL(entry.url).host.includes(p.domain)) continue;
            } catch { continue; }
          }
          for (const [name, value] of Object.entries(entry.headers ?? {})) {
            if (authNames.has(name.toLowerCase())) {
              authHeaders[name.toLowerCase()] = value as string;
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
          ...Object.entries(cookies).map(([n, v]) => `  ${n}: ${String(v).slice(0, 50)}${String(v).length > 50 ? "..." : ""}`),
        ];

        logger.info(`[unbrowse] Auth: ${Object.keys(authHeaders).length} headers, ${Object.keys(cookies).length} cookies`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("/requests failed")) {
          // Fallback: CDP (:18800) direct connect. No request history, but can pull cookies + storage.
          try {
            const { chromium } = await import("playwright-core");
            const browser = await chromium.connectOverCDP("http://127.0.0.1:18800", { timeout: 5000 });
            const context = browser.contexts()[0] ?? (await browser.newContext());
            const baseUrl = p.domain
              ? (p.domain.startsWith("http://") || p.domain.startsWith("https://") ? p.domain : `https://${p.domain}`)
              : "about:blank";
            const page = context.pages()[0] ?? (await context.newPage());
            if (baseUrl !== "about:blank") {
              await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
              await page.waitForTimeout(750).catch(() => {});
            }

            const cookieList = baseUrl === "about:blank" ? [] : await context.cookies(baseUrl).catch(() => []);
            const cookieMap: Record<string, string> = {};
            for (const c of cookieList as any[]) {
              if (c?.name && typeof c?.value === "string") cookieMap[c.name] = c.value;
            }

            const localStorageAll = await page.evaluate(() => {
              const out: Record<string, string> = {};
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k) continue;
                try { out[k] = String(localStorage.getItem(k) ?? ""); } catch { /* ignore */ }
              }
              return out;
            }).catch(() => ({} as Record<string, string>));

            const sessionStorageAll = await page.evaluate(() => {
              const out: Record<string, string> = {};
              for (let i = 0; i < sessionStorage.length; i++) {
                const k = sessionStorage.key(i);
                if (!k) continue;
                try { out[k] = String(sessionStorage.getItem(k) ?? ""); } catch { /* ignore */ }
              }
              return out;
            }).catch(() => ({} as Record<string, string>));

            const metaTokens = await page.evaluate(() => {
              const out: Record<string, string> = {};
              for (const el of Array.from(document.querySelectorAll("meta"))) {
                const name = (el.getAttribute("name") || el.getAttribute("property") || "").toLowerCase();
                const content = el.getAttribute("content") || "";
                if (!name || !content) continue;
                if (name.includes("csrf") || name.includes("xsrf")) out[name] = content;
              }
              return out;
            }).catch(() => ({} as Record<string, string>));

            const localAuth = filterAuthyStorage(localStorageAll);
            const sessionAuth = filterAuthyStorage(sessionStorageAll);

            // Best-effort: if we see a JWT-looking value, emit an Authorization header hint.
            let authHeaderHint: string | null = null;
            for (const v of [...Object.values(localAuth), ...Object.values(sessionAuth)]) {
              if (looksLikeJwt(v)) { authHeaderHint = `Bearer ${v.trim()}`; break; }
              if (String(v).trim().toLowerCase().startsWith("bearer ")) { authHeaderHint = String(v).trim(); break; }
            }

            const lines = [
              `Auth from OpenClaw-managed Chrome (CDP :18800):`,
              baseUrl !== "about:blank" ? `Domain: ${baseUrl}` : null,
              ``,
              `Cookies (${Object.keys(cookieMap).length}):`,
              ...Object.entries(cookieMap).map(([n, v]) => `  ${n}: ${String(v).slice(0, 50)}${String(v).length > 50 ? "..." : ""}`),
              ``,
              `localStorage (authy keys: ${Object.keys(localAuth).length}):`,
              ...Object.entries(localAuth).map(([n, v]) => `  ${n}: ${String(v).slice(0, 80)}${String(v).length > 80 ? "..." : ""}`),
              ``,
              `sessionStorage (authy keys: ${Object.keys(sessionAuth).length}):`,
              ...Object.entries(sessionAuth).map(([n, v]) => `  ${n}: ${String(v).slice(0, 80)}${String(v).length > 80 ? "..." : ""}`),
              ``,
              `Meta tokens (${Object.keys(metaTokens).length}):`,
              ...Object.entries(metaTokens).map(([n, v]) => `  ${n}: ${String(v).slice(0, 80)}${String(v).length > 80 ? "..." : ""}`),
              ``,
              authHeaderHint ? `Authorization hint: ${authHeaderHint.slice(0, 120)}${authHeaderHint.length > 120 ? "..." : ""}` : null,
            ].filter(Boolean).join("\n");

            await browser.close().catch(() => {});
            return { content: [{ type: "text", text: lines }] };
          } catch (cdpErr) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Auth extraction failed: OpenClaw browser control API not reachable on :${browserPort} and CDP (:18800) connect failed.\n` +
                    `Try: openclaw browser start\n` +
                    `Error: ${(cdpErr as Error).message}`,
                },
              ],
            };
          }
        }
        return { content: [{ type: "text", text: `Auth extraction failed: ${msg}` }] };
      }
    },
  };
}
