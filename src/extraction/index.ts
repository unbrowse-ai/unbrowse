import * as cheerio from "cheerio";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- cheerio v1.x doesn't export Element directly
type CheerioEl = any;

// --- Tag / attribute removal sets ---

const STRIP_TAGS = new Set(["script", "style", "noscript", "svg", "iframe"]);
const CHROME_TAGS = new Set(["nav", "footer", "header"]);

const AD_PATTERNS = /\b(ad|ads|advert|advertisement|tracking|tracker|cookie-banner|cookie-consent|cookie-notice|popup|modal-overlay|gdpr|consent|banner-promo)\b/i;
const HIDDEN_ATTRS: Array<{ attr: string; value?: string }> = [
  { attr: "aria-hidden", value: "true" },
  { attr: "hidden" },
];

// Selectors for "main content" regions — tried in priority order
const CONTENT_SELECTORS = [
  "main",
  "article",
  "[role=\"main\"]",
  "#content",
  ".content",
];

// Common repeating-element selectors for card detection
const CARD_SELECTORS = [
  ".card", ".item", ".result", ".product", ".listing",
  ".entry", ".post", ".tile", ".row",
  "[class*='card']", "[class*='item']", "[class*='result']",
  "[class*='product']", "[class*='listing']",
  // Semantic HTML patterns — articles/sections as repeated items
  "article", "section > div > div",
  // Common e-commerce / catalog patterns
  "[class*='pod']", "[class*='grid-item']", "[class*='col-']",
];

// ---------------------------------------------------------------------------
// cleanDOM
// ---------------------------------------------------------------------------

/**
 * Strip noise from raw page HTML — remove scripts, styles, nav chrome,
 * ads, hidden elements. Prefer content inside main/article regions.
 */
export function cleanDOM(html: string): string {
  const $ = cheerio.load(html);

  // 1. Remove script/style/svg/iframe/noscript tags entirely
  //    Preserve JSON-LD scripts — they contain structured data
  for (const tag of STRIP_TAGS) {
    if (tag === "script") {
      $("script").not('[type="application/ld+json"]').remove();
    } else {
      $(tag).remove();
    }
  }

  // 2. Remove navigation chrome
  for (const tag of CHROME_TAGS) {
    $(tag).remove();
  }

  // 3. Remove ad/tracking elements by class/id
  $("*").each((_, el) => {
    const $el = $(el);
    const cls = $el.attr("class") ?? "";
    const id = $el.attr("id") ?? "";
    if (AD_PATTERNS.test(cls) || AD_PATTERNS.test(id)) {
      $el.remove();
    }
  });

  // 4. Remove hidden elements
  $("[style]").each((_, el) => {
    const $el = $(el);
    const style = ($el.attr("style") ?? "").replace(/\s/g, "");
    if (style.includes("display:none") || style.includes("visibility:hidden")) {
      $el.remove();
    }
  });
  for (const { attr, value } of HIDDEN_ATTRS) {
    const selector = value ? `[${attr}="${value}"]` : `[${attr}]`;
    $(selector).remove();
  }

  // 5. Prefer content region if available (but only if it's a single container,
  //    not multiple repeating elements like <article> per product)
  for (const sel of CONTENT_SELECTORS) {
    const region = $(sel);
    if (region.length === 1 && region.text().trim().length > 100) {
      return region.html() ?? $.html();
    }
  }

  return $("body").html() ?? $.html();
}

// ---------------------------------------------------------------------------
// parseStructured
// ---------------------------------------------------------------------------

interface ExtractedStructure {
  type: string;
  data: unknown;
  element_count: number;
}

/**
 * Heuristic extraction of structured data from HTML.
 * Returns an array of discovered data structures.
 */
