import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";

export interface DirectDocumentTable {
  caption?: string;
  headers: string[];
  rows: string[][];
}

export interface DirectDocumentResult {
  rejected: false;
  title: string;
  url: string;
  content_type: string;
  html_bytes: number;
  text_excerpt: string;
  markdown: string;
  tables: DirectDocumentTable[];
  extraction: {
    source: "direct-document";
    rejected: false;
  };
}

export interface DirectDocumentRejection {
  rejected: true;
  reason:
    | "unsupported_domain"
    | "not_html"
    | "too_small"
    | "challenge_html"
    | "interstitial_detected"
    | "intent_mismatch"
    | "spa_hydration_required"
    | "dead_or_parked";
  // Optional evidence the agent reads in-thread when judging the rejection.
  // Populated for intent_mismatch / interstitial_detected so the orchestrator's
  // decision_trace can surface WHY direct-document handed off to the browser
  // ladder instead of returning a structurally-PASSing 200.
  evidence?: {
    intent_tokens?: string[];
    response_token_hits?: string[];
    response_token_hit_rate?: number;
    interstitial_signal?: string;
    spa_markers?: string[];
    body_text_chars?: number;
    html_bytes?: number;
  };
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

// Interstitial / logged-out / antibot landing pages return 200 + HTML, but the
// HTML is a wall (sign-in page, "please wait for verification", "JavaScript is
// not available"). Without this gate the orchestrator returned them as a
// structural direct-document PASS because the body cleared the size + content-
// type + CHALLENGE_RE gates. Evidence: bench probes against mail.google.com,
// linkedin.com/feed, x.com/home, reddit.com/r/* all hit this surface 2026-05-21.
// Generic across vendors (cloudflare / datadome / akamai / perimeterx); no
// per-host arm.
const INTERSTITIAL_RE =
  /\b(please wait for verification|just a moment|cf-mitigated|datadome|akamai bot|perimeterx|sign in to continue|log in to (?:continue|access)|javascript is not available)\b/i;

// Floor below which the document is too thin to plausibly be the answer to any
// content intent (observed 86-byte meta-only envelopes on SPA tag pages).
// MIN_DIRECT_DOCUMENT_HTML_BYTES already gates raw HTML at 5KB, but the EXTRACTED
// text inside a 5KB SPA shell can collapse to <500 chars. Apply this on text.
const MIN_DIRECT_DOCUMENT_BODY_TEXT = 500;

// SPA hydration markers — Next.js / Nuxt / Redux / generic React SSR shells emit
// these inline-script anchors when the page hydrates client-side. The body text
// scraped from the pre-hydration HTML is thin chrome (header/footer/loading
// skeleton); the agent's content lives in the data blob the SPA later renders
// via fetch + render. When direct-document sees these markers AND the extracted
// body text is below a hydration floor, the right next step is the browser
// ladder (with a hydration wait), NOT returning the empty meta envelope.
//
// Triggered by civitai-class probes (next.js SPA returning a 50KB shell with
// <500 chars of visible text — only the `<title>` and `<meta>` survive the
// strip; the search results render after window.__NEXT_DATA__ is consumed).
// Generic across stacks; no per-host arm.
const SPA_HYDRATION_RE =
  /\b(__NEXT_DATA__|_next\/static|window\.__NUXT__|window\.__INITIAL_STATE__|__APOLLO_STATE__|window\.__PRELOADED_STATE__|window\.__INITIAL_PROPS__|_nuxt\/static)\b/i;
// Body text floor below which an SPA shell is considered un-hydrated.
// A real direct-document page (wikipedia article, stackoverflow question)
// has >2000 chars of visible text after script/style strip; SPA shells
// pre-hydration collapse to <2000 (often <1000).
const SPA_HYDRATION_BODY_TEXT_FLOOR = 2_000;

// Marker-less CSR shells. SPA_HYDRATION_RE catches SSR frameworks that inline a
// state blob (Next/Nuxt/Apollo/Redux). But a pure client-rendered app
// (Vite / Create-React-App / Angular / Svelte / Vue CLI) ships an EMPTY root
// container and a single bundle <script> with NONE of those inline markers — the
// "empty <div id=root>" failure mode. When the visible body is below the
// hydration floor AND one of these root anchors is present, the page is an
// un-hydrated CSR shell whose data renders via fetch+render, so the right next
// step is the browser ladder with a hydration wait — same as the SSR-shell case.
// Generic across stacks; no per-host arm. Anchored on framework-conventional
// root ids / hydration attributes, not on emptiness (a thin body already proved
// the shell is un-hydrated).
const SPA_ROOT_CONTAINER_RE =
  /\bid=["'](?:root|app|__next|__nuxt|q-app|svelte|application)["']|\bdata-reactroot\b|\bdata-server-rendered=["']true["']|\bng-version=["']/i;

// Dead / parked / placeholder domains: registrar landers ("buy this domain"),
// default webserver pages (Apache "It works!", nginx welcome), and for-sale
// parking pages return 200 + HTML that clears the size gate but carries no
// real content and no API. Escalating these through the curl → browser ladder
// burns the whole per-site budget before failing. Detecting them here returns a
// terminal `dead_or_parked` so the caller can fail fast and spend that budget on
// the SPA sites that genuinely need a render. Generic across registrars/parkers.
const PARKED_RE =
  /\b(this domain (?:name )?is for sale|buy this domain|the domain .{1,40} is for sale|domain (?:is )?parked|parked free, courtesy|domain parking|sedoparking|bodis\.com|hugedomains|parkingcrew|domain for sale|future home of something|apache2? (?:ubuntu|debian)? ?default page|nginx welcome|it works!|default web ?(?:site|page) ?page|under construction)\b/i;

// Stopwords pulled from a generic English list; verbs that signal an intent
// action are stripped because they are unlikely to appear verbatim in a result
// body ("get the X": the response shows X, not the word "get").
const INTENT_STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "by", "for", "from", "get",
  "got", "have", "how", "i", "in", "into", "is", "it", "its", "list", "me", "my",
  "of", "on", "or", "search", "show", "that", "the", "their", "them", "then",
  "there", "these", "they", "this", "those", "to", "view", "was", "what",
  "when", "where", "which", "who", "why", "will", "with", "you", "your", "find",
  "fetch", "see", "give", "want", "need", "please", "all", "some", "current",
  "latest", "top", "page", "site", "open", "load", "trending", "discover",
  "browse", "lookup", "look",
]);

