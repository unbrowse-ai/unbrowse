// Which URLs the built-in browser may still open once Unbrowse replaces it: local pages only
// (localhost, *.localhost, 127.x, 0.0.0.0, [::1]) plus non-network schemes (about:, file:, data:, chrome:).

const LOCAL_HOST = /^(localhost|.+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|::1)$/i;
const BARE_HOST = /^(localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#]|$)/i;

/** The http(s) URL a string names, or undefined when it is not a web address (a glob, a ref, prose). */
export function asWebUrl(value: string): URL | undefined {
  const s = value.trim();
  if (!s) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+:\d/.test(s)) {
    try {
      const u = new URL(s);
      return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "ws:" || u.protocol === "wss:" ? u : undefined;
    } catch {
      return undefined;
    }
  }
  if (!BARE_HOST.test(s)) return undefined;
  try {
    return new URL(`http://${s}`);
  } catch {
    return undefined;
  }
}

export function isLocalUrl(u: URL): boolean {
  return LOCAL_HOST.test(u.hostname);
}

const URL_KEYS = new Set(["url", "targetUrl", "targetURL", "href"]);

/** Every web URL in a tool's arguments under a url-like key, at any depth (browser `request`, batch `actions`). */
export function webUrlsIn(params: unknown, depth = 0): URL[] {
  if (depth > 6 || !params || typeof params !== "object") return [];
  const out: URL[] = [];
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (typeof value === "string" && URL_KEYS.has(key)) {
      const u = asWebUrl(value);
      if (u) out.push(u);
    } else if (value && typeof value === "object") {
      out.push(...webUrlsIn(value, depth + 1));
    }
  }
  return out;
}