export function parseStructured(html: string): ExtractedStructure[] {
  const $ = cheerio.load(html);
  const results: ExtractedStructure[] = [];

  // --- JSON-LD ---
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;
      const parsed = JSON.parse(raw);
      results.push({ type: "json-ld", data: parsed, element_count: 1 });
    } catch { /* malformed JSON-LD */ }
  });

  // --- Meta tags (Open Graph + schema.org) ---
  const meta: Record<string, string> = {};
  $("meta[property], meta[name]").each((_, el) => {
    const $el = $(el);
    const key = $el.attr("property") ?? $el.attr("name") ?? "";
    const content = $el.attr("content") ?? "";
    if ((key.startsWith("og:") || key.startsWith("article:") ||
         key.startsWith("twitter:") || key.startsWith("schema:")) && content) {
      meta[key] = content;
    }
  });
  if (Object.keys(meta).length > 0) {
    results.push({ type: "meta", data: meta, element_count: Object.keys(meta).length });
  }

  // --- Tables ---
  $("table").each((_, table) => {
    const rows = parseTable($, $(table));
    if (rows.length > 0) {
      results.push({ type: "table", data: rows, element_count: rows.length });
    }
  });

  // --- Definition lists (key-value pairs) ---
  $("dl").each((_, dl) => {
    const pairs = parseDL($, $(dl));
    if (Object.keys(pairs).length > 0) {
      results.push({ type: "key-value", data: pairs, element_count: Object.keys(pairs).length });
    }
  });

  // --- Ordered/unordered lists ---
  $("ul, ol").each((_, list) => {
    const $list = $(list);
    // Only capture lists with structured content (multiple li with text)
    const items: string[] = [];
    $list.children("li").each((_, li) => {
      const text = $(li).text().trim();
      if (text) items.push(text);
    });
    if (items.length >= 2) {
      results.push({ type: "list", data: items, element_count: items.length });
    }
  });

  // --- Repeating card/element patterns ---
  const cardResults = detectRepeatingPatterns($);
  results.push(...cardResults);

  return results;
}

function parseTable($: cheerio.CheerioAPI, $table: cheerio.Cheerio<CheerioEl>): Record<string, string>[] {
  const headers: string[] = [];
  $table.find("thead th, thead td, tr:first-child th").each((_, th) => {
    headers.push($(th).text().trim());
  });

  // If no headers found in thead, try first row
  if (headers.length === 0) {
    const firstRow = $table.find("tr").first();
    firstRow.find("td, th").each((_, cell) => {
      headers.push($(cell).text().trim());
    });
  }

  if (headers.length === 0) return [];

  const hasThead = $table.find("thead").length > 0;
  // When thead exists, only iterate tbody rows; otherwise skip the first row (used as headers)
  const dataRows = hasThead
    ? $table.find("tbody tr").toArray()
    : $table.find("tr").toArray().slice(1);

  const rows: Record<string, string>[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const row: Record<string, string> = {};
    let hasData = false;
    $(dataRows[i]).find("td, th").each((j, cell) => {
      if (j < headers.length && headers[j]) {
        const val = $(cell).text().trim();
        if (val) {
          row[headers[j]] = val;
          hasData = true;
        }
      }
    });
    if (hasData) rows.push(row);
  }

  return rows;
}

function parseDL($: cheerio.CheerioAPI, $dl: cheerio.Cheerio<CheerioEl>): Record<string, string> {
  const result: Record<string, string> = {};
  let currentKey = "";
  $dl.children("dt, dd").each((_, el) => {
    const tag = (el as CheerioEl).tagName?.toLowerCase();
    if (tag === "dt") {
      currentKey = $(el).text().trim();
    } else if (tag === "dd" && currentKey) {
      result[currentKey] = $(el).text().trim();
      currentKey = "";
    }
  });
  return result;
}

