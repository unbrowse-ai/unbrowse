import { fetchBrowserCookies, fetchCapturedRequests } from "../../cdp-capture.js";
import { AUTH_SCHEMA } from "../schemas.js";
import type { ToolDeps } from "./deps.js";

export function makeUnbrowseAuthTool(deps: ToolDeps) {
  const { logger, browserPort } = deps;

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
        if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
          return { content: [{ type: "text", text: `Browser not running on port ${browserPort}.` }] };
        }
        return { content: [{ type: "text", text: `Auth extraction failed: ${msg}` }] };
      }
    },
  };
}

