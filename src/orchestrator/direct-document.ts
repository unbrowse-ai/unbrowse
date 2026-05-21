export interface DirectDocumentResult {
  rejected: false;
  title: string;
  url: string;
  content_type: string;
  html_bytes: number;
  text_excerpt: string;
  extraction: {
    source: "direct-document";
    rejected: false;
  };
}

export interface DirectDocumentRejection {
  rejected: true;
  reason: "unsupported_domain" | "not_html" | "too_small" | "challenge_html";
}

// Generic structural gates (HTML check, size floor, anti-bot challenge sniff).
// Applies to ANY http(s) URL — no per-host arm. The bench-cycle-3 surface
// that motivated the generalization (stackoverflow probes 016/017 returned
// 39-byte empty Kuri snapshots while the live SSR page is 200KB+ of real
// question content) is the exact case the existing bloomberg fallback was
// solving, just for a different host. Per CLAUDE.md substrate principle
// ("Anti-patterns: per-domain heuristics that don't generalise"), the
// per-host gate was a substrate violation we now retire.
const HTML_RE = /text\/html|application\/xhtml\+xml/i;
const MIN_DIRECT_DOCUMENT_HTML_BYTES = 5_000;
const CHALLENGE_RE =
  /\b(access denied|are you a robot|captcha|just a moment|pardon our interruption|robot check|unusual traffic|verify you are human)\b/i;

export function isDirectDocumentEligibleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Deprecated alias retained for one release so external imports do not
// break. Functionally identical to isDirectDocumentEligibleUrl now that
// the gate is universal. Remove in the next major.
export const isBloombergDirectDocumentUrl = isDirectDocumentEligibleUrl;

export function buildDirectDocumentResult(
  url: string,
  html: string,
  contentType: string,
): DirectDocumentResult | DirectDocumentRejection {
  if (!isDirectDocumentEligibleUrl(url)) return { rejected: true, reason: "unsupported_domain" };
  if (!HTML_RE.test(contentType)) return { rejected: true, reason: "not_html" };
  if (html.length < MIN_DIRECT_DOCUMENT_HTML_BYTES) return { rejected: true, reason: "too_small" };

  const title = decodeHtmlEntityText(
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "",
  );
  const bodyText = decodeHtmlEntityText(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const challengeHaystack = `${title} ${bodyText.slice(0, 2_000)}`;
  if (CHALLENGE_RE.test(challengeHaystack)) return { rejected: true, reason: "challenge_html" };

  return {
    rejected: false,
    title,
    url,
    content_type: contentType,
    html_bytes: html.length,
    text_excerpt: bodyText.slice(0, 12_000),
    extraction: {
      source: "direct-document",
      rejected: false,
    },
  };
}

export const buildBloombergDirectDocumentResult = buildDirectDocumentResult;

export async function fetchDirectDocument(url: string): Promise<DirectDocumentResult | null> {
  if (!isDirectDocumentEligibleUrl(url)) return null;
  try {
    const res = await fetch(url, {
      headers: { "Accept": "text/html,application/json;q=0.5", "User-Agent": "unbrowse/1.0" },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!res.ok) return fetchDirectDocumentWithCurl(url);
    const contentType = res.headers.get("content-type") ?? "";
    const html = await res.text();
    const result = buildDirectDocumentResult(url, html, contentType);
    return result.rejected ? fetchDirectDocumentWithCurl(url) : result;
  } catch {
    // Fall through to curl below.
  }
  return fetchDirectDocumentWithCurl(url);
}

export const fetchBloombergDirectDocument = fetchDirectDocument;

async function fetchDirectDocumentWithCurl(url: string): Promise<DirectDocumentResult | null> {
  try {
    const { execFile } = await import("node:child_process");
    const marker = "\n__UNBROWSE_CONTENT_TYPE__";
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "curl",
        [
          "-L",
          "--silent",
          "--show-error",
          "--max-time",
          "15",
          "-A",
          "unbrowse/1.0",
          "-H",
          "Accept: text/html,application/json;q=0.5",
          "-w",
          `${marker}%{content_type}`,
          url,
        ],
        { maxBuffer: 5 * 1024 * 1024 },
        (error, out) => error ? reject(error) : resolve(out),
      );
    });
    const markerIndex = stdout.lastIndexOf(marker);
    if (markerIndex < 0) return null;
    const html = stdout.slice(0, markerIndex);
    const contentType = stdout.slice(markerIndex + marker.length).trim();
    const result = buildDirectDocumentResult(url, html, contentType);
    return result.rejected ? null : result;
  } catch {
    return null;
  }
}

function decodeHtmlEntityText(input: string): string {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