function detectRepeatingPatterns($: cheerio.CheerioAPI): ExtractedStructure[] {
  const results: ExtractedStructure[] = [];
  const seen = new Set<string>();

  for (const selector of CARD_SELECTORS) {
    const elements = $(selector);
    if (elements.length < 2) continue;

    // Deduplicate by parent to avoid capturing the same set via multiple selectors
    const parent = elements.first().parent();
    const parentId = getElementSignature($, parent);
    if (seen.has(parentId)) continue;
    seen.add(parentId);

    const items: Record<string, string>[] = [];
    elements.each((_, el) => {
      const item = extractCardFields($, $(el));
      // Require at least 2 fields to be a meaningful card
      if (Object.keys(item).length >= 2) items.push(item);
    });

    if (items.length >= 2) {
      results.push({
        type: "repeated-elements",
        data: items,
        element_count: items.length,
      });
    }
  }

  // Sibling-based detection: group child elements by identical class strings.
  // Handles Tailwind/utility-class sites where class names are non-semantic
  // (e.g. "h-full cursor-pointer overflow-hidden rounded-lg flex flex-col").
  if (results.length === 0) {
    const siblingGroups = detectSiblingPatterns($);
    results.push(...siblingGroups);
  }

  return results;
}

/**
 * Detect repeating sibling elements that share the same full class string.
 * Works for Tailwind/utility-class sites where standard selectors fail.
 */
function detectSiblingPatterns($: cheerio.CheerioAPI): ExtractedStructure[] {
  const results: ExtractedStructure[] = [];
  const seenParents = new Set<string>();

  // Scan all elements that could be container parents
  $("div, section, ul, ol, main").each((_, parent) => {
    const $parent = $(parent);
    const children = $parent.children();
    if (children.length < 3) return;

    // Group children by their full class string
    const groups = new Map<string, CheerioEl[]>();
    children.each((_, child) => {
      const cls = $(child).attr("class") || "";
      if (cls.length < 3) return; // skip classless or trivially-classed elements
      const key = `${(child as any).tagName}|${cls}`;
      const arr = groups.get(key) || [];
      arr.push(child);
      groups.set(key, arr);
    });

    for (const [key, elements] of groups) {
      if (elements.length < 3) continue;

      // Avoid processing the same parent+class group twice
      const parentSig = getElementSignature($, $parent) + "|" + key;
      if (seenParents.has(parentSig)) continue;
      seenParents.add(parentSig);

      const items: Record<string, string>[] = [];
      for (const el of elements) {
        const item = extractCardFields($, $(el));
        if (Object.keys(item).length >= 2) items.push(item);
      }

      if (items.length >= 3) {
        results.push({
          type: "repeated-elements",
          data: items,
          element_count: items.length,
        });
      }
    }
  });

  return results;
}

function getElementSignature($: cheerio.CheerioAPI, $el: cheerio.Cheerio<CheerioEl>): string {
  const tag = $el.prop("tagName") ?? "?";
  const cls = $el.attr("class") ?? "";
  const id = $el.attr("id") ?? "";
  return `${tag}#${id}.${cls}`;
}

function extractCardFields($: cheerio.CheerioAPI, $el: cheerio.Cheerio<CheerioEl>): Record<string, string> {
  const fields: Record<string, string> = {};

  // Extract text from headings (semantic tags + Bootstrap heading classes)
  $el.find("h1, h2, h3, h4, h5, h6, .h1, .h2, .h3, .h4, .h5, .h6, [class*='title'], [class*='header-text'], [class*='hearder']").each((i, h) => {
    const text = $(h).text().trim();
    if (text && text.length < 300) fields[i === 0 ? "title" : `heading_${i}`] = text;
  });

  // Extract links
  const links: string[] = [];
  $el.find("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
      links.push(href);
    }
  });
  if (links.length > 0) fields["link"] = links[0];

  // Extract images
  const img = $el.find("img[src]").first();
  const imgSrc = img.attr("src");
  if (imgSrc) fields["image"] = imgSrc;

  // Extract description/paragraph text (skip price paragraphs)
  $el.find("p").each((_, p) => {
    if (fields["description"]) return;
    const $p = $(p);
    const cls = $p.attr("class") ?? "";
    if (/price|cost|amount|stock|availability/i.test(cls)) return;
    const text = $p.text().trim();
    if (text && text.length > 10) fields["description"] = text;
  });

  // Extract price-like patterns — use the most specific (deepest) match
  const priceEl = $el.find(".price_color, [class*='price']:not(:has([class*='price'])), .price, .cost, .amount").first();
  if (priceEl.length > 0) {
    // Get only direct text content, not nested children
    const priceText = priceEl.contents().filter((_, node) => node.type === "text" || (node as any).tagName === "span")
      .text().trim();
    if (priceText) fields["price"] = priceText;
  }

  // Extract metadata spans (dates, citations, info text)
  $el.find("[class*='date'], [class*='info'], [class*='meta'], [class*='citation'], [class*='addinfo'], time").each((_, s) => {
    const text = $(s).text().trim();
    if (text && text.length > 3 && text.length < 200) {
      // Derive a key from the class name
      const cls = ($(s).attr("class") ?? "").toLowerCase();
      const key = cls.match(/(date|citation|info|meta|time|author|category)/)?.[1] ?? "info";
      if (!fields[key]) fields[key] = text;
    }
  });

  // Fallback: capture the element's direct text if nothing else matched
  if (Object.keys(fields).length === 0) {
    const text = $el.text().trim();
    if (text && text.length < 500) fields["text"] = text;
  }

  return fields;
}

