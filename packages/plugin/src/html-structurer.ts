type HtmlMetaEntry = {
  name: string;
  content: string;
};

type HtmlHeadingSummary = {
  h1: string[];
  h2: string[];
  h3: string[];
};

type HtmlLinkSummary = {
  text: string;
  href: string;
};

type HtmlListSummary = {
  type: "ul" | "ol";
  items: string[];
};

type HtmlTableSummary = {
  caption?: string;
  headers: string[];
  rows: string[][];
};

export type HtmlStructuredSummary = {
  type: "html_document";
  source_url?: string | null;
  origin?: string | null;
  hostname?: string | null;
  path?: string | null;
  canonical_url?: string | null;
  title: string | null;
  meta: HtmlMetaEntry[];
  headings: HtmlHeadingSummary;
  links: HtmlLinkSummary[];
  lists: HtmlListSummary[];
  tables: HtmlTableSummary[];
  text_excerpt: string;
  text_length: number;
  raw_html_excerpt: string;
};

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
};

const MAX_TEXT_EXCERPT = 2000;
const MAX_RAW_EXCERPT = 1500;
const MAX_LIST_ENTRIES = 10;
const MAX_LINKS = 20;
const MAX_TABLE_ROWS = 5;
const MAX_META_ENTRIES = 30;

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity) => {
    if (!entity) return "";
    if (entity[0] === "#") {
      const isHex = entity[1]?.toLowerCase() === "x";
      const codePoint = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isNaN(codePoint)) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return "";
        }
      }
      return "";
    }

    const mapped = ENTITY_MAP[String(entity).toLowerCase()];
    return mapped !== undefined ? mapped : "";
  });
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function extractTagContent(html: string, tagName: string): string[] {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const text = match[1] ?? "";
    const cleaned = decodeHtmlEntities(
      text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    );
    if (cleaned) results.push(cleaned);
  }
  return results;
}

function extractMetaTags(html: string): HtmlMetaEntry[] {
  const regex = /<meta\s+[^>]*?(?:name|property)=["']([^"']+)["'][^>]*?content=["']([^"']+)["'][^>]*>/gi;
  const entries: HtmlMetaEntry[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const [, name, content] = match;
    if (!name || !content) continue;
    entries.push({
      name: decodeHtmlEntities(name.trim()),
      content: decodeHtmlEntities(content.trim()),
    });
    if (entries.length >= MAX_META_ENTRIES) break;
  }
  return entries;
}

function extractLinks(html: string): HtmlLinkSummary[] {
  const regex = /<a\s+[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const links: HtmlLinkSummary[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const [, href, text] = match;
    if (!href) continue;
    const cleanedText = decodeHtmlEntities(
      String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    );
    links.push({ href: href.trim(), text: cleanedText });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

function extractLists(html: string): HtmlListSummary[] {
  const results: HtmlListSummary[] = [];
  const listRegex = /<(ul|ol)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = listRegex.exec(html)) !== null) {
    const [, type, inner] = match;
    if (!type) continue;

    const itemsRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    const items: string[] = [];
    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemsRegex.exec(inner)) !== null) {
      const itemText = itemMatch[1] ?? "";
      const cleaned = decodeHtmlEntities(
        itemText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      );
      if (cleaned) items.push(cleaned);
    }

    if (items.length > 0) {
      results.push({
        type: type.toLowerCase() === "ol" ? "ol" : "ul",
        items: items.slice(0, MAX_LIST_ENTRIES),
      });
    }

    if (results.length >= MAX_LIST_ENTRIES) break;
  }
  return results;
}

function extractTables(html: string): HtmlTableSummary[] {
  const tables: HtmlTableSummary[] = [];
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let match: RegExpExecArray | null;

  while ((match = tableRegex.exec(html)) !== null) {
    const tableHtml = match[1] ?? "";
    if (!tableHtml) continue;

    const captionMatch = /<caption[^>]*>([\s\S]*?)<\/caption>/.exec(tableHtml);
    const caption = captionMatch
      ? decodeHtmlEntities(
          captionMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        )
      : undefined;

    const headers = extractTagContent(tableHtml, "th");
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const rows: string[][] = [];
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1] ?? "";
      const cells = extractTagContent(rowHtml, "td");
      if (cells.length > 0) rows.push(cells);
      if (rows.length >= MAX_TABLE_ROWS) break;
    }

    if (headers.length > 0 || rows.length > 0) {
      tables.push({ caption, headers, rows });
    }
    if (tables.length >= MAX_LIST_ENTRIES) break;
  }

  return tables;
}

function buildHeadingsSummary(html: string): HtmlHeadingSummary {
  return {
    h1: extractTagContent(html, "h1").slice(0, MAX_LIST_ENTRIES),
    h2: extractTagContent(html, "h2").slice(0, MAX_LIST_ENTRIES),
    h3: extractTagContent(html, "h3").slice(0, MAX_LIST_ENTRIES),
  };
}

export function summarizeHtmlContent(
  html: string,
  options?: { sourceUrl?: string },
): HtmlStructuredSummary {
  const sanitized = sanitizeHtml(html);
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(sanitized);
  const title = titleMatch
    ? decodeHtmlEntities(titleMatch[1].replace(/\s+/g, " ").trim())
    : null;

  const textContent = decodeHtmlEntities(
    sanitized
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+\n/g, "\n")
      .replace(/\n\s+/g, "\n")
      .replace(/\s+/g, " ")
      .trim(),
  );

  const textExcerpt = textContent.slice(0, MAX_TEXT_EXCERPT);
  const rawExcerpt = sanitized
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_RAW_EXCERPT);

  let sourceUrl: string | null = null;
  let origin: string | null = null;
  let hostname: string | null = null;
  let path: string | null = null;

  if (options?.sourceUrl) {
    sourceUrl = options.sourceUrl;
    try {
      const parsed = new URL(options.sourceUrl);
      origin = parsed.origin;
      hostname = parsed.hostname;
      path = parsed.pathname + (parsed.search || "");
    } catch {
      origin = null;
      hostname = null;
      path = null;
    }
  }

  let canonicalUrl: string | null = null;
  const canonicalMatch = /<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i.exec(html);
  if (canonicalMatch?.[1]) {
    canonicalUrl = decodeHtmlEntities(canonicalMatch[1].trim());
    if (canonicalUrl && canonicalUrl.startsWith("//") && origin) {
      canonicalUrl = `${new URL(origin).protocol}${canonicalUrl}`;
    } else if (canonicalUrl && canonicalUrl.startsWith("/") && origin) {
      canonicalUrl = `${origin}${canonicalUrl}`;
    }
  }

  return {
    type: "html_document",
    source_url: sourceUrl,
    origin,
    hostname,
    path,
    canonical_url: canonicalUrl,
    title,
    meta: extractMetaTags(sanitized),
    headings: buildHeadingsSummary(sanitized),
    links: extractLinks(sanitized),
    lists: extractLists(sanitized),
    tables: extractTables(sanitized),
    text_excerpt: textExcerpt,
    text_length: textContent.length,
    raw_html_excerpt: rawExcerpt,
  };
}

