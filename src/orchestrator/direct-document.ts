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