function extractMeaningfulTokens(intent: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of intent.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (INTENT_STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

const MARKDOWN_BUDGET = 12_000;
const MAX_TABLES = 10;
const MAX_TABLE_ROWS = 50;

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
  intent?: string,
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

  // Fix 5 — dead/parked fast-fail. A registrar lander / default webserver page
  // clears the structural gates but has no content and no API; escalating it
  // through the browser ladder wastes the per-site budget. Fail terminally here.
  const parkedHit = PARKED_RE.exec(challengeHaystack);
  if (parkedHit) {
    return {
      rejected: true,
      reason: "dead_or_parked",
      evidence: {
        interstitial_signal: parkedHit[0],
        body_text_chars: bodyText.length,
        html_bytes: html.length,
      },
    };
  }

  // Interstitial / logged-out / SPA-meta-envelope detection. Generic across
  // vendors (cloudflare / datadome / akamai / perimeterx) and across auth-walls
  // (sign-in pages on linkedin / gmail / x.com). Runs BEFORE the intent check
  // because an interstitial body coincidentally containing intent tokens
  // (e.g. "Sign in to continue to Gmail" when intent is "gmail inbox") would
  // otherwise pass the token-overlap gate.
  const interstitialHit = INTERSTITIAL_RE.exec(`${title} ${bodyText.slice(0, 4_000)}`);
  if (interstitialHit) {
    return {
      rejected: true,
      reason: "interstitial_detected",
      evidence: {
        interstitial_signal: interstitialHit[0],
        html_bytes: html.length,
      },
    };
  }
  // SPA-hydration gate (wired separately from the constants block at L91/97):
  // when the body text is below the hydration floor AND the HTML carries any
  // SSR-shell marker (__NEXT_DATA__, _next/static, __NUXT__, __INITIAL_STATE__,
  // __APOLLO_STATE__, __PRELOADED_STATE__, __INITIAL_PROPS__, _nuxt/static),
  // reject with `spa_hydration_required` so the orchestrator escalates to the
  // browser ladder with a hydration wait rather than returning the chrome-only
  // meta envelope. Generic across Next.js / Nuxt / Apollo / Redux SSR — no
  // per-host arm. Runs BEFORE the `body_text_below_floor` interstitial path so
  // SPA shells get the precise diagnostic (the agent reads `spa_markers` in
  // evidence and knows to wait for hydration); a thin body WITHOUT any
  // hydration marker still falls through to the interstitial path below.
  if (bodyText.length < SPA_HYDRATION_BODY_TEXT_FLOOR) {
    const spaMarkers: string[] = [];
    const headSlice = html.slice(0, Math.min(html.length, 200_000));
    const scanRe = new RegExp(SPA_HYDRATION_RE.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = scanRe.exec(headSlice)) !== null) {
      if (m[0] && !spaMarkers.includes(m[0])) spaMarkers.push(m[0]);
      if (spaMarkers.length >= 4) break;
    }
    // Fix 2 — marker-less CSR shell. No inline state blob, but an empty
    // framework root container (Vite/CRA/Angular/Svelte ship `<div id="root">`
    // + one bundle script). A thin body already proved it's un-hydrated, so
    // route it to the render ladder rather than letting it fall to the generic
    // interstitial path (which may attempt an auth capture instead of a wait).
    if (spaMarkers.length === 0) {
      const rootHit = SPA_ROOT_CONTAINER_RE.exec(headSlice);
      if (rootHit?.[0]) spaMarkers.push(rootHit[0].slice(0, 40));
    }
    if (spaMarkers.length > 0) {
      return {
        rejected: true,
        reason: "spa_hydration_required",
        evidence: {
          spa_markers: spaMarkers,
          body_text_chars: bodyText.length,
          html_bytes: html.length,
        },
      };
    }
  }

  if (bodyText.length < MIN_DIRECT_DOCUMENT_BODY_TEXT) {
    return {
      rejected: true,
      reason: "interstitial_detected",
      evidence: {
        interstitial_signal: `body_text_below_floor:${bodyText.length}`,
        html_bytes: html.length,
      },
    };
  }

  // Intent-check gate: when the caller hands us an intent, require non-trivial
  // overlap between intent tokens and the response body. Wrong-template /
  // wrong-page / logged-out captures often clear the structural gates above
  // but score 0 on intent overlap because the body is talking about something
  // else entirely (e.g. axios.com homepage when intent is "axios homepage"
  // would actually score 1.0 on "axios"; a wrong-page capture for that intent
  // scores 0). The 0.34 threshold matches the bench-rubric declared in
  // CLAUDE.md (action-verification rubric).
  if (intent && intent.trim().length > 0) {
    const intentTokens = extractMeaningfulTokens(intent);
    if (intentTokens.length >= 2) {
      const haystack = `${title} ${bodyText}`.toLowerCase();
      const hits = intentTokens.filter((tok) => haystack.includes(tok));
      const hitRate = hits.length / intentTokens.length;
      if (hitRate < 0.34) {
        return {
          rejected: true,
          reason: "intent_mismatch",
          evidence: {
            intent_tokens: intentTokens,
            response_token_hits: hits,
            response_token_hit_rate: hitRate,
            html_bytes: html.length,
          },
        };
      }
    }
  }

  return {
    rejected: false,
    title,
    url,
    content_type: contentType,
    html_bytes: html.length,
    text_excerpt: bodyText.slice(0, 12_000),
    markdown: htmlToMarkdownSafe(html, bodyText),
    tables: extractTables(html),
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
    // --compressed advertises Accept-Encoding: gzip,deflate,br AND decodes
    // the response before stdout. Without this, gzipped bodies leaked
    // through as raw 0x1f 0x8b bytes (observed on amazon.com/s smoke probe
    // 2026-05-21). The marker / stdout.slice split is unaffected because
    // curl writes -w AFTER the decoded body completes.
    const stdoutBuf = await new Promise<Buffer>((resolve, reject) => {
      execFile(
        "curl",
        [
          "-L",
          "--silent",
          "--show-error",
          "--compressed",
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
        { maxBuffer: 5 * 1024 * 1024, encoding: "buffer" },
        (error, out) => error ? reject(error) : resolve(out as Buffer),
      );
    });
    // Belt-and-suspenders: if curl didn't decompress for whatever reason
    // (older curl without compression support, mismatched server), detect
    // gzip/deflate/br magic on the body bytes and decode here. This keeps
    // the path safe even if --compressed is silently dropped.
    const decoded = decompressIfNeeded(stdoutBuf, marker);
    const markerIndex = decoded.lastIndexOf(marker);
    if (markerIndex < 0) return null;
    const html = decoded.slice(0, markerIndex);
    const contentType = decoded.slice(markerIndex + marker.length).trim();
    const result = buildDirectDocumentResult(url, html, contentType);
    return result.rejected ? null : result;
  } catch {
    return null;
  }
}

function decompressIfNeeded(buf: Buffer, marker: string): string {
  // The marker is plain ASCII curl writes verbatim; if it's present in the
  // raw buffer the body is already decoded text.
  const text = buf.toString("utf8");
  if (text.includes(marker)) return text;
  // Split off curl's -w trailer (after the last marker bytes) so we only
  // try to decompress the body itself. Marker bytes are ASCII so locate
  // them in the binary buffer directly.
  const markerBytes = Buffer.from(marker, "utf8");
  const markerIdx = buf.lastIndexOf(markerBytes);
  const bodyBuf = markerIdx >= 0 ? buf.subarray(0, markerIdx) : buf;
  const trailer = markerIdx >= 0 ? buf.subarray(markerIdx) : Buffer.alloc(0);
  try {
    let decoded: Buffer | null = null;
    if (bodyBuf.length >= 2 && bodyBuf[0] === 0x1f && bodyBuf[1] === 0x8b) {
      decoded = gunzipSync(bodyBuf);
    } else if (
      bodyBuf.length >= 2 &&
      // zlib/deflate magic: 0x78 followed by common flag bytes
      bodyBuf[0] === 0x78 && (bodyBuf[1] === 0x9c || bodyBuf[1] === 0xda || bodyBuf[1] === 0x01)
    ) {
      decoded = inflateSync(bodyBuf);
    } else {
      // brotli has no fixed magic; try it speculatively only when the body
      // isn't valid utf-8 text. Cheap heuristic: non-printable density.
      const sample = bodyBuf.subarray(0, Math.min(256, bodyBuf.length));
      let nonPrintable = 0;
      for (const byte of sample) {
        if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++;
      }
      if (sample.length > 0 && nonPrintable / sample.length > 0.3) {
        try { decoded = brotliDecompressSync(bodyBuf); } catch { decoded = null; }
      }
    }
    if (decoded) return decoded.toString("utf8") + trailer.toString("utf8");
  } catch {
    // Fall through to raw text below.
  }
  return text;
}

function htmlToMarkdownSafe(html: string, fallbackText: string): string {
  try {
    // Lazy-require to keep module-init cheap and match the cli.ts pattern.
    const TurndownService = require("turndown");
    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
    turndown.remove(["script", "style", "noscript", "iframe", "svg", "link", "meta"]);
    const stripped = html
      .replace(/<!DOCTYPE[^>]*>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<script[^>]*?>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*?>[\s\S]*?<\/style>/gi, "");
    const md = turndown.turndown(stripped).replace(/\n{3,}/g, "\n\n").trim();
    return md.slice(0, MARKDOWN_BUDGET);
  } catch {
    return fallbackText.slice(0, MARKDOWN_BUDGET);
  }
}

// Lightweight table extractor — regex-based on purpose to avoid a DOM
// dependency. Tables with colspan / rowspan / nested <table> are skipped
// because the regex shape can't represent them faithfully and the agent
// should fall back to the markdown rendering for those.
function extractTables(html: string): DirectDocumentTable[] {
  const tables: DirectDocumentTable[] = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let match: RegExpExecArray | null;
  while ((match = tableRe.exec(html)) !== null) {
    if (tables.length >= MAX_TABLES) break;
    const inner = match[1] ?? "";
    // Skip nested tables — the outer regex is non-recursive so an inner
    // <table> tag in `inner` means we'd double-count.
    if (/<table\b/i.test(inner)) continue;
    // Skip colspan/rowspan — flat header/row shape can't represent them.
    if (/\bcol(?:span)\s*=|\browspan\s*=/i.test(inner)) continue;
    const table = parseSimpleTable(inner);
    if (table && table.rows.length > 0) tables.push(table);
  }
  return tables;
}

function parseSimpleTable(inner: string): DirectDocumentTable | null {
  // Caption: explicit <caption>...</caption> takes precedence.
  const captionMatch = inner.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
  const caption = captionMatch ? cellText(captionMatch[1] ?? "") : undefined;

  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const rawRows: { isHeader: boolean; cells: string[] }[] = [];
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(inner)) !== null) {
    const rowInner = rowMatch[1] ?? "";
    const cells: string[] = [];
    let isHeader = false;
    const cellRe = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowInner)) !== null) {
      if ((cellMatch[1] ?? "").toLowerCase() === "th") isHeader = true;
      cells.push(cellText(cellMatch[2] ?? ""));
    }
    if (cells.length > 0) rawRows.push({ isHeader, cells });
    if (rawRows.length >= MAX_TABLE_ROWS + 5) break;
  }

  if (rawRows.length === 0) return null;

  const firstHeaderIdx = rawRows.findIndex((r) => r.isHeader);
  let headers: string[];
  let bodyRows: string[][];
  if (firstHeaderIdx >= 0) {
    headers = rawRows[firstHeaderIdx]!.cells;
    bodyRows = rawRows.filter((_, i) => i !== firstHeaderIdx).map((r) => r.cells);
  } else {
    headers = rawRows[0]!.cells;
    bodyRows = rawRows.slice(1).map((r) => r.cells);
  }

  return {
    ...(caption ? { caption } : {}),
    headers,
    rows: bodyRows.slice(0, MAX_TABLE_ROWS),
  };
}

function cellText(html: string): string {
  return decodeHtmlEntityText(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
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
