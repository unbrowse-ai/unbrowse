// Deterministic message parsing: no model calls. elizaOS 2.x passes planner arguments in `options.parameters`;
// 1.x passes none, so everything falls back to the message text.
import type { Memory } from "@elizaos/core";

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;
// A bare domain such as "example.com/path" (no scheme). Kept conservative: known-looking TLD, no "@" (emails).
const BARE_RE = /(?<![@\w.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|ai|dev|app|co|gov|edu|info|me|so|sh|xyz|us|uk|de|fr|jp|sg|hk|in|ca|au)(?:\/[^\s<>"'`)\]}]*)?)(?![\w@-])/gi;

/** Trailing punctuation that ends a sentence rather than the URL. */
function trimUrl(u: string): string {
  return u.replace(/[.,;:!?]+$/, "");
}

/** Every http(s) URL in the text, in order, deduplicated. Bare domains ("news.ycombinator.com") become https URLs. */
export function extractUrls(text: string | undefined | null): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const m of text.matchAll(URL_RE)) found.push(trimUrl(m[0]));
  if (!found.length) {
    for (const m of text.matchAll(BARE_RE)) found.push(`https://${trimUrl(m[1])}`);
  }
  return [...new Set(found)];
}

export function messageText(message: Memory | undefined): string {
  const t = message?.content?.text;
  return typeof t === "string" ? t.trim() : "";
}

/** Planner parameters (elizaOS 2.x `options.parameters`), or an empty object. */
export function params(options: unknown): Record<string, unknown> {
  const p = (options as { parameters?: unknown } | undefined)?.parameters;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** An object parameter that may arrive as an object or as a JSON string. */
export function obj(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string" && v.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

/** The first URL from parameters, then from the message. */
export function targetUrl(message: Memory | undefined, options: unknown, key = "url"): string | undefined {
  const p = str(params(options)[key]);
  if (p) return /^https?:\/\//i.test(p) ? p : extractUrls(p)[0] ?? p;
  return extractUrls(messageText(message))[0];
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [${text.length - max} more characters]`;
}

export function pretty(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** `field: value` / `field = value` pairs in free text, e.g. "origin: SFO, date = 2026-10-01". */
export function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(?:^|[\s,;])([A-Za-z_][\w.-]{0,63})\s*[:=]\s*("([^"]*)"|'([^']*)'|[^,;\n]+)/g)) {
    const value = (m[3] ?? m[4] ?? m[2]).trim();
    if (value && !/^\/\//.test(value)) out[m[1]] = value; // skip "https://…" read as a pair
  }
  return out;
}
