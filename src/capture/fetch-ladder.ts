/**
 * fetch-ladder — the shared, declarative KV of HTML/text-fetch fallbacks, walked
 * in the right direction (most anti-bot-evasive first) when a primary fetch or a
 * browser navigation comes back blocked.
 *
 * Anti-bot systems (Reddit's "blocked by network security", Cloudflare, PerimeterX,
 * Incapsula) fingerprint headless Chrome specifically and let a JA4/TLS-spoofed
 * curl-impersonate request through — so a blocked browser `go` should DESCEND to
 * the impersonate rungs here rather than returning the block page. The orchestrator
 * direct-fetch path already did this inline; this module makes the same ladder a
 * single named structure every data-fetch entry point can walk, so the escalation
 * is uniform instead of re-derived per call site.
 */

import { tryCurlImpersonateFetch } from "./curl-impersonate-fallback.js";
import { resolveProxyUrl } from "../execution/proxy-fetch.js";

/** Phrases that mark an anti-bot block / challenge page rather than real content. */
const BLOCK_PHRASES = [
  "blocked by network security",
  "you've been blocked",
  "you have been blocked",
  "attention required", // cloudflare
  "verify you are human",
  "checking your browser",
  "enable javascript and cookies",
  "request unsuccessful. incapsula",
  "access denied",
  "ddos protection by",
  "just a moment", // cloudflare interstitial
];

/**
 * Heuristic: does this page text look like an anti-bot block/challenge page
 * rather than the real content? Known block phrases always qualify; a sub-`minBytes`
 * payload is treated as blocked/empty too (a real data page is rarely that small).
 */
export function looksBlocked(text: string | null | undefined, minBytes = 512): boolean {
  if (!text) return true;
  const t = text.trim();
  const low = t.toLowerCase();
  if (BLOCK_PHRASES.some((p) => low.includes(p))) return true;
  if (t.length < minBytes) return true;
  return false;
}

export interface FetchLadderResult {
  rung: string;
  text: string;
  bytes: number;
  status: number;
}

interface LadderRung {
  name: string;
  run: (
    url: string,
    cookies?: Array<{ name: string; value: string }>,
  ) => Promise<{ text: string; bytes: number; status: number } | null>;
}

/** The ordered ladder — most anti-bot-evasive rungs first (cheapest egress before proxy). */
const FETCH_LADDER: readonly LadderRung[] = [
  {
    name: "impersonate-direct",
    run: async (url, cookies) => {
      const r = await tryCurlImpersonateFetch({ url, timeoutMs: 12_000, forceDirect: true, cookies });
      return r && r.html ? { text: r.html, bytes: r.bytes, status: r.status } : null;
    },
  },
  {
    name: "impersonate-proxy",
    run: async (url, cookies) => {
      const proxy = resolveProxyUrl();
      if (!proxy) return null;
      const r = await tryCurlImpersonateFetch({ url, timeoutMs: 45_000, proxy, cookies });
      return r && r.html ? { text: r.html, bytes: r.bytes, status: r.status } : null;
    },
  },
];

/**
 * Walk the ladder in order, returning the first rung whose result is real
 * (2xx and not a block page). Returns null when every rung is blocked/unavailable.
 * Each rung failure (throw or block) advances to the next; the walk never throws.
 */
export async function walkFetchLadder(
  url: string,
  cookies?: Array<{ name: string; value: string }>,
): Promise<FetchLadderResult | null> {
  for (const rung of FETCH_LADDER) {
    try {
      const r = await rung.run(url, cookies);
      if (r && r.status >= 200 && r.status < 400 && !looksBlocked(r.text)) {
        return { rung: rung.name, text: r.text, bytes: r.bytes, status: r.status };
      }
    } catch {
      /* rung failure → next rung */
    }
  }
  return null;
}