// ---------------------------------------------------------------------------
// extractFromDOM
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  data: unknown;
  extraction_method: string;
  confidence: number;
}

/**
 * Main entry point: clean HTML, extract structured data, and return
 * the best match for the given intent.
 */
export function extractFromDOM(html: string, intent: string): ExtractionResult {
  const cleaned = cleanDOM(html);
  const structures = parseStructured(cleaned);

  if (structures.length === 0) {
    return { data: null, extraction_method: "none", confidence: 0 };
  }

  // Score each structure by relevance to intent
  const intentWords = intent.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = structures.map((s) => ({
    structure: s,
    score: scoreRelevance(s, intentWords),
  }));

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const hasClearWinner = scored.length === 1 || best.score > scored[1].score * 1.5;

  if (hasClearWinner && best.score > 0) {
    return {
      data: best.structure.data,
      extraction_method: best.structure.type,
      confidence: computeConfidence(best.structure, best.score),
    };
  }

  // No clear winner — return all structures
  return {
    data: scored.map((s) => ({
      type: s.structure.type,
      data: s.structure.data,
      relevance_score: s.score,
    })),
    extraction_method: "multiple",
    confidence: computeConfidence(best.structure, best.score) * 0.7,
  };
}

function scoreRelevance(structure: ExtractedStructure, intentWords: string[]): number {
  const text = JSON.stringify(structure.data).toLowerCase();
  let score = 0;

  for (const word of intentWords) {
    if (word.length < 3) continue; // skip short words like "a", "to", etc.
    // Count occurrences of intent word in the data
    const regex = new RegExp(word, "gi");
    const matches = text.match(regex);
    if (matches) {
      score += matches.length;
    }
  }

  // Bonus for highly structured data
  if (structure.type === "json-ld") score += 3;
  if (structure.type === "table") score += 2;
  if (structure.type === "repeated-elements") score += 1;
  if (structure.type === "key-value") score += 1;

  // Bonus for more elements (richer data)
  score += Math.min(structure.element_count * 0.1, 2);

  return score;
}

function computeConfidence(structure: ExtractedStructure, relevanceScore: number): number {
  let confidence = 0;

  // Base confidence from structure type
  switch (structure.type) {
    case "json-ld":
      confidence = 0.9;
      break;
    case "table":
      confidence = 0.8;
      break;
    case "repeated-elements":
      confidence = 0.7;
      break;
    case "key-value":
      confidence = 0.7;
      break;
    case "meta":
      confidence = 0.6;
      break;
    case "list":
      confidence = 0.5;
      break;
    default:
      confidence = 0.3;
  }

  // Boost from element count (more data = more confidence)
  if (structure.element_count > 5) confidence += 0.05;
  if (structure.element_count > 10) confidence += 0.05;

  // Boost from relevance score
  if (relevanceScore > 5) confidence += 0.05;
  if (relevanceScore > 10) confidence += 0.05;

  return Math.min(confidence, 1);
}
