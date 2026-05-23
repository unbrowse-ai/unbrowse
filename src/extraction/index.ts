import * as cheerio from "cheerio";
import { assessIntentResult } from "../intent-match.js";

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
  ".cds-ProductCard-card", ".cds-ProductCard", "[class*='ProductCard-card']", "[class*='ProductCard']",
  // Semantic HTML patterns — articles/sections as repeated items
  "article", "section > div > div",
  // Common e-commerce / catalog patterns
  "[class*='pod']", "[class*='grid-item']", "[class*='col-']",
];

// ---------------------------------------------------------------------------
// extractSPAData — parse SPA-embedded JSON before cleanDOM strips scripts
// ---------------------------------------------------------------------------

interface SPAExtraction extends ExtractedStructure {
  type: "spa-nextjs" | "spa-nuxt" | "spa-initial-state" | "spa-preloaded-state";
}

function extractHtmlMetadataFallback(html: string): Record<string, unknown> | null {
  // Last-resort extractor that always returns SOMETHING when the main extractor
  // returns nothing. Pulls title, meta tags, JSON-LD blocks, and the first ~3KB
  // of textual body content. Used by SSR-but-JS-rendered pages (Threads,
  // Instagram, BeatSaver, Google Maps) where the main extractor finds no
  // structures but the page still has metadata the agent can act on.
  if (!html || html.length < 100) return null;
  try {
    const $ = cheerio.load(html);
    const out: Record<string, unknown> = {};
    const title = cleanText($("title").first().text() || $('meta[property="og:title"]').attr("content") || "");
    if (title) out.title = title;
    const description = cleanText(
      $('meta[name="description"]').attr("content")
      || $('meta[property="og:description"]').attr("content")
      || $('meta[name="twitter:description"]').attr("content")
      || ""
    );
    if (description) out.description = description;
    const url = cleanText($('link[rel="canonical"]').attr("href") || $('meta[property="og:url"]').attr("content") || "");
    if (url) out.url = url;
    const image = cleanText($('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "");
    if (image) out.image = image;
    const siteName = cleanText($('meta[property="og:site_name"]').attr("content") || "");
    if (siteName) out.site_name = siteName;
    const jsonLdBlocks: unknown[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).html();
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") jsonLdBlocks.push(parsed);
      } catch { /* skip malformed */ }
    });
    if (jsonLdBlocks.length > 0) out.json_ld = jsonLdBlocks;
    const headings: string[] = [];
    $("h1, h2").each((_, el) => {
      const text = cleanText($(el).text());
      if (text && text.length >= 4 && text.length <= 200 && headings.length < 12) headings.push(text);
    });
    if (headings.length > 0) out.headings = headings;
    if (Object.keys(out).length === 0) return null;
    return out;
  } catch {
    return null;
  }
}

function extractFlashNoticeSpecial(html: string, intent: string): ExtractedStructure[] {
  if (!/\b(flash|message|messages|alert|success|error|warning)\b/i.test(intent)) return [];
  const $ = cheerio.load(html);
  const flash = $("#flash, .flash, .alert, [role='alert']").first();
  if (flash.length === 0) return [];
  const flashText = flash.text().replace(/\s+/g, " ").replace(/[×x]\s*$/, "").trim();
  if (!flashText || flashText.length < 4) return [];
  const title = $("main h1, main h2, article h1, article h2, h1, h2").first().text().trim();
  return [{
    type: "key-value",
    data: {
      ...(title ? { title } : {}),
      flash: flashText,
      message: flashText,
    },
    element_count: title ? 2 : 1,
    selector: buildReplaySelector(flash),
  }];
}

/**
 * Extract structured data embedded by SPA frameworks BEFORE cleanDOM strips scripts.
 * Must be called on raw HTML.
 */
/**
 * Brace-balanced object extraction from a JS source string starting at the
 * first `{`. Handles nested braces, strings, and escaped characters. Returns
 * the substring containing the complete top-level `{...}` or null if
 * unterminated. Needed because `\{[\s\S]*?\}` non-greedy regexes silently
 * match the first inner `}` and truncate the payload on any nested object.
 */
function sliceBalancedObject(src: string, startIdx: number): string | null {
  const first = src.indexOf("{", startIdx);
  if (first < 0) return null;
  let depth = 0;
  let inString = false;
  let stringChar = "";
  let escaped = false;
  for (let i = first; i < src.length; i++) {
    const c = src[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (c === "\\") { escaped = true; continue; }
      if (c === stringChar) { inString = false; }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = true;
      stringChar = c;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.substring(first, i + 1);
    }
  }
  return null;
}

/**
 * Brace/bracket-balanced extraction starting exactly at startIdx. Unlike
 * sliceBalancedObject, this accepts both { and [ as the opening char and
 * returns null if startIdx isn't one of them. Used for RSC stream frames
 * which interleave objects and arrays inside the combined __next_f stream.
 */
function sliceBalancedAny(src: string, startIdx: number): string | null {
  const open = src[startIdx];
  if (open !== "{" && open !== "[") return null;
  const closeCh = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let stringChar = "";
  let escaped = false;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (c === "\\") { escaped = true; continue; }
      if (c === stringChar) { inString = false; }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = true;
      stringChar = c;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === closeCh) {
      depth -= 1;
      if (depth === 0) return src.substring(startIdx, i + 1);
    }
  }
  return null;
}

function findWindowAssignmentPayload(html: string, varName: string): string | null {
  // Match window.VAR = { ... with optional whitespace and semicolon. Body
  // pulled via brace-balanced walk, not a non-greedy regex that would
  // silently truncate at the first inner `}` of a nested object.
  const assignRe = new RegExp(String.raw`window\.${varName}\s*=\s*(\{)`, "i");
  const m = assignRe.exec(html);
  if (!m) return null;
  const startIdx = m.index + m[0].length - 1; // position of the `{`
  return sliceBalancedObject(html, startIdx);
}

/**
 * React Query / TanStack Query hydration unwrapper. Many modern React
 * sites (decrypt.co, wired.com, theverge.com, etc.) put the real page
 * content inside `pageProps.dehydratedState.queries[*].state.data` —
 * the raw pageProps itself is just framework metadata (i18n, variables,
 * active terms). Returning the outer pageProps lets the intent matcher
 * reject the SPA in favor of DOM repeated-elements scraping.
 *
 * Walks dehydratedState and returns an array of the per-query `data`
 * objects so the intent scorer sees the actual content.
 */
/**
 * Unwrap React Infinite Query's pagination wrapper. When a query's data
 * shape is `{ pages: [...], pageParams: [...] }`, the real content is
 * inside each page's data payload. Flatten pages into a single array so
 * the intent scorer sees the actual entries (articles, products, etc.)
 * rather than a wrapper object with no intent-matching fields.
 *
 * Shapes handled:
 *   { pages: [{data: [...]}, ...] }     → merged array from all pages
 *   { pages: [{items: [...]}, ...] }    → merged
 *   { pages: [[...], ...] }             → merged
 *   { pages: [{any_key: {data: [...]}}] } → dives one level
 */
function unwrapInfiniteQuery(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const pages = d.pages;
  if (!Array.isArray(pages) || pages.length === 0) return [];
  // Not an infinite-query wrapper unless pageParams also present.
  if (!("pageParams" in d)) return [];
  const merged: unknown[] = [];
  for (const page of pages) {
    if (Array.isArray(page)) {
      merged.push(...page);
    } else if (page && typeof page === "object") {
      const p = page as Record<string, unknown>;
      // Common keys that hold the entry list in paginated responses.
      const listKeys = ["data", "items", "results", "articles", "posts", "nodes", "records"];
      let found = false;
      for (const k of listKeys) {
        const v = p[k];
        if (Array.isArray(v)) {
          merged.push(...v);
          found = true;
          break;
        }
      }
      if (!found) {
        // Dive one level — look for any array-typed field.
        for (const v of Object.values(p)) {
          if (Array.isArray(v) && v.length > 0) {
            merged.push(...v);
            found = true;
            break;
          }
        }
      }
      if (!found) merged.push(page);
    }
  }
  return merged;
}

function unwrapDehydratedState(pageProps: unknown): unknown[] {
  if (!pageProps || typeof pageProps !== "object") return [];
  const dh = (pageProps as Record<string, unknown>).dehydratedState;
  if (!dh || typeof dh !== "object") return [];
  const queries = (dh as Record<string, unknown>).queries;
  if (!Array.isArray(queries)) return [];
  const extracted: unknown[] = [];
  for (const q of queries) {
    if (!q || typeof q !== "object") continue;
    const state = (q as Record<string, unknown>).state;
    if (!state || typeof state !== "object") continue;
    const data = (state as Record<string, unknown>).data;
    if (data == null) continue;
    // If this query is a React Infinite Query paginated cache, flatten
    // the pages array into a single entry list — otherwise the intent
    // scorer sees only `{pages, pageParams}` keys and rejects the SPA
    // source in favor of DOM.
    const infinitePages = unwrapInfiniteQuery(data);
    if (infinitePages.length > 0) {
      extracted.push(infinitePages);
    } else {
      extracted.push(data);
    }
  }
  return extracted;
}

export function extractSPAData(html: string): SPAExtraction[] {
  const results: SPAExtraction[] = [];

  // --- Next.js Pages Router: <script id="__NEXT_DATA__" type="application/json"> ---
  // B4 fix: don't terminate on </script> via non-greedy regex — that fails
  // when embedded data contains a literal "</script>" string (rare but real:
  // Next.js sites that embed user-submitted HTML in pageProps). Find the
  // opening tag, then walk forward until the closing </script> at the
  // matching nesting level (Next.js __NEXT_DATA__ scripts never nest, so a
  // simple forward search is correct).
  const nextDataOpen = /<script\s+id="__NEXT_DATA__"[^>]*>/i.exec(html);
  if (nextDataOpen) {
    const startIdx = nextDataOpen.index + nextDataOpen[0].length;
    const endIdx = html.indexOf("</script>", startIdx);
    if (endIdx > startIdx) {
      const body = html.substring(startIdx, endIdx);
      try {
        const parsed = JSON.parse(body);
        const pageProps = parsed?.props?.pageProps;
        if (pageProps && typeof pageProps === "object" && Object.keys(pageProps).length > 0) {
          // React Query unwrap: many Next.js sites stash real content inside
          // pageProps.dehydratedState.queries[*].state.data. Surface each
          // query's data payload as its own SPA structure so the intent
          // scorer can pick the one matching the current request.
          const dehydrated = unwrapDehydratedState(pageProps);
          for (const qdata of dehydrated) {
            if (qdata && typeof qdata === "object") {
              results.push({
                type: "spa-nextjs",
                data: qdata,
                element_count: countDataElements(qdata),
              });
            }
          }
          // Always also surface the raw pageProps as a fallback (minus
          // the already-unwrapped dehydratedState to avoid duplicating it).
          const rawPageProps =
            dehydrated.length > 0
              ? Object.fromEntries(
                  Object.entries(pageProps as Record<string, unknown>).filter(
                    ([key]) => key !== "dehydratedState",
                  ),
                )
              : (pageProps as Record<string, unknown>);
          if (rawPageProps && Object.keys(rawPageProps).length > 0) {
            results.push({
              type: "spa-nextjs",
              data: rawPageProps,
              element_count: countDataElements(rawPageProps),
            });
          }
        }
      } catch { /* malformed __NEXT_DATA__ */ }
    }
  }

  // --- Nuxt.js: window.__NUXT__={...}. Nuxt bodies may be JS (not JSON),
  // so JSON.parse is best-effort; if it fails we still try eval-free
  // structure discovery via the outer wrapper keys. ---
  const nuxtPayload = findWindowAssignmentPayload(html, "__NUXT__");
  if (nuxtPayload) {
    try {
      const parsed = JSON.parse(nuxtPayload);
      const data = parsed?.data?.[0] ?? parsed?.state ?? parsed;
      if (data && typeof data === "object" && Object.keys(data).length > 0) {
        results.push({
          type: "spa-nuxt",
          data,
          element_count: countDataElements(data),
        });
      }
    } catch { /* Nuxt bodies are often JS literals, not JSON — skip */ }
  }

  // --- Generic: window.__INITIAL_STATE__ ---
  const initialStatePayload = findWindowAssignmentPayload(html, "__INITIAL_STATE__");
  if (initialStatePayload) {
    try {
      const parsed = JSON.parse(initialStatePayload);
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
        results.push({
          type: "spa-initial-state",
          data: parsed,
          element_count: countDataElements(parsed),
        });
      }
    } catch { /* malformed __INITIAL_STATE__ */ }
  }

  // --- Generic: window.__PRELOADED_STATE__ ---
  const preloadedPayload = findWindowAssignmentPayload(html, "__PRELOADED_STATE__");
  if (preloadedPayload) {
    try {
      const parsed = JSON.parse(preloadedPayload);
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
        results.push({
          type: "spa-preloaded-state",
          data: parsed,
          element_count: countDataElements(parsed),
        });
      }
    } catch { /* malformed __PRELOADED_STATE__ */ }
  }

  // --- Apollo Client: window.__APOLLO_STATE__ or <script>window.__APOLLO_STATE__={...}<\/script>.
  // Goodreads and many React/GraphQL apps ship their entire Apollo cache
  // here. Keys are cache IDs like "Book:3735293"; values are the real
  // structured records the page rendered from. ---
  const apolloPayload = findWindowAssignmentPayload(html, "__APOLLO_STATE__");
  if (apolloPayload) {
    try {
      const parsed = JSON.parse(apolloPayload);
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
        results.push({
          type: "spa-initial-state",
          data: parsed,
          element_count: countDataElements(parsed),
        });
      }
    } catch { /* malformed apollo state */ }
  }

  // --- Next.js 13+ App Router streaming: self.__next_f.push([1,"..."])
  // Pages Router ships all data in <script id="__NEXT_DATA__">, but the
  // newer App Router streams serialized server components in many
  // self.__next_f.push([...]) calls throughout the document. Each push
  // contains a prefix byte and a JSON-escaped string that, when joined
  // and parsed, holds the real page data. Any Next.js 13+ site (Vercel
  // default) ships like this — skipping it means missing most modern
  // Next.js hydration. ---
  const nextFPayloads: string[] = [];
  const nextFRe = /self\.__next_f\.push\(\s*\[\s*\d+\s*,\s*("(?:[^"\\]|\\.)*")/g;
  let nextFMatch: RegExpExecArray | null;
  while ((nextFMatch = nextFRe.exec(html))) {
    try {
      const decoded = JSON.parse(nextFMatch[1]);
      if (typeof decoded === "string" && decoded.length > 0) {
        nextFPayloads.push(decoded);
      }
    } catch { /* malformed push */ }
  }
  if (nextFPayloads.length > 0) {
    const combined = nextFPayloads.join("");
    // RSC streams embed many JSON objects separated by newlines with a
    // `<id>:<json>` prefix. Walk the combined stream and pull out each
    // brace-balanced { ... } or [ ... ] fragment — a non-greedy regex
    // would silently truncate at the first inner `}` / `]` (same silent
    // failure as the non-greedy window.__X__ regex fixed earlier).
    const fragments: unknown[] = [];
    for (let i = 0; i < combined.length; i++) {
      const c = combined[i];
      if (c !== "{" && c !== "[") continue;
      const body = sliceBalancedAny(combined, i);
      if (!body) continue;
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object") {
          fragments.push(parsed);
        }
      } catch { /* skip non-JSON at this position */ }
      i += body.length - 1;
    }
    // Keep the top 3 richest fragments. No hard floor — even a small
    // object may be the real page data on simple pages.
    const scored = fragments
      .filter((f) => f && typeof f === "object")
      .map((f) => ({ data: f, count: countDataElements(f) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    for (const entry of scored) {
      if (entry.count >= 2) {
        results.push({
          type: "spa-initial-state",
          data: entry.data,
          element_count: entry.count,
        });
      }
    }
  }
  // --- JSON-LD: <script type="application/ld+json">...</script> ---
  // B4 fix: pre-truncation pass. cleanDOM/cheerio runs on the
  // already-truncated HTML at line 1596 — so any JSON-LD block past
  // byte 300_000 was silently dropped before. Many news/article/recipe
  // sites place schema.org metadata at the document end. Walk the full
  // html for ALL ld+json blocks here so the truncation step downstream
  // can't lose them.
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>/gi;
  let ldMatch: RegExpExecArray | null;
  while ((ldMatch = ldRe.exec(html))) {
    const startIdx = ldMatch.index + ldMatch[0].length;
    const endIdx = html.indexOf("</script>", startIdx);
    if (endIdx <= startIdx) continue;
    const body = html.substring(startIdx, endIdx).trim();
    if (!body) continue;
    try {
      const parsed = JSON.parse(body);
      // ld+json is often a single object or an array of @graph nodes.
      const items = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>)["@graph"]) ? (parsed as Record<string, unknown>)["@graph"] as unknown[] : [parsed]);
      for (const item of items) {
        if (item && typeof item === "object") {
          results.push({
            type: "spa-initial-state",
            data: item,
            element_count: countDataElements(item),
          });
        }
      }
    } catch { /* malformed ld+json — skip */ }
  }

  // Generic homogeneous-array primitive — framework-agnostic.
  //
  // The framework arms above each return ONE wrapper per detected SPA store
  // (Next.js __NEXT_DATA__, Nuxt, Apollo, INITIAL_STATE, RSC stream, JSON-LD).
  // When the wrapper is a heterogeneous bag (e.g. Vercel templates page where
  // pageProps holds many unrelated state slices), the intent scorer sees the
  // wrapper but cannot distinguish "templates" from "navigation" from
  // "user prefs". This primitive walks every wrapper's data, surfaces every
  // homogeneous-shaped array branch as its OWN candidate, and lets the
  // scorer + LLM judge pick the one that matches the intent.
  //
  // No framework registry. Works on Next.js pageProps, Apollo cache slices,
  // Nuxt data[0], plain JSON-LD @graph, anything that nests records.
  const seenBranchSignatures = new Set<string>();
  const branchEmissions: SPAExtraction[] = [];
  const MAX_BRANCHES = 12;
  const MIN_BRANCH_LEN = 3;
  const MAX_PATH_DEPTH = 6;
  const visit = (node: unknown, path: string, depth: number) => {
    if (branchEmissions.length >= MAX_BRANCHES || depth > MAX_PATH_DEPTH) return;
    if (Array.isArray(node)) {
      if (node.length >= MIN_BRANCH_LEN) {
        const objects = node.filter((item) => item && typeof item === "object" && !Array.isArray(item));
        if (objects.length >= MIN_BRANCH_LEN && objects.length >= node.length * 0.7) {
          const keys = objects
            .slice(0, 5)
            .flatMap((o) => Object.keys(o as Record<string, unknown>));
          const sig = `${objects.length}|${[...new Set(keys)].sort().join(",")}`;
          if (!seenBranchSignatures.has(sig)) {
            seenBranchSignatures.add(sig);
            branchEmissions.push({
              type: "spa-initial-state",
              data: node,
              element_count: node.length,
              selector: path || "(root)",
            });
          }
        }
      }
      // Still descend — arrays of mixed types can hide homogeneous sub-arrays.
      for (let i = 0; i < Math.min(node.length, 20); i++) {
        visit(node[i], `${path}[${i}]`, depth + 1);
      }
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        visit(value, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };
  for (const r of results) visit(r.data, "", 0);
  results.push(...branchEmissions);

  return results;
}

/** Count meaningful data elements in a nested structure */
function countDataElements(obj: unknown, depth = 0): number {
  if (depth > 5) return 0;
  if (Array.isArray(obj)) return obj.reduce((sum, item) => sum + Math.max(1, countDataElements(item, depth + 1)), 0);
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj);
    return keys.reduce((sum, k) => sum + countDataElements((obj as Record<string, unknown>)[k], depth + 1), 0);
  }
  return 1;
}

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
  //    Preserve JSON-LD scripts — they contain structured data.
  //    Use each() + manual check instead of .not() because cheerio's
  //    .not() chainable method is unavailable in some bundling contexts
  //    (test isolation issue seen under bun's parallel test runner).
  for (const tag of STRIP_TAGS) {
    if (tag === "script") {
      $("script").each((_, el) => {
        const type = $(el).attr("type") ?? "";
        if (type !== "application/ld+json") {
          $(el).remove();
        }
      });
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
  selector?: string;
}

function hasMessageLikeRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (typeof record.title === "string" || typeof record.heading_1 === "string" || typeof record.heading === "string") &&
    (typeof record.message === "string" || typeof record.description === "string" || typeof record.flash === "string")
  );
}

function isMessageLikeStructure(structure: ExtractedStructure, intent: string): boolean {
  if (!/\b(message|messages|flash|alert|success|error|warning)\b/i.test(intent)) return false;
  if (Array.isArray(structure.data)) return structure.data.some((item) => hasMessageLikeRecord(item));
  return hasMessageLikeRecord(structure.data);
}

function pruneRowsForIntent(rows: Record<string, string>[], intent: string): Record<string, string>[] {
  const lower = intent.toLowerCase();
  const keep = (predicate: (row: Record<string, string>) => boolean): Record<string, string>[] => rows.filter(predicate);

  if (/\b(question|questions)\b/.test(lower)) {
    return keep((row) =>
      !!(row.title || row.name) &&
      !!(row.url || row.link) &&
      !!(row.score || row.answer_count || row.author || row.date || row.meta || row.description) &&
      String(row.title ?? row.name ?? "").trim().length > 12
    );
  }

  if (/\b(post|posts|tweet|tweets|status|statuses)\b/.test(lower)) {
    return keep((row) =>
      !!(row.title || row.text || row.description) &&
      !!(row.url || row.link) &&
      !!(row.author || row.score || row.date || row.meta || row.description || row.text)
    );
  }

  if (/\b(doc|docs|documentation)\b/.test(lower)) {
    return keep((row) =>
      !!(row.title || row.name) &&
      !!(row.url || row.link) &&
      !!(row.summary || row.description || row.slug || row.meta)
    );
  }

  if (/\b(paper|papers)\b/.test(lower)) {
    return keep((row) =>
      !!(row.title || row.name) &&
      !!(row.url || row.link) &&
      !!(row.summary || row.description || row.author || row.date || row.meta)
    );
  }

  if (/\b(definition|dictionary|meaning)\b/.test(lower)) {
    return keep((row) =>
      !!(row.term || row.title || row.name) &&
      !!(row.definition || row.description)
    );
  }

  if (/\b(recipe|recipes)\b/.test(lower)) {
    return keep((row) =>
      !!(row.title || row.name) &&
      !!(row.url || row.link) &&
      !!(row.rating || row.description || row.author || row.meta)
    );
  }

  if (/\b(course|courses)\b/.test(lower)) {
    return keep((row) =>
      !!(row.title || row.name) &&
      !!(row.url || row.link) &&
      !!(row.rating || row.description || row.author || row.meta)
    );
  }

  return rows;
}

function normalizeStructureForIntent(structure: ExtractedStructure, intent: string): ExtractedStructure {
  if (structure.type !== "repeated-elements" || !Array.isArray(structure.data)) return structure;
  const objectRows = (structure.data as unknown[]).filter((row): row is Record<string, string> => !!row && typeof row === "object" && !Array.isArray(row));
  if (objectRows.length === 0) return structure;
  const pruned = pruneRowsForIntent(objectRows, intent);
  if (pruned.length >= 1 && pruned.length < objectRows.length) {
    return {
      ...structure,
      data: pruned,
      element_count: pruned.length,
    };
  }
  return structure;
}

function normalizeGitHubPath(href: string | undefined): string | null {
  if (!href) return null;
  const clean = href.split("?")[0].replace(/\/+$/, "");
  const match = clean.match(/^\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  if (/^(features|topics|collections|marketplace|orgs|users|settings|login|signup|sponsors|pricing|search|notifications|explore|pulls|issues)$/.test(owner)) return null;
  return `${owner}/${repo}`;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}


function extractGitHubSpecial(html: string, intent: string): ExtractedStructure[] {
  if (
    !/github/i.test(html) &&
    !/href=["']\/[^/"']+\/[^/"']+["']/i.test(html) &&
    !/data-target="react-app\.embeddedData"/i.test(html)
  ) return [];
  const $ = cheerio.load(html);
  const results: ExtractedStructure[] = [];
  const intentLower = intent.toLowerCase();

  const embeddedDataMatch = html.match(/<script[^>]+data-target="react-app\.embeddedData"[^>]*>([\s\S]*?)<\/script>/i);
  if (embeddedDataMatch && intentLower.includes("search")) {
    try {
      const parsed = JSON.parse(embeddedDataMatch[1]);
      const embeddedResults = parsed?.payload?.results;
      if (Array.isArray(embeddedResults) && embeddedResults.length >= 2) {
        const repos = embeddedResults
          .map((item: Record<string, unknown>) => {
            const repo = item.repo as { repository?: { owner_login?: string; name?: string } } | undefined;
            const owner = repo?.repository?.owner_login;
            const name = repo?.repository?.name;
            if (!owner || !name) return null;
            const row: Record<string, string> = {
              full_name: `${owner}/${name}`,
              url: `https://github.com/${owner}/${name}`,
            };
            const description = String(item.hl_trunc_description ?? "").replace(/<[^>]+>/g, "").trim();
            const language = String(item.language ?? "").trim();
            const stars = item.followers != null ? String(item.followers) : "";
            if (description) row.description = description;
            if (language) row.language = language;
            if (stars) row.stargazers_count = stars;
            return row;
          })
          .filter((row): row is Record<string, string> => !!row);
        if (repos.length >= 2) {
          results.push({ type: "repeated-elements", data: repos.slice(0, 20), element_count: repos.length });
        }
      }
    } catch { /* malformed embedded data */ }
  }

  const repoNwo = $('meta[name="octolytics-dimension-repository_nwo"]').attr("content")?.trim();
  if (repoNwo && (intentLower.includes("repository") || intentLower.includes("repo"))) {
    const ogDesc = $('meta[property="og:description"]').attr("content")?.trim() || "";
    const stars = $("#repo-stars-counter-star").first().text().trim()
      || $('a[href$="/stargazers"]').first().text().replace(/\s+/g, " ").trim();
    const forks = $('a[href$="/forks"]').first().text().replace(/\s+/g, " ").trim();
    const about = $("h2").filter((_, el) => $(el).text().trim() === "About").first()
      .parent().text().replace(/\s+/g, " ").trim();
    const data: Record<string, string> = {
      full_name: repoNwo,
      description: ogDesc || $('meta[name="description"]').attr("content")?.trim() || "",
      url: $('meta[property="og:url"]').attr("content")?.trim() || `https://github.com/${repoNwo}`,
    };
    if (stars) data.stars = stars;
    if (forks) data.forks = forks;
    if (about && about.length > 20 && about.length < 500) data.about = about;
    results.push({ type: "key-value", data, element_count: Object.keys(data).length });
  }

  if ((/search-results-page/.test(html) || /\/search\?/.test(html) || /resultsrepositories/i.test(html) || /href=["']\/[^/"']+\/[^/"']+["']/i.test(html)) && intentLower.includes("search")) {
    const seen = new Set<string>();
    const repos: Record<string, string>[] = [];
    $(".search-title a[href], [data-testid='results-list'] a[href], .search-results-container a[href], a[href^='/']").each((_, el) => {
      const $a = $(el);
      const href = $a.attr("href");
      const fullName = normalizeGitHubPath(href);
      if (!fullName || seen.has(fullName)) return;
      const title = cleanText($a.text());
      if (!title || title.length > 120) return;
      const card = $a.closest("div, li");
      const cardText = cleanText(card.text());
      const desc = cleanText(card.find("p").first().text());
      const lang = cleanText(card.find("[itemprop='programmingLanguage']").first().text());
      if (!/star|fork|updated|results?|language|repository/i.test(cardText) && !desc && !lang) return;
      seen.add(fullName);
      const stars = cleanText(card.find("a[href$='/stargazers']").first().text());
      const row: Record<string, string> = {
        full_name: fullName,
        url: `https://github.com/${fullName}`,
      };
      if (desc) row.description = desc;
      if (lang) row.language = lang;
      if (stars) row.stars = stars;
      repos.push(row);
    });
    if (repos.length >= 2) {
      results.push({ type: "repeated-elements", data: repos.slice(0, 10), element_count: repos.length });
    }
  }

  if (/trending/i.test(intentLower) || /\/trending\b/.test(html)) {
    const seen = new Set<string>();
    const repos: Record<string, string>[] = [];
    $("article.Box-row, article, .Box-row").each((_, el) => {
      const $el = $(el);
      const repoLink = $el.find("h1 a[href], h2 a[href], a[href^='/']").filter((_, a) => !!normalizeGitHubPath($(a).attr("href"))).first();
      const fullName = normalizeGitHubPath(repoLink.attr("href"));
      if (!fullName || seen.has(fullName)) return;
      const desc = $el.find("p").first().text().replace(/\s+/g, " ").trim();
      const lang = $el.find('[itemprop="programmingLanguage"]').first().text().trim();
      const stars = $el.find('a[href$="/stargazers"]').first().text().replace(/\s+/g, " ").trim();
      seen.add(fullName);
      const row: Record<string, string> = {
        full_name: fullName,
        url: `https://github.com/${fullName}`,
      };
      if (desc) row.description = desc;
      if (lang) row.language = lang;
      if (stars) row.stars = stars;
      repos.push(row);
    });
    if (repos.length >= 2) {
      results.push({ type: "repeated-elements", data: repos.slice(0, 20), element_count: repos.length });
    }
  }

  return results;
}

// extractRepeatedPersonSpecial — generic primitive for repeated-person pages
// (search results, directories, team pages, alumni listings). Replaces the
// retired per-host extractLinkedInSpecial which keyed on `linkedin` literal
// + `a[href*='/in/']` CSS hint.
//
// Universal web standards only (per CLAUDE.md "Ranker philosophy: heuristics
// OUT, primitives + LLM judge IN" and "Anti-patterns: per-domain heuristics
// that don't generalise"):
//
//   Strategy 1: JSON-LD `schema.org/ItemList` whose `itemListElement[].item`
//     is a `Person`. Standards-conformant directory/search pages emit this.
//   Strategy 2: Multiple top-level JSON-LD `schema.org/Person` nodes anywhere
//     in the document — search pages that emit one Person per result block.
//
// Same code path subsumes LinkedIn search-results AND any standards-
// conformant people-listing site (team pages, alumni directories, federated
// social discovery, About.me search, etc).
function extractRepeatedPersonSpecial(html: string, intent: string): ExtractedStructure[] {
  const intentLower = intent.toLowerCase();
  if (!/(search|people|person|persons|profile|profiles|member|members|directory|team|staff|roster|alumni)/.test(intentLower)) return [];

  // Cheap pre-filter: avoid parsing every page. Require at least one
  // JSON-LD block AND a Person-type marker somewhere in the raw HTML.
  if (!/<script[^>]+type=["']application\/ld\+json["']/i.test(html)) return [];
  if (!/"@type"\s*:\s*"Person"/.test(html)) return [];

  const $ = cheerio.load(html);

  // Universal canonical/og:url resolution for relative-href fallback.
  const canonicalUrl = ($('link[rel="canonical"]').attr("href") || "").trim();
  const ogUrl = ($('meta[property="og:url"]').attr("content") || "").trim();
  let baseOrigin = "";
  for (const candidate of [canonicalUrl, ogUrl]) {
    if (!candidate) continue;
    try {
      baseOrigin = new URL(candidate).origin;
      break;
    } catch {
      // fall through
    }
  }
  const resolveHref = (href: string): string => {
    if (!href) return "";
    if (/^https?:\/\//i.test(href)) return href;
    if (!baseOrigin) return href;
    if (href.startsWith("/")) return `${baseOrigin}${href}`;
    return `${baseOrigin}/${href}`;
  };

  const flattenJsonLdNodes = (node: unknown): unknown[] => {
    const out: unknown[] = [];
    const visit = (n: unknown): void => {
      if (!n) return;
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (typeof n !== "object") return;
      const obj = n as Record<string, unknown>;
      out.push(obj);
      if (Array.isArray(obj["@graph"])) (obj["@graph"] as unknown[]).forEach(visit);
      if (Array.isArray(obj.itemListElement)) (obj.itemListElement as unknown[]).forEach(visit);
      if (obj.item && typeof obj.item === "object") visit(obj.item);
      if (obj.mainEntity && typeof obj.mainEntity === "object") visit(obj.mainEntity);
    };
    visit(node);
    return out;
  };
  const nodeType = (n: Record<string, unknown>): string[] => {
    const t = n["@type"];
    if (typeof t === "string") return [t];
    if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
    return [];
  };
  const asStringField = (n: Record<string, unknown>, ...keys: string[]): string => {
    for (const k of keys) {
      const v = n[k];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    return "";
  };

  const seen = new Set<string>();
  const rows: Record<string, string>[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw || raw.length > 200_000) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    for (const node of flattenJsonLdNodes(parsed)) {
      if (!node || typeof node !== "object") continue;
      const obj = node as Record<string, unknown>;
      if (!nodeType(obj).includes("Person")) continue;
      const name = cleanText(asStringField(obj, "name", "givenName"));
      if (!name || name.length < 2 || name.length > 120) continue;
      const url = resolveHref(asStringField(obj, "url"));
      const altName = cleanText(asStringField(obj, "alternateName"));
      // Username: alternateName, else trailing path segment of url.
      let username = altName;
      if (!username && url) {
        try {
          const u = new URL(url);
          const segs = u.pathname.split("/").filter(Boolean);
          if (segs.length > 0) {
            const seg = segs[segs.length - 1].replace(/^@/, "");
            if (/^[A-Za-z0-9_.-]{1,64}$/.test(seg)) username = seg;
          }
        } catch {
          // fall through
        }
      }
      // Dedupe key: prefer url, else username, else name.
      const key = (url || username || name).split("?")[0];
      if (seen.has(key)) continue;
      const headline = cleanText(asStringField(obj, "jobTitle", "description", "disambiguatingDescription"));
      const image = cleanText(asStringField(obj, "image"));
      const row: Record<string, string> = { name };
      if (username) {
        row.username = username;
        row.public_identifier = username;
      }
      if (url) row.url = url;
      if (headline) row.headline = headline;
      if (image) row.image = image;
      rows.push(row);
      seen.add(key);
    }
  });

  return rows.length >= 2
    ? [{ type: "repeated-elements", data: rows.slice(0, 20), element_count: rows.length }]
    : [];
}

function extractPackageSearchSpecial(html: string, intent: string): ExtractedStructure[] {
  const intentLower = intent.toLowerCase();
  if (!/\bsearch\b/.test(intentLower) || !/\b(package|packages|crate|crates)\b/.test(intentLower)) return [];
  if (!/package-snippet/i.test(html)) return [];
  const $ = cheerio.load(html);
  const rows: Record<string, string>[] = [];
  const seen = new Set<string>();

  $("a.package-snippet[href], .package-snippet").each((_, el) => {
    const $el = $(el);
    const name = cleanText($el.find(".package-snippet__name").first().text());
    if (!name || seen.has(name)) return;
    const version = cleanText($el.find(".package-snippet__version").first().text());
    const description = cleanText($el.find(".package-snippet__description").first().text());
    const href = $el.attr("href") ?? "";
    rows.push({
      name,
      ...(version ? { version } : {}),
      ...(description ? { description } : {}),
      url: href ? new URL(href, "https://pypi.org").toString() : `https://pypi.org/project/${encodeURIComponent(name)}/`,
    });
    seen.add(name);
  });

  return rows.length >= 2 ? [{ type: "repeated-elements", data: rows.slice(0, 20), element_count: rows.length }] : [];
}

// ---------------------------------------------------------------------------
// extractPersonProfileSpecial — generic primitive for person/profile pages
// ---------------------------------------------------------------------------
//
// Replaces the prior per-host `extractXProfileSpecial` (deleted 2026-05-20)
// per CLAUDE.md ranker philosophy: heuristics OUT, universal-web-standards
// primitives IN. No `x.com` / `twitter.com` host literal, no
// `https://x.com/${username}` URL fallback. Same code path now handles X,
// Mastodon, Bluesky, Threads, About.me, GitHub user pages, and any
// platform that emits standards-conformant person markup:
//
//   Strategy 1 (JSON-LD schema.org/Person, highest confidence):
//     <script type="application/ld+json"> blocks with @type "Person".
//     Surfaces name, alternateName (handle), url, description, image.
//     Walks @graph and mainEntity nesting.
//
//   Strategy 2 (OpenGraph profile object type):
//     <meta property="og:type" content="profile"> with
//     `profile:username`, `profile:first_name`, `profile:last_name`
//     per https://ogp.me/#type_profile. Falls back to og:title's
//     "Display Name (@handle)" pattern shared by virtually every social
//     platform's OG card.
//
//   Strategy 3 (Twitter card + canonical handle):
//     `<meta name="twitter:title">` + `<link rel="canonical">` whose
//     last path segment looks like a username. Subsumes the X case
//     without naming x.com.
//
// Returns [] when no name + username pair can be assembled, letting
// downstream generic extractors (metadata fallback, SPA) handle the page.
function extractPersonProfileSpecial(html: string, intent: string): ExtractedStructure[] {
  const intentLower = intent.toLowerCase();
  if (!/(person|people|profile|profiles|user|users|member)/.test(intentLower)) return [];
  // Cheap pre-filter: only proceed if the HTML carries at least one
  // person-profile structured marker. Avoids parsing every page.
  if (!/<meta[^>]+property=["']og:|<meta[^>]+name=["']twitter:|"@type"\s*:\s*"Person"/i.test(html)) return [];
  const $ = cheerio.load(html);

  // Universal helpers — same canonical/og:url resolution used by the
  // scholarly primitive. No host literal.
  const canonical = cleanText(
    $('link[rel="canonical"]').attr("href")
      ?? $('meta[property="og:url"]').attr("content")
      ?? "",
  );

  // ---- Strategy 1: JSON-LD schema.org/Person ----
  const flattenJsonLdNodes = (node: unknown): unknown[] => {
    const out: unknown[] = [];
    const visit = (n: unknown): void => {
      if (!n) return;
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (typeof n !== "object") return;
      const obj = n as Record<string, unknown>;
      out.push(obj);
      if (Array.isArray(obj["@graph"])) (obj["@graph"] as unknown[]).forEach(visit);
      if (obj.mainEntity && typeof obj.mainEntity === "object") visit(obj.mainEntity);
    };
    visit(node);
    return out;
  };
  const nodeType = (n: Record<string, unknown>): string[] => {
    const t = n["@type"];
    if (typeof t === "string") return [t];
    if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
    return [];
  };
  const asStringField = (n: Record<string, unknown>, ...keys: string[]): string => {
    for (const k of keys) {
      const v = n[k];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    return "";
  };

  let jsonLdPerson: Record<string, string> | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (jsonLdPerson) return;
    const raw = $(el).contents().text();
    if (!raw || raw.length > 200_000) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    for (const node of flattenJsonLdNodes(parsed)) {
      if (jsonLdPerson) break;
      if (!node || typeof node !== "object") continue;
      const obj = node as Record<string, unknown>;
      if (!nodeType(obj).includes("Person")) continue;
      const name = cleanText(asStringField(obj, "name", "givenName"));
      if (!name) continue;
      const altName = cleanText(asStringField(obj, "alternateName"));
      const url = cleanText(asStringField(obj, "url"));
      const description = cleanText(asStringField(obj, "description", "disambiguatingDescription"));
      const image = cleanText(asStringField(obj, "image"));
      // Username = alternateName when present, else trailing path segment
      // of the person URL (mastodon `@handle`, etc).
      let username = altName;
      if (!username && url) {
        const m = url.match(/\/@?([A-Za-z0-9_.-]{1,64})\/?$/);
        if (m) username = m[1].replace(/^@/, "");
      }
      if (!username) continue;
      const row: Record<string, string> = {
        name,
        username,
        public_identifier: username,
        url: url || canonical,
      };
      if (description) row.description = description;
      if (image) row.image = image;
      jsonLdPerson = row;
    }
  });
  if (jsonLdPerson) return [{ type: "key-value", data: jsonLdPerson, element_count: 1 }];

  // ---- Strategy 2 + 3: OpenGraph profile / Twitter card + canonical ----
  const ogType = cleanText($('meta[property="og:type"]').attr("content") ?? "");
  const ogTitle = cleanText($('meta[property="og:title"]').attr("content") ?? $('meta[name="twitter:title"]').attr("content") ?? "");
  const ogDescription = cleanText($('meta[name="description"]').attr("content") ?? $('meta[property="og:description"]').attr("content") ?? $('meta[name="twitter:description"]').attr("content") ?? "");
  const title = cleanText($("title").first().text());

  // OG profile object type carries `profile:username` per ogp.me.
  const profileUsername = cleanText($('meta[property="profile:username"]').attr("content") ?? "");
  const profileFirstName = cleanText($('meta[property="profile:first_name"]').attr("content") ?? "");
  const profileLastName = cleanText($('meta[property="profile:last_name"]').attr("content") ?? "");

  // Title pattern "Display Name (@handle)" — virtually every social
  // platform emits this in og:title / <title>. NOT host-specific.
  const titleSource = ogTitle || title;
  const titleMatch = titleSource.match(/^(.*?)\s*\(@?([A-Za-z0-9_.-]{1,64})\)/);

  // Last path segment of canonical/og:url as final-fallback handle.
  // Strip leading `@` (Mastodon style) and version-y trailing slashes.
  const canonicalHandle = (() => {
    if (!canonical) return "";
    try {
      const u = new URL(canonical);
      const segs = u.pathname.split("/").filter(Boolean);
      if (segs.length !== 1) return "";
      const seg = segs[0].replace(/^@/, "");
      // Reject reserved/system segments that obviously aren't usernames.
      if (/^(home|about|login|signup|signin|search|explore|settings|help|terms|privacy)$/i.test(seg)) return "";
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(seg)) return "";
      return seg;
    } catch { return ""; }
  })();

  const username = profileUsername || titleMatch?.[2] || canonicalHandle || "";
  const composedName = [profileFirstName, profileLastName].filter(Boolean).join(" ").trim();
  const name = cleanText(
    composedName
      || titleMatch?.[1]
      || titleSource.replace(/\s*[\/—|·]\s*[^/—|·]+$/, "")
  );

  if (!name || !username) return [];

  // Require AT LEAST ONE strong profile signal so we don't fabricate a
  // person from a generic OG card on a marketing/landing page.
  const hasStrongSignal =
    ogType === "profile"
    || profileUsername !== ""
    || titleMatch !== null
    || $('meta[name="twitter:creator"]').attr("content")?.trim().length;
  if (!hasStrongSignal) return [];

  const row: Record<string, string> = {
    name,
    username,
    public_identifier: username,
    url: canonical,
  };
  if (ogDescription) row.description = ogDescription;
  return [{ type: "key-value", data: row, element_count: 1 }];
}

function extractPostSpecial(html: string, intent: string): ExtractedStructure[] {
  const intentLower = intent.toLowerCase();
  if (!/(post|posts|tweet|tweets|status|statuses)/.test(intentLower)) return [];
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const posts: Record<string, string>[] = [];

  $("article, [role='article'], li, div").each((_, el) => {
    const $el = $(el);
    const link = $el.find("a[href*='/status/'], a[href*='/statuses/'], a[href*='/posts/'], a[href*='/@'], a[href*='/s/']").first();
    const href = link.attr("href");
    if (!href || href.length > 300) return;
    const canonical = href.split("?")[0];
    if (seen.has(canonical)) return;
    const title = cleanText(link.text());

    const text = cleanText(
      $el.find("p, span, div")
        .map((__, node) => cleanText($(node).text()))
        .get()
        .filter((value) =>
          value.length >= 20 &&
          value.length <= 700 &&
          !/^(reply|repost|like|share|show more|show less|follow|message)$/i.test(value)
        )
        .sort((a, b) => b.length - a.length)[0] ?? ""
    );

    const mastodonMatch = canonical.match(/\/@([^/]+)\/(\d+)/);
    const statusMatch = canonical.match(/\/status\/(\d+)/);
    const lobstersMatch = canonical.match(/\/s\/([^/]+)/);
    const username = mastodonMatch?.[1]
      ?? canonical.match(/\/([^/@]+)\/status\/\d+/)?.[1]
      ?? cleanText($el.find("[class*='author'], [class*='byline'], .u-author").first().text())
      ?? "";
    const id = mastodonMatch?.[2] ?? statusMatch?.[1] ?? lobstersMatch?.[1] ?? canonical.split("/").pop() ?? "";
    const score = cleanText($el.find("[class*='score'], [class*='points']").first().text());

    if (!text && !username && !title) return;

    posts.push({
      ...(id ? { id } : {}),
      ...(username ? { username } : {}),
      url: canonical,
      ...(title ? { title } : {}),
      ...(text ? { text } : {}),
      ...(score ? { score } : {}),
      ...(username ? { author: username } : {}),
    });
    seen.add(canonical);
  });

  return posts.length >= 1 ? [{ type: "repeated-elements", data: posts.slice(0, 20), element_count: posts.length }] : [];
}

// ---------------------------------------------------------------------------
// extractRepeatedArticleSpecial — generic primitive for repeated-article pages
// ---------------------------------------------------------------------------
//
// Replaces the prior per-host `extractDevToPostSpecial` (deleted 2026-05-20)
// per CLAUDE.md ranker philosophy: heuristics OUT, universal-web-standards
// primitives IN. No `host === "dev.to"`, no `crayons-story` CSS hint, no
// `data-content-user-id` literal. Same code path now handles any site that
// emits standards-conformant article markup:
//
//   Strategy 1 (JSON-LD schema.org, highest confidence):
//     <script type="application/ld+json"> blocks containing Article /
//     BlogPosting / NewsArticle / TechArticle (single, nested in ItemList,
//     or inside @graph). Surfaces headline, url, author.name, datePublished,
//     description.
//
//   Strategy 2 (HTML5 semantic + OpenGraph, when JSON-LD is absent):
//     >=1 <article> elements with an h1/h2/h3 > a title link, plus optional
//     <time>, [rel=author] / [class*=author], and tag-like /t/ links.
//     Base URL for relative hrefs comes from <link rel="canonical"> or
//     <meta property="og:url"> — no per-host string is hardcoded.
//
// Returns [] when neither strategy yields >=1 rows, letting downstream
// generic extractors (article-body, SPA, metadata fallback) handle the page.
function extractRepeatedArticleSpecial(html: string, intent: string): ExtractedStructure[] {
  const intentLower = intent.toLowerCase();
  if (!/(post|posts|article|articles|blog|story|stories|tutorial|tutorials)/.test(intentLower)) return [];
  const $ = cheerio.load(html);

  // Derive base URL for relative-href resolution from canonical/og:url.
  // Universal web-standards lookup; no host literal anywhere.
  const canonicalUrl = ($('link[rel="canonical"]').attr("href") || "").trim();
  const ogUrl = ($('meta[property="og:url"]').attr("content") || "").trim();
  let baseOrigin = "";
  for (const candidate of [canonicalUrl, ogUrl]) {
    if (!candidate) continue;
    try {
      baseOrigin = new URL(candidate).origin;
      break;
    } catch {
      // fall through
    }
  }
  const resolveHref = (href: string): string => {
    if (!href) return "";
    if (/^https?:\/\//i.test(href)) return href;
    if (!baseOrigin) return href;
    if (href.startsWith("/")) return `${baseOrigin}${href}`;
    return `${baseOrigin}/${href}`;
  };

  const seen = new Set<string>();
  const rows: Record<string, string>[] = [];

  // ---- Strategy 1: JSON-LD schema.org ----
  const ARTICLE_TYPES = new Set([
    "Article", "BlogPosting", "NewsArticle", "TechArticle", "ScholarlyArticle", "Report",
  ]);
  const flattenJsonLdNodes = (node: unknown): unknown[] => {
    const out: unknown[] = [];
    const visit = (n: unknown): void => {
      if (!n) return;
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (typeof n !== "object") return;
      const obj = n as Record<string, unknown>;
      out.push(obj);
      if (Array.isArray(obj["@graph"])) (obj["@graph"] as unknown[]).forEach(visit);
      if (Array.isArray(obj.itemListElement)) (obj.itemListElement as unknown[]).forEach(visit);
      if (obj.item && typeof obj.item === "object") visit(obj.item);
    };
    visit(node);
    return out;
  };
  const nodeType = (n: Record<string, unknown>): string[] => {
    const t = n["@type"];
    if (typeof t === "string") return [t];
    if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
    return [];
  };
  const asStringField = (n: Record<string, unknown>, ...keys: string[]): string => {
    for (const k of keys) {
      const v = n[k];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    return "";
  };
  const authorName = (n: Record<string, unknown>): string => {
    const a = n.author;
    if (typeof a === "string") return a.trim();
    if (a && typeof a === "object" && !Array.isArray(a)) {
      const name = (a as Record<string, unknown>).name;
      if (typeof name === "string") return name.trim();
    }
    if (Array.isArray(a)) {
      const first = a[0];
      if (typeof first === "string") return first.trim();
      if (first && typeof first === "object") {
        const name = (first as Record<string, unknown>).name;
        if (typeof name === "string") return name.trim();
      }
    }
    return "";
  };

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw || raw.length > 200_000) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    for (const node of flattenJsonLdNodes(parsed)) {
      if (!node || typeof node !== "object") continue;
      const obj = node as Record<string, unknown>;
      const types = nodeType(obj);
      if (!types.some((t) => ARTICLE_TYPES.has(t))) continue;
      const title = asStringField(obj, "headline", "name");
      const url = resolveHref(asStringField(obj, "url", "mainEntityOfPage", "@id"));
      if (!title || title.length < 6) continue;
      if (!url) continue;
      const canonicalKey = url.split("?")[0];
      if (seen.has(canonicalKey)) continue;
      const description = asStringField(obj, "description", "articleBody", "abstract");
      const author = authorName(obj);
      const date = asStringField(obj, "datePublished", "dateModified", "dateCreated");
      const row: Record<string, string> = { title, url, link: url };
      if (description && description !== title) row.description = description.slice(0, 400);
      if (author && author.length < 120) row.author = author;
      if (date) row.date = date;
      rows.push(row);
      seen.add(canonicalKey);
    }
  });

  // ---- Strategy 2: HTML5 semantic <article> elements with title-linked heading ----
  // Triggers when JSON-LD is absent or sparse. Site-agnostic: relies on the
  // HTML5 spec — `<article>` for "self-contained composition that is, in
  // principle, independently distributable or reusable, e.g. a forum post or
  // a magazine or newspaper article or a blog entry".
  if (rows.length < 2) {
    $("article, [role='article']").each((_, el) => {
      const $el = $(el);
      const titleLink = $el.find("h1 a[href], h2 a[href], h3 a[href]").filter((__, a) => {
        const href = ($(a).attr("href") ?? "").split("?")[0];
        if (!href) return false;
        // Reject obvious chrome/auth/nav links by path-shape, not by domain.
        if (/^\/(?:signin|login|enter|signup|register|settings|search|tags|new|notifications|about|contact|terms|privacy)\b/i.test(href)) return false;
        return true;
      }).first();
      const href = (titleLink.attr("href") ?? "").split("?")[0];
      const title = cleanText(titleLink.text());
      if (!href || !title || title.length < 6) return;
      const resolved = resolveHref(href);
      const canonicalKey = resolved.split("?")[0];
      if (seen.has(canonicalKey)) return;
      const description = cleanText(
        $el.find("p, [class*='snippet'], [class*='excerpt'], [class*='summary']").first().text()
      );
      const author = cleanText(
        $el.find("[rel='author'], [itemprop='author'], [class*='author'], [class*='byline']").first().text()
      );
      const date = cleanText(
        $el.find("time[datetime]").first().attr("datetime") ||
        $el.find("time").first().text() || ""
      );
      const tags = $el.find("a[href*='/t/'], a[href*='/tag/'], a[href*='/tags/'], a[rel='tag']")
        .map((__, a) => cleanText($(a).text()).replace(/^#/, ""))
        .get()
        .filter(Boolean)
        .slice(0, 8);
      const row: Record<string, string> = { title, url: resolved, link: href };
      if (description && description !== title) row.description = description;
      if (author && author.length < 120) row.author = author;
      if (date) row.date = date;
      if (tags.length > 0) row.tags = tags.join(", ");
      rows.push(row);
      seen.add(canonicalKey);
    });
  }

  return rows.length >= 1
    ? [{ type: "repeated-elements", data: rows.slice(0, 20), element_count: rows.length }]
    : [];
}

function extractDefinitionSpecial(html: string, intent: string): ExtractedStructure[] {
  const intentLower = intent.toLowerCase();
  if (!/(definition|dictionary|meaning)/.test(intentLower)) return [];
  const $ = cheerio.load(html);
  const root = $("main, article, [role='main'], .entry-body, .di-body").first();
  const scope = root.length > 0 ? root : $("body");
  const term = cleanText(scope.find("h1").first().text()) || cleanText($("h1").first().text());
  let definition = cleanText(
    scope.find("dd, [class*='def'], [class*='meaning'], [class*='definition']").first().text(),
  );
  let normalizedTerm = term;
  if ((!normalizedTerm || !definition || definition.length < 10)) {
    const ogTitle = cleanText($('meta[property="og:title"]').attr("content") ?? "");
    const metaDescription = cleanText($('meta[name="description"]').attr("content") ?? $('meta[itemprop="headline"]').attr("content") ?? "");
    const canonical = cleanText($('link[rel="canonical"]').attr("href") ?? "");
    if (!normalizedTerm) {
      normalizedTerm = ogTitle
        || canonical.split("/").filter(Boolean).pop()?.replace(/[-_]+/g, " ")
        || "";
    }
    if (!definition && metaDescription) {
      definition = metaDescription
        .replace(/^[A-Z0-9 _-]+\s+definition:\s*/i, "")
        .replace(/\s*Learn more\.?$/i, "")
        .replace(/&hellip;/g, "...")
        .trim();
    }
  }
  if (!normalizedTerm || !definition || definition.length < 10) return [];
  return [{
    type: "key-value",
    data: {
      term: normalizedTerm,
      title: normalizedTerm,
      definition,
    },
    element_count: 1,
  }];
}

function extractPackageDetailSpecial(html: string, intent: string): ExtractedStructure[] {
  const intentLower = intent.toLowerCase();
  if (!/\b(package|packages|npm|pypi|crate|gem)\b/.test(intentLower)) return [];
  if (/\b(search|find|list|browse|discover)\b/.test(intentLower)) return [];
  const $ = cheerio.load(html);
  const canonical = cleanText($('link[rel="canonical"]').attr("href") ?? $('meta[property="og:url"]').attr("content") ?? "");
  const rawTitle = cleanText(
    $("h1").first().text()
    || $('meta[property="og:title"]').attr("content")
    || $('meta[name="twitter:title"]').attr("content")
    || $("title").first().text()
  );
  const description = cleanText(
    $('meta[name="description"]').attr("content")
    || $('meta[property="og:description"]').attr("content")
    || $('meta[name="twitter:description"]').attr("content")
    || $("main p, article p").map((_, el) => cleanText($(el).text())).get().find((value) => value.length >= 20 && value.length <= 600)
    || ""
  );
  const pathName = (() => {
    try {
      const u = new URL(canonical || "https://example.com/");
      const match = u.pathname.match(/\/(?:package|project|crates|gems)\/([^/]+)/i);
      return match ? decodeURIComponent(match[1]) : "";
    } catch {
      return "";
    }
  })();
  const nameFromTitle = rawTitle
    .replace(/\s*[-·|]\s*(npm|PyPI|crates\.io|RubyGems\.org).*$/i, "")
    .replace(/^Project description\s*/i, "")
    .trim();
  const name = cleanText(
    $(".package-header__name, .package-snippet__name, [class*='package'][class*='name']").first().text()
    || pathName
    || nameFromTitle
  );
  if (!name || (!description && !canonical)) return [];

  const versionText = cleanText(
    $('[class*="version"], [data-testid*="version"]').first().text()
    || $("main").text().match(/\b(?:Version|Latest version)\s+([0-9][^\s,;)]*)/i)?.[1]
    || ""
  );
  const row: Record<string, unknown> = {
    name,
    title: rawTitle || name,
    ...(description ? { description, summary: description } : {}),
    ...(versionText && versionText.length < 80 ? { version: versionText.replace(/^Version\s+/i, "") } : {}),
    ...(canonical ? { url: canonical } : {}),
  };
  return [{ type: "key-value", data: row, element_count: 1 }];
}

// ---------------------------------------------------------------------------
// extractScholarlyArticleSpecial — generic primitive for scholarly papers
// ---------------------------------------------------------------------------
//
// Replaces the prior per-host `extractArxivAbstractSpecial` (deleted
// 2026-05-20) per CLAUDE.md ranker philosophy: heuristics OUT, universal-
// web-standards primitives IN. No `arxiv.org` literal, no `.abstract` /
// `.authors` / `.title` arxiv-specific CSS classes. Same code path now
// handles arxiv AND any standards-conformant scholarly publisher:
//
//   Strategy 1 (Highwire citation_* meta tags):
//     <meta name="citation_title|citation_author|citation_abstract|
//     citation_publication_date|citation_doi|citation_pdf_url"> — the
//     Highwire Press standard emitted by arxiv, biorxiv, medrxiv, ACS,
//     IEEE, Springer, PLOS, JSTOR, Wiley, PubMed Central, and the
//     publisher pages that Google Scholar indexes. Multiple
//     `citation_author` tags are collected into the authors array.
//
//   Strategy 2 (JSON-LD schema.org/ScholarlyArticle):
//     <script type="application/ld+json"> blocks with @type in
//     {ScholarlyArticle, Article, Report} carrying an `abstract` field.
//     Surfaces headline, abstract, author[].name, datePublished, url.
//
// Returns [] when neither strategy yields a non-empty title + a
// substantive (>=40 char) abstract, letting downstream generic
// extractors (article-body, SPA, metadata fallback) handle the page.
function extractScholarlyArticleSpecial(html: string, intent: string): ExtractedStructure[] {
  const intentLower = intent.toLowerCase();
  if (!/\b(arxiv|abstract|paper|preprint|publication|article|study|research)\b/.test(intentLower)) return [];
  // Cheap pre-filter: only proceed if the HTML carries at least one
  // scholarly standard marker (Highwire citation_* meta OR JSON-LD
  // ScholarlyArticle). Avoids parsing every page on the web.
  if (!/<meta[^>]+name=["']citation_(title|author|abstract|doi)/i.test(html)
      && !/"@type"\s*:\s*"ScholarlyArticle"/i.test(html)) return [];
  const $ = cheerio.load(html);

  // ---- Strategy 1: Highwire citation_* meta tags ----
  const highwireGet = (name: string): string => {
    const v = $(`meta[name="${name}"]`).attr("content")
      ?? $(`meta[name="${name.toUpperCase()}"]`).attr("content")
      ?? "";
    return cleanText(v);
  };
  const highwireGetAll = (name: string): string[] => {
    const out: string[] = [];
    $(`meta[name="${name}"], meta[name="${name.toUpperCase()}"]`).each((_, el) => {
      const v = cleanText($(el).attr("content") ?? "");
      if (v) out.push(v);
    });
    return out;
  };

  const hwTitle = highwireGet("citation_title");
  const hwAbstract = highwireGet("citation_abstract");
  const hwAuthors = highwireGetAll("citation_author").slice(0, 20);
  const hwDate = highwireGet("citation_publication_date") || highwireGet("citation_date");
  const hwDoi = highwireGet("citation_doi");
  const hwPdf = highwireGet("citation_pdf_url");

  if (hwTitle && hwAbstract.length >= 40) {
    const canonical = cleanText(
      $('link[rel="canonical"]').attr("href")
        ?? $('meta[property="og:url"]').attr("content")
        ?? "",
    );
    const data: Record<string, unknown> = {
      title: hwTitle,
      abstract: hwAbstract,
      summary: hwAbstract,
    };
    if (hwAuthors.length > 0) data.authors = hwAuthors;
    if (hwDate) data.date = hwDate;
    if (hwDoi) data.doi = hwDoi;
    if (hwPdf) data.pdf_url = hwPdf;
    if (canonical) data.url = canonical;
    return [{ type: "key-value", data, element_count: 1 }];
  }

  // ---- Strategy 2: JSON-LD schema.org/ScholarlyArticle ----
  const SCHOLARLY_TYPES = new Set(["ScholarlyArticle", "Article", "Report"]);
  const flattenJsonLdNodes = (node: unknown): unknown[] => {
    const out: unknown[] = [];
    const visit = (n: unknown): void => {
      if (!n) return;
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (typeof n !== "object") return;
      const obj = n as Record<string, unknown>;
      out.push(obj);
      if (Array.isArray(obj["@graph"])) (obj["@graph"] as unknown[]).forEach(visit);
      if (obj.mainEntity && typeof obj.mainEntity === "object") visit(obj.mainEntity);
    };
    visit(node);
    return out;
  };
  const nodeType = (n: Record<string, unknown>): string[] => {
    const t = n["@type"];
    if (typeof t === "string") return [t];
    if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
    return [];
  };
  const asStringField = (n: Record<string, unknown>, ...keys: string[]): string => {
    for (const k of keys) {
      const v = n[k];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    return "";
  };
  const authorNames = (n: Record<string, unknown>): string[] => {
    const a = n.author;
    const collect = (x: unknown): string => {
      if (typeof x === "string") return x.trim();
      if (x && typeof x === "object" && !Array.isArray(x)) {
        const name = (x as Record<string, unknown>).name;
        if (typeof name === "string") return name.trim();
      }
      return "";
    };
    if (Array.isArray(a)) return a.map(collect).filter(Boolean).slice(0, 20);
    const one = collect(a);
    return one ? [one] : [];
  };

  let jsonLdResult: ExtractedStructure | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (jsonLdResult) return;
    const raw = $(el).contents().text();
    if (!raw || raw.length > 200_000) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    for (const node of flattenJsonLdNodes(parsed)) {
      if (jsonLdResult) break;
      if (!node || typeof node !== "object") continue;
      const obj = node as Record<string, unknown>;
      const types = nodeType(obj);
      if (!types.some((t) => SCHOLARLY_TYPES.has(t))) continue;
      const title = asStringField(obj, "headline", "name");
      const abstract = asStringField(obj, "abstract", "description");
      if (!title || abstract.length < 40) continue;
      const authors = authorNames(obj);
      const date = asStringField(obj, "datePublished", "dateCreated");
      const url = asStringField(obj, "url", "mainEntityOfPage", "@id");
      const data: Record<string, unknown> = {
        title,
        abstract,
        summary: abstract,
      };
      if (authors.length > 0) data.authors = authors;
      if (date) data.date = date;
      if (url) data.url = url;
      jsonLdResult = { type: "key-value", data, element_count: 1 };
      break;
    }
  });
  if (jsonLdResult) return [jsonLdResult];

  return [];
}

/**
 * Extract article body content for read-style intents (wikipedia article, blog post,
 * reference page). Targets `<main>`, `<article>`, or `#mw-content-text` and returns
 * a structured doc with title + summary + sections rather than the link-list noise
 * that the generic DOM walker would surface.
 *
 * Caught via harness/recursive against en.wikipedia.org/wiki/Quantum_computing —
 * the generic extractor was returning github.com reference links instead of the
 * article body.
 */
function extractArticleBodySpecial(html: string, intent: string): ExtractedStructure[] {
  const intentLower = intent.toLowerCase();
  const articleIntent = /(wikipedia|article|wiki page|page on|read|content of|body of|summary of|about )/i.test(intentLower);
  // Also fire when the page is wikipedia-shaped even if intent doesn't say so —
  // mw-content-text and mw-parser-output are unmistakable.
  const looksWikipedia = /id="mw-content-text"|class="mw-parser-output"/i.test(html);
  if (!articleIntent && !looksWikipedia) return [];
  const $ = cheerio.load(html);
  // Wikipedia: #mw-content-text > .mw-parser-output. Generic: <article> or <main>.
  // Skip <main> on wikipedia because it's an outer shell that includes nav.
  const root = looksWikipedia
    ? $(".mw-parser-output").first()
    : $("article, [role='article']").first().length > 0
      ? $("article, [role='article']").first()
      : $("main").first();
  if (!root.length) return [];
  const title = cleanText($("h1").first().text());
  if (!title) return [];

  // Strip noise: edit links, references-list, navboxes, infobox tables, citations.
  root.find(".mw-editsection, .reference, .references, .navbox, .infobox, .reflist, .hatnote, .ambox, .toc, sup.reference, style, script, .sidebar").remove();

  // Summary: first <p> with substantive text.
  let summary = "";
  root.find("> p, .mw-parser-output > p, p").each((_, el) => {
    if (summary.length >= 80) return false;
    const t = cleanText($(el).text());
    if (t.length >= 80) summary = t;
    return undefined;
  });

  // Sections: collect h2/h3 + following paragraphs into an array.
  const sections: Array<{ heading: string; text: string }> = [];
  let current: { heading: string; parts: string[] } | null = null;
  root.find("h2, h3, p, li").each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase?.() ?? (el as { name?: string }).name ?? "";
    const txt = cleanText($(el).text());
    if (!txt) return;
    if (tag === "h2" || tag === "h3") {
      if (current && current.parts.length) sections.push({ heading: current.heading, text: current.parts.join("\n").slice(0, 1500) });
      // Skip stub headings like "References", "External links", "See also".
      if (/^(references?|external links?|see also|notes?|further reading|bibliography|sources?)$/i.test(txt)) {
        current = null;
      } else {
        current = { heading: txt, parts: [] };
      }
    } else if (current && (tag === "p" || tag === "li") && txt.length > 20) {
      if (current.parts.join("\n").length < 1500) current.parts.push(txt);
    }
  });
  if (current && current.parts.length) sections.push({ heading: current.heading, text: current.parts.join("\n").slice(0, 1500) });

  if (!summary && sections.length === 0) return [];

  return [{
    type: "article",
    data: {
      title,
      summary: summary || undefined,
      sections: sections.slice(0, 12),
      section_count: sections.length,
    },
    element_count: 1 + sections.length,
  }];
}

function extractCourseSearchSpecial(html: string, intent: string): ExtractedStructure[] {
  if (!/\b(course|courses)\b/i.test(intent)) return [];
  if (!/ProductCard|CommonCard-titleLink|RatingStat|partnerNames/i.test(html)) return [];
  const $ = cheerio.load(html);
  const rows: Record<string, string>[] = [];
  const seen = new Set<string>();

  $(".cds-ProductCard-card, .cds-ProductCard, [class*='ProductCard-card'], [class*='ProductCard']").each((_, el) => {
    const $el = $(el);
    const fields = extractCardFields($, $el);
    const title = fields.title?.trim();
    const url = (fields.url ?? fields.link ?? "").trim();
    if (!title || !url || title === "All Results") return;
    const stable = `${title}|${url}`;
    if (seen.has(stable)) return;
    if (!fields.rating && !fields.partner && !fields.description) return;
    rows.push(fields);
    seen.add(stable);
  });

  return rows.length >= 2
    ? [{ type: "repeated-elements", data: rows.slice(0, 20), element_count: rows.length, selector: ".cds-ProductCard-card" }]
    : [];
}

function extractTrendSpecial(html: string, intent: string): ExtractedStructure[] {
  const intentLower = intent.toLowerCase();
  if (!/(trend|trending|topic|topics|hashtag|hashtags)/.test(intentLower)) return [];
  const $ = cheerio.load(html);
  const roots = $("main, [role='main'], section");
  const scope = roots.length > 0 ? roots.first() : $("body");
  const seen = new Set<string>();
  const topics: Record<string, string>[] = [];

  scope.find("a[href]").each((_, el) => {
    const $a = $(el);
    const href = ($a.attr("href") ?? "").trim();
    const name = cleanText($a.text());
    if (!href || !name || name.length > 80 || name.length < 2) return;
    if (/^(home|explore|notifications|messages|lists|profile|more|show more|settings|terms|privacy)$/i.test(name)) return;
    const nearby = cleanText($a.closest("div, li, article, section").text());
    const trendish = name.startsWith("#")
      || /hashtag|trend|trending|topic/i.test(nearby)
      || /search\?q=|explore|hashtag/i.test(href);
    if (!trendish) return;
    const key = `${name}|${href.split("?")[0]}`;
    if (seen.has(key)) return;
    topics.push({ name, url: href });
    seen.add(key);
  });

  return topics.length >= 2 ? [{ type: "repeated-elements", data: topics.slice(0, 20), element_count: topics.length }] : [];
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

  // --- Itemlist tables (HN-style: tr.athing with story rows) ---
  $("table").each((_, table) => {
    const $table = $(table);
    const athings = $table.find("tr.athing");
    if (athings.length >= 3) {
      const items: Record<string, string>[] = [];
      athings.each((_, tr) => {
        const $tr = $(tr);
        const item: Record<string, string> = {};
        const titleLink = $tr.find("span.titleline > a, td.title > span > a, td.title a.storylink").first();
        if (titleLink.length) {
          item.title = titleLink.text().trim();
          item.link = titleLink.attr("href") || "";
        }
        const rank = $tr.find("span.rank").text().trim().replace(".", "");
        if (rank) item.rank = rank;
        const $sub = $tr.next("tr");
        const score = $sub.find("span.score").text().trim();
        if (score) item.score = score;
        const age = $sub.find("span.age").text().trim();
        if (age) item.age = age;
        const author = $sub.find("a.hnuser").text().trim();
        if (author) item.author = author;
        const commentsLink = $sub.find("a").last().text().trim();
        if (commentsLink && commentsLink.includes("comment")) item.comments = commentsLink;
        if (item.title) items.push(item);
      });
      if (items.length >= 3) {
        results.push({ type: "itemlist", data: items, element_count: items.length });
        $table.remove();
        return;
      }
    }
  });

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

  // --- Single-record detail pages ---
  const detailResults = detectDetailPatterns($);
  results.push(...detailResults);

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
        selector: buildReplaySelector($(elements[0])) ?? selector,
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

function hasDetailFieldShape(fields: Record<string, string>): boolean {
  if (!fields.title && !fields.name && !fields.term) return false;
  return !!(
    fields.description ||
    fields.definition ||
    fields.price ||
    fields.rating ||
    fields.author ||
    fields.url ||
    fields.link ||
    fields.score ||
    fields.image
  );
}

function detectDetailPatterns($: cheerio.CheerioAPI): ExtractedStructure[] {
  const results: ExtractedStructure[] = [];
  const seen = new Set<string>();

  for (const selector of [
    "main",
    "article",
    "[role='main']",
    "[class*='detail']",
    "[class*='details']",
    "[class*='product']",
    "[class*='listing']",
    "[class*='profile']",
    "[class*='content']",
  ]) {
    $(selector).each((_, el) => {
      const $el = $(el);
      const signature = `${selector}|${getElementSignature($, $el)}`;
      if (seen.has(signature)) return;
      seen.add(signature);
      if ($el.text().trim().length < 20) return;
      const fields = extractCardFields($, $el);
      if (Object.keys(fields).length < 2) return;
      if (!hasDetailFieldShape(fields)) return;
      results.push({
        type: "key-value",
        data: fields,
        element_count: 1,
        selector: buildReplaySelector($el) ?? selector,
      });
    });
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
          selector: buildReplaySelector($(elements[0])),
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
  if (!fields["message"] && fields["heading_1"] && fields["heading_1"].length > 10) {
    fields["message"] = fields["heading_1"];
  }

  // Fallback title: strong/bold text or [class*='name']
  if (!fields["title"]) {
    const strong = $el.find("strong, b, [class*='name']").first();
    if (strong.length) {
      const text = strong.text().trim();
      if (text && text.length < 200) fields["title"] = text;
    }
  }

  // Extract links — pick the most informative one as the primary `link`/`url`.
  //
  // Aggregator/forum sites (lobste.rs, HN, reddit) put a vote/login link FIRST
  // inside each item card, then the actual story link, then byline/comment links.
  // Naively taking links[0] gives every card the same `/login` href, which the
  // diversity check correctly rejects as nav chrome.
  //
  // Heuristic, in order of preference:
  //   1. Microformats hint: <a class="u-url"> (story link in h-entry / h-cite)
  //   2. External absolute URL (different host than the page being aggregated)
  //   3. First non-interaction link (skip /login, /signin, /upvote, /vote, /flag)
  //   4. Fallback to links[0]
  const linkCandidates: Array<{ href: string; cls: string; isExternal: boolean }> = [];
  $el.find("a[href]").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
    const cls = $a.attr("class") ?? "";
    const isExternal = /^https?:\/\//i.test(href);
    linkCandidates.push({ href, cls, isExternal });
  });
  if (linkCandidates.length > 0) {
    const INTERACTION = /^\/(login|signin|sign-in|sign_up|signup|register|upvote|downvote|vote|flag|hide|save|reply|comment)\b/i;
    const uUrl = linkCandidates.find((l) => /\bu-url\b/.test(l.cls));
    const external = linkCandidates.find((l) => l.isExternal);
    const nonInteraction = linkCandidates.find((l) => !INTERACTION.test(l.href));
    const chosen = (uUrl ?? external ?? nonInteraction ?? linkCandidates[0]).href;
    fields["link"] = chosen;
    fields["url"] = chosen;
  }
  const links = linkCandidates.map((l) => l.href);

  // Fallback title from link text — prefer the text of the chosen story link
  // (set above as fields["link"]) over the first <a>, which on aggregator
  // sites is usually a numeric vote count or a single-character icon.
  if (!fields["title"] && links.length > 0) {
    const candidates: string[] = [];
    if (fields["link"]) {
      $el.find(`a[href="${fields["link"].replace(/"/g, '\\"')}"]`).each((_, a) => {
        const text = $(a).text().trim();
        if (text) candidates.push(text);
      });
    }
    candidates.push($el.find("a").first().text().trim());
    for (const linkText of candidates) {
      // Reject URL-shaped text — when the anchor's text is its href (the
      // common reddit / aggregator / link-list shape where the post title
      // wasn't extracted), the link text duplicates the URL and carries
      // no caption. Skip so the next candidate (or og:title fallback)
      // can take over.
      if (linkText && linkText.length > 2 && linkText.length < 200 && !/^(read|more|view|see|click)/i.test(linkText) && !/^\d+$/.test(linkText) && !/^https?:\/\//i.test(linkText) && !/^\/\//.test(linkText)) {
        fields["title"] = linkText;
        break;
      }
    }
  }

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

  // Generic summary/excerpt containers often hold the useful body text for docs/questions/cards.
  if (!fields["description"]) {
    $el.find("[class*='summary'], [class*='excerpt'], [class*='description'], [class*='desc'], [class*='snippet']").each((_, node) => {
      if (fields["description"]) return;
      const text = $(node).text().trim();
      if (text && text.length > 10 && text.length < 500) fields["description"] = text;
    });
  }

  // Alerts / success pages often carry the user-facing payload in strong text or flash-like containers.
  if (!fields["message"]) {
    $el.find("[role='alert'], .flash, .alert, [class*='message'], [class*='flash'], [class*='alert'], p strong, p b").each((_, node) => {
      if (fields["message"]) return;
      const text = $(node).text().trim();
      if (text && text.length > 5 && text.length < 500 && text !== fields["title"]) {
        fields["message"] = text;
      }
    });
  }
  if (!fields["message"] && fields["description"] && /congratulations|successfully|logged in|logged out|welcome|error|invalid|warning|flash|alert/i.test(fields["description"])) {
    fields["message"] = fields["description"];
  }

  // Extract price-like patterns — use the most specific (deepest) match
  const priceEl = $el.find(".price_color, [class*='price']:not(:has([class*='price'])), .price, .cost, .amount").first();
  if (priceEl.length > 0) {
    // Get only direct text content, not nested children
    const priceText = priceEl.contents().filter((_, node) => node.type === "text" || (node as any).tagName === "span")
      .text().trim();
    if (priceText) fields["price"] = priceText;
  }

  const scoreEl = $el.find("[class*='vote'], [class*='score'], [data-score]").first();
  if (scoreEl.length > 0) {
    const scoreText = scoreEl.text().trim() || scoreEl.attr("data-score")?.trim();
    if (scoreText && scoreText.length < 80) fields["score"] = scoreText;
  }

  const answersEl = $el.find("[class*='answer'], [data-answercount]").first();
  if (answersEl.length > 0) {
    const answersText = answersEl.text().trim() || answersEl.attr("data-answercount")?.trim();
    if (answersText && answersText.length < 80) fields["answer_count"] = answersText;
  }

  const ratingEl = $el.find("[class*='rating'], [aria-label*='rating'], [aria-label*='Rating'], [aria-valuenow], [aria-valuetext], [data-rating]").first();
  if (ratingEl.length > 0) {
    const ratingProbe = ratingEl.find("[aria-valuenow], [aria-valuetext], [aria-label*='rating'], [aria-label*='Rating']").first();
    const ratingText = ratingProbe.attr("aria-valuenow")?.trim()
      || ratingProbe.attr("aria-valuetext")?.trim()
      || ratingProbe.attr("aria-label")?.trim()
      || ratingEl.attr("aria-valuenow")?.trim()
      || ratingEl.attr("aria-valuetext")?.trim()
      || ratingEl.attr("aria-label")?.trim()
      || ratingEl.attr("data-rating")?.trim()
      || ratingProbe.text().trim()
      || ratingEl.text().trim();
    const numeric = ratingText?.match(/\b([0-5](?:\.\d)?)\b/)?.[1];
    if (numeric) fields["rating"] = numeric;
    else if (ratingText && ratingText.length < 80 && !/^rating$/i.test(ratingText)) fields["rating"] = ratingText;
  }

  const authorEl = $el.find("[class*='author'], [class*='byline'], [class*='user'], [rel='author']").first();
  if (authorEl.length > 0) {
    const authorText = authorEl.text().trim();
    if (authorText && authorText.length < 120) fields["author"] = authorText;
  }

  const partnerEl = $el.find("[class*='partnerName'], [class*='partnerNames'], [class*='partner']").first();
  if (partnerEl.length > 0) {
    const partnerText = partnerEl.text().trim();
    if (partnerText && partnerText.length < 160) fields["partner"] = partnerText;
  }

  const definitionEl = $el.find("dd, [class*='def'], [class*='meaning'], [class*='definition']").first();
  if (definitionEl.length > 0) {
    const definitionText = definitionEl.text().trim();
    if (definitionText && definitionText.length > 10 && definitionText.length < 600) fields["definition"] = definitionText;
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

function scoreSemanticFit(structure: ExtractedStructure, intent: string): number {
  const assessment = assessIntentResult(structure.data, intent);
  if (assessment.verdict === "pass") return 140;
  if (assessment.verdict === "fail") return -140;
  return 0;
}

function scoreSparseLinkList(structure: ExtractedStructure): number {
  if (structure.type !== "repeated-elements" || !Array.isArray(structure.data)) return 0;
  const items = structure.data as Array<Record<string, unknown>>;
  if (items.length < 4) return 0;
  const sparse = items.filter((item) => {
    const keys = Object.keys(item);
    if (keys.length > 2) return false;
    const title = typeof item.title === "string" ? item.title : typeof item.name === "string" ? item.name : "";
    const link = typeof item.link === "string" ? item.link : typeof item.url === "string" ? item.url : "";
    return !!title && !!link && title.length <= 32;
  }).length;
  return sparse / items.length >= 0.7 ? -80 : 0;
}

function scoreFieldRichness(structure: ExtractedStructure): number {
  if (structure.type !== "repeated-elements" || !Array.isArray(structure.data)) return 0;
  const items = structure.data as Array<Record<string, unknown>>;
  if (items.length === 0) return 0;
  const avgFields = items.reduce((sum, item) => sum + Object.keys(item).length, 0) / items.length;
  if (avgFields >= 4) return 14;
  if (avgFields >= 3) return 8;
  return 0;
}

// W3: config-shape demotion. Some captured pages place i18n bundles,
// theme objects, RSC bootstrap chunks, and stylesheet/script metadata
// in __NEXT_DATA__ or similar containers. The SPA extractor pulls them
// out as if they were the page's data, and the scoring loop ranks them
// above real DOM content because they have many "entries". The fix:
// detect these recognisable junk shapes and apply a heavy demotion so
// real-data structures win the pick. Substrate-faithful: never invent
// a verdict, only surface what's declared. The detector returns true
// only on structural shape; it never reads intent or page domain.
//
// Affected bench probes from .bench-gate/20260519T203955Z: 011 dev.to,
// 018/019 openlibrary, 031 priceline, 052 ticketmaster (translations +
// theme.gradients.mrBlueSky), 059 target (spa-nextjs preload struct),
// 066 vinted (RSC link/script chunks).
const CONFIG_TOP_LEVEL_KEYS = new Set([
  "translations",
  "translation",
  "i18n",
  "messages",
  "locales",
  "theme",
  "gradients",
  "tokens",
  "designTokens",
  "designSystem",
]);
const CONFIG_CHUNK_VALUE_KEYS = new Set([
  "href",
  "src",
  "precedence",
  "nonce",
  "crossOrigin",
  "async",
  "defer",
  "rel",
  "module",
  "integrity",
]);
function looksLikeConfigShape(data: unknown): boolean {
  if (data == null) return false;
  // RSC bootstrap: an array where every entry is the React-Server-
  // Components tuple shape `["$", "<tag>", "<id>", {<config>}]`. Next.js
  // serialises script/link chunks this way.
  if (Array.isArray(data) && data.length >= 3) {
    const allRscTuples = data.every((entry) => {
      if (!Array.isArray(entry) || entry.length < 4) return false;
      const [marker, tag, , props] = entry as unknown[];
      return (
        marker === "$" &&
        typeof tag === "string" &&
        props != null &&
        typeof props === "object" &&
        !Array.isArray(props)
      );
    });
    if (allRscTuples) return true;
    // Same array but as a list of stylesheet/script objects (not the
    // tuple form): every entry is an object with only CONFIG_CHUNK keys.
    const allChunkObjects = data.every((entry) => {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) return false;
      const keys = Object.keys(entry as Record<string, unknown>);
      if (keys.length === 0) return false;
      return keys.every((k) => CONFIG_CHUNK_VALUE_KEYS.has(k));
    });
    if (allChunkObjects) return true;
  }
  // i18n / theme: an object with a known top-level config token (literal
  // OR as a SUBSTRING of the key — catches `globalTranslations`,
  // `appMessages`, `themeTokens`, `i18nResources`, `localeBundles`, etc.
  // without per-variant maintenance). We do NOT use intent or domain,
  // only the structural shape of the key name + the absence of sibling
  // data keys.
  if (typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const topKeys = Object.keys(obj);
    if (topKeys.length === 0) return false;
    const looksLikeConfigKey = (k: string): boolean => {
      const lower = k.toLowerCase();
      if (CONFIG_TOP_LEVEL_KEYS.has(lower)) return true;
      // Substring match against the canonical i18n/theme tokens. The
      // literal set above is also lowercase so the membership check
      // doubles as the seed for the substring rule.
      for (const token of CONFIG_TOP_LEVEL_KEYS) {
        if (lower.includes(token)) return true;
      }
      return false;
    };
    const hasConfigTop = topKeys.some((k) => looksLikeConfigKey(k));
    if (!hasConfigTop) return false;
    // Confirm the config bucket is the dominant payload, not a sibling
    // of real data. A page with `{products: [...], translations: {...}}`
    // should NOT trip; the products array would be the real signal and
    // the parent object as a whole still carries data.
    const configKeyCount = topKeys.filter((k) => looksLikeConfigKey(k)).length;
    const dataKeyCount = topKeys.length - configKeyCount;
    // If the object is ONLY config buckets (no sibling data keys), it
    // is config-shape. If there are sibling data keys, leave it alone.
    return dataKeyCount === 0;
  }
  return false;
}

function scoreConfigShapeDemotion(structure: ExtractedStructure): number {
  return looksLikeConfigShape(structure.data) ? -200 : 0;
}

// W3-followup: degenerate-row dominance check. A row is "collapsed" when
// it has multiple keys but every non-empty value stringifies to the same
// trimmed string. The array as a whole is degenerate when >=80% of its
// well-formed rows collapse this way.
//
// The original predicate required EVERY row to collapse (Array.every),
// which silently passed when even one row in the array had distinct
// values. Live regression from .bench-gate/20260521T010031Z/009 pypi:
// the cheerio selector matched BOTH the 198-row release-date table AND
// the 2 file-download anchors (`{link,url,title,description,meta,info}`
// where link != title != description), merged into one 200-row array.
// 2/200 = 1% non-degenerate, but `every` failed and the demotion never
// fired. The dates won by sheer volume of word matches.
//
// Threshold 0.8: real card lists (title+url+description, name+price,
// version+date+type) have 0% collapse and survive untouched. Pypi pure
// case has 100% collapse. Pypi heterogeneous case has ~99% collapse.
// 0.8 cleanly separates "dominantly degenerate" from "legitimately
// mixed". Substrate-faithful: shape-only, no domain or intent matching.
function looksLikeDegenerateRowArray(data: unknown): boolean {
  if (!Array.isArray(data)) return false;
  if (data.length < 4) return false;
  const rows = data as unknown[];
  let wellFormed = 0;
  let collapsed = 0;
  for (const row of rows) {
    if (row == null || typeof row !== "object" || Array.isArray(row)) continue;
    const values = Object.values(row as Record<string, unknown>).filter((v) => v != null && v !== "");
    if (values.length < 2) continue;
    wellFormed++;
    const stringified = values.map((v) => String(v).trim());
    if (stringified.every((s) => s === stringified[0])) {
      collapsed++;
    }
  }
  if (wellFormed < 4) return false;
  return collapsed / wellFormed >= 0.8;
}

function scoreDegenerateRowDemotion(structure: ExtractedStructure): number {
  if (structure.type !== "repeated-elements") return 0;
  return looksLikeDegenerateRowArray(structure.data) ? -300 : 0;
}

// W3-continuation: duplicate-row chrome demotion. A repeated-elements
// array whose distinct-row-stringify ratio drops below 0.5 carries less
// signal than its row count suggests — more than half the rows are
// duplicates, so the array is chrome (repeated nav button, repeated
// Follow CTA, repeated sidebar facet) not real content. Live regressions
// from .bench-gate/20260520T093742Z:
//   - 011 dev.to/anthropic: 6x identical Follow-CTA rows dominated extraction
//   - 018/019 openlibrary/works: duplicate publisher/language sidebar chips
//
// Substrate-faithful: shape-only, no domain or intent matching.
// Catches the symmetric case the existing two demotions miss:
//   scoreConfigShapeDemotion       -> i18n/RSC bootstrap
//   scoreDegenerateRowDemotion     -> all-collapsed-values inside one row (pypi dates)
//   scoreDuplicateRowDemotion      -> same row repeated across the array (this one)
function looksLikeDuplicateRowArray(data: unknown): boolean {
  if (!Array.isArray(data)) return false;
  if (data.length < 4) return false;
  const rows = data as unknown[];
  const stringified = rows
    .filter((row): row is Record<string, unknown> => row != null && typeof row === "object" && !Array.isArray(row))
    .map((row) => JSON.stringify(row));
  if (stringified.length < 4) return false;
  const unique = new Set(stringified);
  return unique.size / stringified.length < 0.5;
}

function scoreDuplicateRowDemotion(structure: ExtractedStructure): number {
  if (structure.type !== "repeated-elements") return 0;
  return looksLikeDuplicateRowArray(structure.data) ? -250 : 0;
}

// W3-followup: empty-container demotion. A structure where the leaves
// are >=80% empty {} / [] / blank strings is a container shell with no
// payload. Common shape: SPA SSR-renders the Redux/MobX entity store
// with all buckets empty because the data was meant to populate from
// post-mount XHR. Live source from .bench-gate/20260520T093742Z:
//   - 020/021/022 x.com cold: {optimist:[],entities:{broadcasts:{entities:{},
//     errors:{},fetchStatus:{}}, ...}} — 173KB of key names, zero scalars.
//
// Sits beside the existing three:
//   scoreConfigShapeDemotion       -> i18n/RSC bootstrap (-200)
//   scoreDegenerateRowDemotion     -> all-collapsed-values inside one row (-300)
//   scoreDuplicateRowDemotion      -> same row repeated across array (-250)
//   scoreEmptyContainerDemotion    -> all leaves empty containers (-200, NEW)
//
// Substrate-faithful: structural primitive, no per-host registry. Real
// listings have many scalar leaves; chrome / unfilled stores have very
// few. Threshold at 80% empty so a sparse-but-real structure (one real
// scalar plus many empty buckets) survives.
function looksLikeEmptyContainer(data: unknown): boolean {
  if (data == null) return false;
  if (typeof data !== "object") return false;
  let scalars = 0;
  let empties = 0;
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (Array.isArray(node)) {
      if (node.length === 0) { empties++; return; }
      for (const e of node) walk(e);
      return;
    }
    if (typeof node === "object") {
      const keys = Object.keys(node as object);
      if (keys.length === 0) { empties++; return; }
      for (const k of keys) walk((node as Record<string, unknown>)[k]);
      return;
    }
    if (typeof node === "string" && node.trim().length === 0) { empties++; return; }
    scalars++;
  };
  walk(data);
  const total = scalars + empties;
  if (total < 3) return false;
  return empties / total >= 0.8;
}

function scoreEmptyContainerDemotion(structure: ExtractedStructure): number {
  return looksLikeEmptyContainer(structure.data) ? -200 : 0;
}

// Stopwords stripped before computing intent/URL-path overlap with a
// table candidate's headers + cell values. Generic English question
// stems + URL chrome — NOT a per-domain registry.
const INTENT_OVERLAP_STOPWORDS = new Set([
  "search", "find", "list", "get", "fetch", "show", "lookup", "look",
  "view", "browse", "open", "read", "load",
  "for", "the", "a", "an", "in", "of", "to", "on", "at", "by", "with",
  "from", "into", "as", "is", "are", "and", "or", "but",
  "this", "that", "these", "those", "any", "all", "some",
  "www", "com", "org", "net", "io", "co", "ai", "app", "html", "htm",
  "https", "http",
]);

function tokenizeForOverlap(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 3 && !INTENT_OVERLAP_STOPWORDS.has(tok));
}

function intentAndUrlTokens(intent: string, contextUrl?: string): Set<string> {
  const tokens = new Set<string>();
  for (const tok of tokenizeForOverlap(intent)) tokens.add(tok);
  if (contextUrl) {
    try {
      const u = new URL(contextUrl);
      // Path segments + query values carry the user's specific entity (e.g.
      // /nba/ask/lebron-points-per-game-this-season -> lebron, points, game, season).
      for (const tok of tokenizeForOverlap(u.pathname.replace(/[/_-]/g, " "))) tokens.add(tok);
      for (const [, v] of u.searchParams.entries()) {
        for (const tok of tokenizeForOverlap(v)) tokens.add(tok);
      }
    } catch {
      // contextUrl not a parseable URL — treat it as raw text
      for (const tok of tokenizeForOverlap(contextUrl)) tokens.add(tok);
    }
  }
  return tokens;
}

function tokenizeTableCandidate(structure: ExtractedStructure, maxCells = 50): Set<string> {
  const tokens = new Set<string>();
  if (structure.type !== "table" || !Array.isArray(structure.data)) return tokens;
  const rows = structure.data as Array<Record<string, unknown>>;
  if (rows.length === 0) return tokens;
  // Column headers (every row's keys, deduped at the Set layer).
  for (const row of rows) {
    if (row && typeof row === "object") {
      for (const k of Object.keys(row)) {
        for (const tok of tokenizeForOverlap(k)) tokens.add(tok);
      }
    }
  }
  // Cell values, capped at maxCells total to bound CPU on huge tables.
  let cellBudget = maxCells;
  for (const row of rows) {
    if (cellBudget <= 0) break;
    if (!row || typeof row !== "object") continue;
    for (const v of Object.values(row)) {
      if (cellBudget <= 0) break;
      if (typeof v === "string") {
        for (const tok of tokenizeForOverlap(v)) tokens.add(tok);
      }
      cellBudget--;
    }
  }
  return tokens;
}

function tableIntentOverlapRatio(
  structure: ExtractedStructure,
  intentTokens: Set<string>
): number {
  if (intentTokens.size === 0) return 1;
  const tableTokens = tokenizeTableCandidate(structure);
  if (tableTokens.size === 0) return 0;
  let hits = 0;
  for (const tok of intentTokens) if (tableTokens.has(tok)) hits++;
  return hits / intentTokens.size;
}

// Demote a type:"table" candidate when its headers + cell values share
// ZERO tokens with the intent/URL-path AND at least one OTHER table
// candidate on the same page has any overlap. The page has multiple
// tables and one is unrelated chrome (e.g. NBA standings on a per-player
// stats page); the zero-overlap table must lose to the relevant one.
//
// Degenerate single-candidate case: if it's the ONLY table, return 0 so
// the fallback chain (json-ld, metadata, repeating-elements) still has
// a chance and the agent isn't left with nothing.
//
// Equal-overlap case: tied at the same nonzero ratio yields 0 for both
// (no preference between equal candidates).
//
// Generic structural primitive: tokens vs tokens. No per-host, no
// per-intent-string registry.
function scoreTableIntentOverlapDemotion(
  structure: ExtractedStructure,
  intent: string,
  contextUrl: string | undefined,
  allStructures: ExtractedStructure[]
): number {
  if (structure.type !== "table") return 0;
  const intentTokens = intentAndUrlTokens(intent, contextUrl);
  if (intentTokens.size === 0) return 0;
  const tableCandidates = allStructures.filter((s) => s.type === "table");
  if (tableCandidates.length < 2) return 0;
  const selfRatio = tableIntentOverlapRatio(structure, intentTokens);
  if (selfRatio > 0) return 0;
  const anyOtherHasOverlap = tableCandidates.some(
    (other) => other !== structure && tableIntentOverlapRatio(other, intentTokens) > 0
  );
  return anyOtherHasOverlap ? -150 : 0;
}

// ---------------------------------------------------------------------------
// looksLikeSiteMetaJsonLd — site-metadata JSON-LD vs LIST_INTENT gate
// ---------------------------------------------------------------------------
// Live regression from .bench-gate/20260521T010031Z probe 031 priceline:
//   intent: "search hotels in Tokyo" (LIST_INTENT)
//   extracted: spa-initial-state whose data was a schema.org JSON-LD block
//     {"@context":"https://schema.org","@type":["Organization","TravelAgency"],
//      "name":"Priceline","telephone":"...","foundingDate":"...",
//      "hasOfferCatalog":{...corporate-metadata...}}
//
// The page-level Organization / TravelAgency JSON-LD describes the SITE
// ITSELF (corporate identity card), not the hotel listings the user asked
// for. Returning this site-meta envelope to the agent for a collection-
// shape intent is a category error — same shape, wrong semantic level.
//
// Sits beside the existing demotion family:
//   scoreConfigShapeDemotion       -> i18n/RSC bootstrap (-200)
//   scoreDegenerateRowDemotion     -> all-collapsed-values inside one row (-300)
//   scoreDuplicateRowDemotion      -> same row repeated across array (-250)
//   scoreEmptyContainerDemotion    -> all leaves empty containers (-200)
//   scoreSiteMetaJsonLdDemotion    -> Organization-as-list-result (-200, NEW)
//
// Generic structural rule (no per-host registry):
//   - The data has `@type` keyed to ONLY site-meta types (Organization,
//     Corporation, TravelAgency, OnlineStore, WebSite, WebPage), either
//     as a string or as an array containing only such types.
//   - AND the intent is LIST_INTENT (search/find/list/trending/...).
//
// Falsifier carve-outs (must NOT demote):
//   - @type: Hotel / LodgingBusiness / Product / Article / etc. on a
//     DETAIL_INTENT — single-entity types match single-entity intents.
//   - @type: ItemList with itemListElement — that IS the listing.
//   - @type: Organization on a DETAIL_INTENT (e.g. "get priceline
//     contact info") — corporate metadata IS what was asked for.
//
// LIST_INTENT regex shared with TINY_RESULT_LIST_INTENT (line ~2651);
// declared later but referenced at call-time (after module init).
const SITE_META_LD_TYPES = new Set([
  "Organization",
  "Corporation",
  "TravelAgency",
  "OnlineStore",
  "WebSite",
  "WebPage",
]);

export function looksLikeSiteMetaJsonLd(data: unknown): boolean {
  if (data == null || typeof data !== "object" || Array.isArray(data)) return false;
  const obj = data as Record<string, unknown>;
  const ldType = obj["@type"];
  if (ldType == null) return false;
  const types: string[] = Array.isArray(ldType)
    ? ldType.filter((t): t is string => typeof t === "string")
    : (typeof ldType === "string" ? [ldType] : []);
  if (types.length === 0) return false;
  return types.every((t) => SITE_META_LD_TYPES.has(t));
}

function scoreSiteMetaJsonLdDemotion(structure: ExtractedStructure, intent: string): number {
  if (!looksLikeSiteMetaJsonLd(structure.data)) return 0;
  const lower = intent.toLowerCase();
  // Only demote when the intent asks for a COLLECTION. Single-entity
  // intents (DETAIL_INTENT) may legitimately want the Organization card.
  if (!TINY_RESULT_LIST_INTENT.test(lower)) return 0;
  return -200;
}


// ---------------------------------------------------------------------------
// looksLikeTinyContentReadResult
// ---------------------------------------------------------------------------
// Structural primitive for the EXECUTE-return gate (companion to the
// scoreEmptyContainerDemotion RANK-time gate). When an extraction yielded
// a tiny meta-only envelope (just `title`, `url`, `site_name`, etc.)
// for a content-read intent (LIST_INTENT / DETAIL_INTENT), the substrate
// must NOT claim success — the agent asked for content, the page-meta
// envelope is a fallback shape, not the data.
//
// Live regressions from .bench-gate/20260521T010031Z:
//   - 018/019 openlibrary.org/works/OLxxxxxW (DETAIL): returned
//     151/181-byte `[{title:"Alfaguara"},{title:"Spanish"}]` — two
//     publisher/language chips, no book content.
//   - 025 instagram.com/reels/ (LIST): returned 21-byte `{title:"Instagram"}`
//   - 029 beatsaver.com/?q=camellia (LIST): returned 55-byte
//     `{title:"BeatSaver.com",url:"..."}`
//
// Detection rule (all-of):
//   1. JSON-serialized payload < 300 bytes
//   2. AND total string-leaf character count < 120 (so a single
//      genuinely-content card like {title, description, body, url}
//      with a real description survives)
//   3. AND no content-bearing field (description / body / summary /
//      content / abstract with >=40 chars) — sparse-but-rich cards
//      that explicitly carry text survive even when compact
//   4. AND intent matches LIST_INTENT or DETAIL_INTENT (the gate is
//      content-read scoped; a status-check intent legitimately gets
//      `{result:"ok"}`)
//
// Notably: arrays of 2+ records are NOT spared by count alone, because
// the openlibrary chip-ribbon ([{title:"Alfaguara"},{title:"Spanish"}])
// is structurally a 2-element array that nonetheless carries no real
// content — every "row" is a single short string.
//
// Derived from existing demotion family, no new magic numbers invented
// without grounding. The 300-byte / 120-char floors are calibrated
// against the four live failure artifacts above (largest was 181B with
// ~50 string-leaf chars; smallest legitimate single-card content card
// observed in pass artifacts is ~250B with ~150 string-leaf chars).
//
// LIST_INTENT/DETAIL_INTENT regex must stay aligned with src/execution
// counterparts (see comment there). Duplicated rather than imported to
// keep extraction/ free of execution/ deps.
const TINY_RESULT_LIST_INTENT = /\b(search|list|find|trending|top|latest|discover|browse|tags|versions|releases|packages|images|repositories|results|items|posts|articles|threads|reviews|products|listings|stories|videos|tweets|episodes|reels|feed|maps|works|books)\b/i;
const TINY_RESULT_DETAIL_INTENT = /\b(get|fetch|view|read|show|details?|info|metadata|abstract|article|profile|work|book|page|post)\b/i;

export function looksLikeTinyContentReadResult(
  data: unknown,
  intent: string | undefined,
): { tiny: boolean; reason?: string; bytes: number; stringLeafChars: number } {
  if (data == null) return { tiny: false, bytes: 0, stringLeafChars: 0 };
  const lower = (intent ?? "").toLowerCase();
  const isContentRead =
    TINY_RESULT_LIST_INTENT.test(lower) || TINY_RESULT_DETAIL_INTENT.test(lower);
  if (!isContentRead) return { tiny: false, bytes: 0, stringLeafChars: 0 };

  let serialized = "";
  try {
    serialized = JSON.stringify(data);
  } catch {
    return { tiny: false, bytes: 0, stringLeafChars: 0 };
  }
  const bytes = serialized.length;
  if (bytes >= 300) return { tiny: false, bytes, stringLeafChars: 0 };

  // Count string-leaf characters (the actual content density).
  let stringLeafChars = 0;
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (typeof node === "string") {
      stringLeafChars += node.length;
      return;
    }
    if (Array.isArray(node)) {
      for (const e of node) walk(e);
      return;
    }
    if (typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v);
    }
  };
  walk(data);

  if (stringLeafChars >= 120) {
    return { tiny: false, bytes, stringLeafChars };
  }

  // Final check: if records carry content-bearing fields (description /
  // body / summary / text / content / abstract), spare them — a sparse
  // real card with rich text is legitimate even when compact.
  const hasContentField = (() => {
    const CONTENT_KEYS = /^(description|body|summary|text|content|abstract|excerpt|snippet|caption)$/i;
    let found = false;
    const checkObj = (obj: Record<string, unknown>): void => {
      for (const [k, v] of Object.entries(obj)) {
        if (CONTENT_KEYS.test(k) && typeof v === "string" && v.length >= 40) {
          found = true;
          return;
        }
      }
    };
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          checkObj(item as Record<string, unknown>);
          if (found) return true;
        }
      }
    } else if (typeof data === "object") {
      checkObj(data as Record<string, unknown>);
    }
    return found;
  })();
  if (hasContentField) {
    return { tiny: false, bytes, stringLeafChars };
  }

  return {
    tiny: true,
    reason: `tiny_extraction bytes=${bytes} string_leaf_chars=${stringLeafChars}`,
    bytes,
    stringLeafChars,
  };
}


// ---------------------------------------------------------------------------
// extractFromDOM
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  data: unknown;
  extraction_method: string;
  confidence: number;
  selector?: string;
}

function buildReplaySelector($el: cheerio.Cheerio<CheerioEl>): string | undefined {
  const tag = $el.get(0)?.tagName;
  if (!tag) return undefined;
  const id = ($el.attr("id") ?? "").trim();
  if (id) return `${tag}#${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const classes = (($el.attr("class") ?? "").trim())
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .map((part) => part.replace(/[^a-zA-Z0-9_-]/g, ""))
    .filter(Boolean);
  return classes.length > 0 ? `${tag}.${classes.join(".")}` : tag;
}

function extractUsingSelector(html: string, selector: string): ExtractedStructure | null {
  const $ = cheerio.load(cleanDOM(html));
  const elements = $(selector);
  if (elements.length < 1) return null;
  const items: Record<string, string>[] = [];
  elements.each((_, el) => {
    const fields = extractCardFields($, $(el));
    if (Object.keys(fields).length >= 2) items.push(fields);
  });
  if (items.length >= 2) {
    return { type: "repeated-elements", data: items, element_count: items.length, selector };
  }
  if (items.length === 1) {
    return { type: "key-value", data: items[0], element_count: 1, selector };
  }
  return null;
}

export function extractFromDOMWithHint(
  html: string,
  intent: string,
  hint?: { selector?: string },
  contextUrl?: string,
): ExtractionResult {
  if (hint?.selector) {
    const extracted = extractUsingSelector(html, hint.selector);
    if (extracted) {
      // Apply the same junk-shape gates as the main extractFromDOM
      // pre-score filter. Without this, a captured selector that scored
      // well at CAPTURE time but now matches degenerate-row / empty-
      // container / config-shape content at EXECUTE time returns junk
      // early instead of falling through to the full extractor pass.
      // Live regression from .bench-gate/20260520T235712Z/009 pypi:
      // captured `sample_values` showed real {title, heading_1..} key-
      // value structure, but execute-time selector replay matched the
      // 182-row release-date table where every row is {date,info,
      // description} all-equal — classic looksLikeDegenerateRowArray
      // pattern that the main pre-score filter would drop.
      const isJunkShape =
        (extracted.type === "repeated-elements" && looksLikeDegenerateRowArray(extracted.data)) ||
        looksLikeConfigShape(extracted.data) ||
        looksLikeEmptyContainer(extracted.data) ||
        (extracted.type === "repeated-elements" && looksLikeDuplicateRowArray(extracted.data));
      if (!isJunkShape) {
        const assessment = assessIntentResult(extracted.data, intent);
        if (assessment.verdict === "pass") {
          return {
            data: sanitizeExtractionToJson(extracted.data),
            extraction_method: extracted.type,
            confidence: 0.95,
            selector: hint.selector,
          };
        }
      }
    }
  }
  return extractFromDOM(html, intent, contextUrl);
}

/**
 * Main entry point: clean HTML, extract structured data, and return
 * the best match for the given intent.
 */
export function extractFromDOM(html: string, intent: string, contextUrl?: string): ExtractionResult {
  const _finalize = (r: ExtractionResult): ExtractionResult => ({ ...r, data: sanitizeExtractionToJson(r.data) });
  // Extract SPA-embedded data from the FULL untruncated HTML. Next.js SSR
  // pages often place <script id="__NEXT_DATA__"> near the end of the
  // document (past byte 300K on large pages like coinmarketcap). Truncating
  // first silently nuked the only real structured payload on those sites,
  // forcing the pipeline to fall back to noisy DOM repeated-elements
  // extraction. Extract SPA data BEFORE any truncation — it's O(n) regex
  // on raw string, doesn't instantiate cheerio, and is cheap.
  const spaStructures = extractSPAData(html);

  // Cap HTML size to prevent cheerio from hanging on massive pages
  const MAX_HTML_SIZE = 300_000;
  let workingHtml = html;
  if (workingHtml.length > MAX_HTML_SIZE) {
    // Strip attribute bloat first (class/style/data-* attributes inflate HTML 2-3x)
    workingHtml = workingHtml
      .replace(/\s+class="[^"]*"/g, "")
      .replace(/\s+style="[^"]*"/g, "")
      .replace(/\s+data-[a-z][-a-z]*="[^"]*"/g, "");
    // If still too large, truncate keeping body content
    if (workingHtml.length > MAX_HTML_SIZE) {
      const bodyStart = workingHtml.indexOf("<body");
      if (bodyStart > 0) {
        workingHtml = workingHtml.substring(0, Math.max(MAX_HTML_SIZE, bodyStart + MAX_HTML_SIZE));
      } else {
        workingHtml = workingHtml.substring(0, MAX_HTML_SIZE);
      }
    }
  }
  const flashStructures = extractFlashNoticeSpecial(workingHtml, intent);
  const cleaned = cleanDOM(workingHtml);
  const githubStructures = extractGitHubSpecial(workingHtml, intent);
  const repeatedPersonStructures = extractRepeatedPersonSpecial(workingHtml, intent);
  const packageSearchStructures = extractPackageSearchSpecial(workingHtml, intent);
  const xProfileStructures = extractPersonProfileSpecial(workingHtml, intent);
  const postStructures = extractPostSpecial(workingHtml, intent);
  const repeatedArticleStructures = extractRepeatedArticleSpecial(workingHtml, intent);
  const trendStructures = extractTrendSpecial(workingHtml, intent);
  const definitionStructures = extractDefinitionSpecial(workingHtml, intent);
  const packageDetailStructures = extractPackageDetailSpecial(workingHtml, intent);
  const arxivAbstractStructures = extractScholarlyArticleSpecial(workingHtml, intent);
  const courseStructures = extractCourseSearchSpecial(workingHtml, intent);
  // Article extractor reads full html (not the 300KB-capped workingHtml) so the
  // wikipedia mw-parser-output marker survives even on giant pages with massive
  // reference sections that would otherwise push it past the cap.
  const articleStructures = extractArticleBodySpecial(html.length > 600_000 ? html.slice(0, 600_000) : html, intent);
  const allStructures = [...flashStructures, ...githubStructures, ...repeatedPersonStructures, ...packageSearchStructures, ...xProfileStructures, ...postStructures, ...repeatedArticleStructures, ...trendStructures, ...definitionStructures, ...packageDetailStructures, ...arxivAbstractStructures, ...courseStructures, ...articleStructures, ...spaStructures, ...parseStructured(cleaned)]
    .map((structure) => normalizeStructureForIntent(structure, intent));
  // W3-followup: filter out junk shapes pre-score so the metadata-fallback
  // path can catch the page when nothing else remains. Two filter classes:
  //   (1) degenerate repeated-elements arrays whose rows each collapse to
  //       a single unique string (pypi release table {date,info,description}
  //       all equal to one date per row)
  //   (2) pure config-shape structures (i18n bundles, theme tokens, RSC
  //       bootstrap chunks). The -200 scoreConfigShapeDemotion still runs
  //       on any config-shape that escapes this filter (mixed-shape with
  //       sibling data keys); pre-filtering only removes the structures
  //       that would otherwise be the LONE candidate and win by default.
  const isListIntent = TINY_RESULT_LIST_INTENT.test(intent.toLowerCase());
  const structures = allStructures.filter((s) =>
    !(s.type === "repeated-elements" && looksLikeDegenerateRowArray(s.data)) &&
    !looksLikeConfigShape(s.data) &&
    !looksLikeEmptyContainer(s.data) &&
    !(isListIntent && looksLikeSiteMetaJsonLd(s.data)));

  if (structures.length === 0) {
    const fallback = extractHtmlMetadataFallback(html);
    if (fallback) {
      return _finalize({ data: fallback, extraction_method: "html_metadata_fallback", confidence: 0.4 });
    }
    return _finalize({ data: null, extraction_method: "none", confidence: 0 });
  }

  // Score each structure by relevance to intent
  const intentWords = intent.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = structures.map((s) => ({
    structure: s,
    score: scoreRelevance(s, intentWords) + scoreSemanticFit(s, intent) + scoreSparseLinkList(s) + scoreFieldRichness(s) + scoreConfigShapeDemotion(s) + scoreDegenerateRowDemotion(s) + scoreDuplicateRowDemotion(s) + scoreEmptyContainerDemotion(s) + scoreSiteMetaJsonLdDemotion(s, intent) + scoreTableIntentOverlapDemotion(s, intent, contextUrl, structures),
  }));
  scored.sort((a, b) => b.score - a.score);
  const passing = scored.filter((candidate) => assessIntentResult(candidate.structure.data, intent).verdict === "pass");
  const bestPassing = (() => {
    // Prefer article-body extraction over a schema-only JSON-LD / meta envelope.
    // A type:"article" structure is emitted by extractArticleBodySpecial only
    // when the page is genuinely article/wikipedia-shaped (it applies its own
    // intent + page-shape gate upstream), so its presence WITH real sections
    // means the body content the agent asked for was found. A same-page JSON-LD
    // Article object has @type/name/url/dates/publisher but no body text or
    // sections. assessIntentResult abstains ("skip", not "pass") on free-form
    // article AND json-ld payloads alike, so this preference used to sit behind
    // the passing.length gate below and never ran; the JSON-LD card then won on
    // raw relevance score and the agent got the schema.org envelope instead of
    // the article. This check is structural (existing structure.type values),
    // not a per-domain or intent-string rule, and runs regardless of whether
    // anything earned an explicit pass verdict.
    const bestArticle = scored.find((candidate) => candidate.structure.type === "article");
    if (bestArticle) {
      const articleData = bestArticle.structure.data as { sections?: unknown[] };
      if (articleData?.sections && Array.isArray(articleData.sections) && articleData.sections.length > 0) {
        return bestArticle;
      }
    }
    if (passing.length === 0) return undefined;
    const bestPassingOverall = passing[0];
    const bestPassingSpa = passing.find((candidate) => candidate.structure.type.startsWith("spa-"));
    // Prefer cleaner SPA payloads when they're effectively tied with DOM-derived candidates.
    if (bestPassingSpa && bestPassingOverall && bestPassingSpa.score >= bestPassingOverall.score - 2) {
      return bestPassingSpa;
    }
    return bestPassingOverall;
  })();
  if (bestPassing) {
    return _finalize({
      data: bestPassing.structure.data,
      extraction_method: bestPassing.structure.type,
      confidence: computeConfidence(bestPassing.structure, bestPassing.score),
      selector: bestPassing.structure.selector,
    });
  }

  const best = scored[0];
  if (isMessageLikeStructure(best.structure, intent)) {
    return _finalize({
      data: best.structure.data,
      extraction_method: best.structure.type,
      confidence: computeConfidence(best.structure, best.score),
      selector: best.structure.selector,
    });
  }

  if (scored.length === 1) {
    return _finalize({
      data: best.structure.data,
      extraction_method: best.structure.type,
      confidence: computeConfidence(best.structure, best.score),
      selector: best.structure.selector,
    });
  }

  const hasClearWinner = best.score > scored[1].score * 1.5;

  if (hasClearWinner && best.score > 0) {
    return _finalize({
      data: best.structure.data,
      extraction_method: best.structure.type,
      confidence: computeConfidence(best.structure, best.score),
      selector: best.structure.selector,
    });
  }

  // No clear winner — return all structures
  return _finalize({
    data: scored.map((s) => ({
      type: s.structure.type,
      data: s.structure.data,
      relevance_score: s.score,
    })),
    extraction_method: "multiple",
    confidence: computeConfidence(best.structure, best.score) * 0.7,
    selector: best.structure.selector,
  });
}

function scoreRelevance(structure: ExtractedStructure, intentWords: string[]): number {
  const text = JSON.stringify(structure.data).toLowerCase();
  let score = 0;
  const intentSet = new Set(intentWords);

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
  if (structure.type === "spa-nextjs") score += 5;
  if (structure.type.startsWith("spa-")) score += 3;
  if (structure.type === "json-ld") score += 3;
  if (structure.type === "itemlist") score += 3;
  if (structure.type === "table") score += 2;
  if (structure.type === "repeated-elements") score += 1;
  if (structure.type === "key-value") score += 1;

  // GitHub/repo-aware shaping: prefer repo-shaped objects/lists over file tables.
  if (structure.type === "key-value" && structure.data && typeof structure.data === "object" && !Array.isArray(structure.data)) {
    const keys = Object.keys(structure.data as Record<string, unknown>);
    if (keys.includes("full_name")) score += 4;
    if (keys.includes("description")) score += 2;
    if (keys.includes("stars")) score += 2;
    if ((intentSet.has("repository") || intentSet.has("repo")) && keys.includes("full_name")) score += 6;
    if (intentSet.has("info")) score += 2;
  }

  if (structure.type === "repeated-elements" && Array.isArray(structure.data)) {
    const items = structure.data as Array<Record<string, unknown>>;
    const repoShaped = items.filter((item) => typeof item?.full_name === "string" || typeof item?.url === "string");
    if (repoShaped.length >= 2) score += 8;
    if ((intentSet.has("search") || intentSet.has("trending")) && repoShaped.length >= 2) score += 8;
    const peopleShaped = items.filter((item) => typeof item?.name === "string" && (typeof item?.headline === "string" || typeof item?.public_identifier === "string"));
    if (peopleShaped.length >= 2) score += 8;
    if ((intentSet.has("people") || intentSet.has("person") || intentSet.has("profile")) && peopleShaped.length >= 2) score += 10;
    const postShaped = items.filter((item) =>
      (typeof item?.id === "string" || typeof item?.url === "string") &&
      (typeof item?.text === "string" || typeof item?.content === "string" || typeof item?.username === "string")
    );
    if (postShaped.length >= 1) score += 8;
    if ((intentSet.has("post") || intentSet.has("posts") || intentSet.has("status") || intentSet.has("statuses") || intentSet.has("tweet")) && postShaped.length >= 1) score += 10;
    const topicShaped = items.filter((item) =>
      (typeof item?.name === "string" || typeof item?.title === "string") &&
      typeof item?.url === "string"
    );
    if (topicShaped.length >= 2) score += 8;
    if ((intentSet.has("trend") || intentSet.has("trending") || intentSet.has("topic") || intentSet.has("topics") || intentSet.has("hashtag")) && topicShaped.length >= 2) score += 10;
  }

  if (structure.type === "table" && Array.isArray(structure.data)) {
    const keys = new Set((structure.data as Array<Record<string, unknown>>).flatMap((row) => Object.keys(row)));
    if (keys.has("Last commit message") || keys.has("Last commit date")) score -= 8;
    if (keys.has("Name") && !intentSet.has("file") && !intentSet.has("commit")) score -= 4;
  }

  // Bonus for more elements (richer data)
  score += Math.min(structure.element_count * 0.1, 2);

  return score;
}

function computeConfidence(structure: ExtractedStructure, relevanceScore: number): number {
  // Confidence is derived from STRUCTURAL signals on the extracted data,
  // not from an opaque extractor-type ladder. The earlier `switch (type)`
  // form (forbidden surface per CLAUDE.md: hardcoded confidence switch
  // with type list) silently sent unknown extractor types to the
  // sub-gate default (0.3) so adding a new extractor required also
  // editing the switch, and types that returned thin data still got
  // their high base score.
  //
  // The signals below describe what the extracted block actually
  // contains. New extractor types whose data is structurally rich
  // clear the 0.5 promotion gate automatically; types that emit thin
  // data do not, regardless of what they call themselves.
  let confidence = 0;

  // Signal 1: any structured data at all
  if (structure.element_count >= 1) confidence += 0.3;

  // Signal 2: shape richness of the extracted data
  const shape = inspectExtractedShape(structure.data);
  if (shape.kind === "array_of_objects") {
    if (shape.avg_keys_per_item >= 3) confidence += 0.3;
    else if (shape.avg_keys_per_item >= 1) confidence += 0.15;
  } else if (shape.kind === "object_with_keys") {
    if (shape.key_count >= 5) confidence += 0.3;
    else if (shape.key_count >= 2) confidence += 0.15;
  } else if (shape.kind === "array_of_primitives") {
    confidence += 0.1;
  }

  // Signal 3: scale of the extracted block
  if (structure.element_count >= 3) confidence += 0.05;
  if (structure.element_count >= 5) confidence += 0.05;
  if (structure.element_count >= 10) confidence += 0.05;

  // Signal 4: intent-relevance (BM25-ish over keywords; computed upstream)
  if (relevanceScore > 5) confidence += 0.05;
  if (relevanceScore > 10) confidence += 0.05;

  // Signal 5: substantial list — multiple objects each with multiple fields.
  // This is the clearest structural indicator of "real page data" vs thin stubs.
  if (shape.kind === "array_of_objects" && shape.avg_keys_per_item >= 2 && structure.element_count >= 2) {
    confidence += 0.15;
  }

  return Math.min(confidence, 1);
}

interface ExtractedShape {
  kind: "array_of_objects" | "array_of_primitives" | "object_with_keys" | "scalar_or_empty";
  avg_keys_per_item: number;
  key_count: number;
}

function inspectExtractedShape(data: unknown, _depth = 0): ExtractedShape {
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return { kind: "scalar_or_empty", avg_keys_per_item: 0, key_count: 0 };
    }
    const objectItems = data.filter(
      (item) => item !== null && typeof item === "object" && !Array.isArray(item),
    ) as Array<Record<string, unknown>>;
    if (objectItems.length >= Math.max(1, Math.floor(data.length / 2))) {
      const totalKeys = objectItems.reduce((sum, item) => sum + Object.keys(item).length, 0);
      return {
        kind: "array_of_objects",
        avg_keys_per_item: totalKeys / objectItems.length,
        key_count: 0,
      };
    }
    return { kind: "array_of_primitives", avg_keys_per_item: 0, key_count: 0 };
  }
  if (data !== null && typeof data === "object") {
    const keys = Object.keys(data as Record<string, unknown>);
    // Single-key wrapper pattern: pageProps = {items: [...]} — common in Next.js.
    // Drill into the nested value to surface the real shape rather than
    // reporting key_count=1 (which scores 0 in Signal 2).
    if (keys.length === 1 && _depth === 0) {
      const nested = (data as Record<string, unknown>)[keys[0]];
      const nestedShape = inspectExtractedShape(nested, 1);
      if (nestedShape.kind !== "scalar_or_empty") return nestedShape;
    }
    return { kind: "object_with_keys", avg_keys_per_item: 0, key_count: keys.length };
  }
  return { kind: "scalar_or_empty", avg_keys_per_item: 0, key_count: 0 };
}

// ---------------------------------------------------------------------------
// buildStructuredDataHeader — surface schema.org JSON-LD as a markdown block
// ---------------------------------------------------------------------------
//
// Use case: agents reading /v1/browse/text or /v1/browse/markdown get the
// rendered DOM, which on SSR pages can include personalized widgets (e.g.
// "dropped_in_price", "recommended for you") injected alongside canonical
// listings. The publisher's own JSON-LD is authoritative for what the page
// represents and is pre-render, so prepending it gives the agent a clean
// reference before the noisy DOM text.
//
// Only emits a block when the JSON-LD contains an entity worth highlighting:
// ItemList (search results, catalog pages), Product (product detail),
// Article / NewsArticle / BlogPosting (article pages), Recipe, JobPosting,
// Event. Skips bare WebSite/SearchAction/BreadcrumbList — they're metadata,
// not content the agent asked for.

const STRUCTURED_DATA_HIGHLIGHT_TYPES = new Set([
  "ItemList",
  "Product",
  "Offer",
  "AggregateOffer",
  "Article",
  "NewsArticle",
  "BlogPosting",
  "Recipe",
  "JobPosting",
  "Event",
  "Movie",
  "TVSeries",
  "Book",
  "MusicAlbum",
  "Course",
  "VideoObject",
  "LocalBusiness",
  "Organization",
  "Restaurant",
  "Person",
]);

function collectLdNodes(value: unknown, out: Array<Record<string, unknown>>) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const v of value) collectLdNodes(v, out);
    return;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["@type"] === "string" || Array.isArray(obj["@type"])) {
      out.push(obj);
    }
    if (Array.isArray(obj["@graph"])) {
      for (const node of obj["@graph"]) collectLdNodes(node, out);
    }
  }
}

function ldTypeOf(node: Record<string, unknown>): string {
  const t = node["@type"];
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    for (const candidate of t) {
      if (typeof candidate === "string") return candidate;
    }
  }
  return "";
}

function pickHighlight(nodes: Array<Record<string, unknown>>): Record<string, unknown> | null {
  for (const node of nodes) {
    if (STRUCTURED_DATA_HIGHLIGHT_TYPES.has(ldTypeOf(node))) return node;
  }
  return null;
}

function formatOffer(offer: unknown): string {
  if (!offer || typeof offer !== "object") return "";
  const o = offer as Record<string, unknown>;
  const price = o.price ?? o.lowPrice ?? "";
  const currency = o.priceCurrency ?? "";
  if (!price) return "";
  return currency ? `${price} ${currency}` : String(price);
}

function formatItemListBlock(node: Record<string, unknown>): string {
  const name = typeof node.name === "string" ? node.name : "";
  const items = Array.isArray(node.itemListElement) ? node.itemListElement : [];
  const number = typeof node.numberOfItems === "number"
    ? node.numberOfItems
    : (typeof node.numberOfItems === "string" ? Number(node.numberOfItems) : items.length);

  const lines: string[] = [];
  lines.push("## Structured data (JSON-LD: ItemList)");
  lines.push("");
  if (name) lines.push(`**${name}** — ${number || items.length} items`);
  else lines.push(`${number || items.length} items`);
  lines.push("");
  let rowsEmitted = 0;
  for (const entry of items) {
    if (rowsEmitted >= 50) {
      lines.push(`- … (${items.length - rowsEmitted} more)`);
      break;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const inner = (e.item && typeof e.item === "object") ? e.item as Record<string, unknown> : e;
    const itemName = typeof inner.name === "string" ? inner.name : (typeof e.name === "string" ? e.name : "");
    if (!itemName) continue;
    const pos = typeof e.position === "number" ? e.position : rowsEmitted + 1;
    const offerStr = formatOffer(inner.offers);
    const url = typeof inner.url === "string" ? inner.url : (typeof e.url === "string" ? e.url : "");
    let row = `${pos}. ${itemName}`;
    if (offerStr) row += ` — ${offerStr}`;
    if (url) row += ` (${url})`;
    lines.push(row);
    rowsEmitted++;
  }
  return lines.join("\n");
}

function formatGenericBlock(node: Record<string, unknown>, type: string): string {
  const lines: string[] = [];
  lines.push(`## Structured data (JSON-LD: ${type})`);
  lines.push("");
  // Pick the agent-relevant top-level fields in a canonical order.
  const fields: Array<[string, unknown]> = [];
  const keysOfInterest = [
    "name", "headline", "alternateName", "description",
    "brand", "author", "creator", "publisher",
    "datePublished", "dateModified", "uploadDate",
    "duration", "genre", "category",
    "address", "telephone", "email", "url",
    "aggregateRating", "ratingValue", "reviewCount",
    "offers", "lowPrice", "highPrice", "price", "priceCurrency",
    "availability", "sku", "gtin", "mpn",
    "datePosted", "validThrough", "hiringOrganization", "jobLocation", "employmentType", "baseSalary",
    "startDate", "endDate", "location", "performer",
  ];
  for (const key of keysOfInterest) {
    if (key in node && node[key] !== undefined && node[key] !== null && node[key] !== "") {
      fields.push([key, node[key]]);
    }
  }
  for (const [k, v] of fields) {
    let rendered: string;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      rendered = String(v);
    } else if (Array.isArray(v)) {
      const parts = v.map((x) => {
        if (x && typeof x === "object" && "name" in (x as Record<string, unknown>)) {
          return String((x as Record<string, unknown>).name);
        }
        return typeof x === "string" || typeof x === "number" ? String(x) : "";
      }).filter(Boolean);
      rendered = parts.join(", ");
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (k === "offers" || k === "aggregateOffer") {
        rendered = formatOffer(o);
      } else if (typeof o.name === "string") {
        rendered = o.name;
      } else if (typeof o.value === "string" || typeof o.value === "number") {
        rendered = String(o.value);
      } else {
        rendered = "";
      }
    } else {
      rendered = "";
    }
    if (rendered) lines.push(`- **${k}**: ${rendered}`);
  }
  if (lines.length <= 2) return ""; // nothing useful
  return lines.join("\n");
}

/**
 * Return a markdown header block summarizing the page's JSON-LD structured
 * data, or null if no agent-relevant entity is present. Pure function — no
 * I/O, safe for tests and for prepending to browse text/markdown responses.
 */
export function buildStructuredDataHeader(html: string): string | null {
  if (!html || typeof html !== "string") return null;
  let structures: ExtractedStructure[];
  try {
    structures = parseStructured(html);
  } catch {
    return null;
  }
  const allNodes: Array<Record<string, unknown>> = [];
  for (const s of structures) {
    if (s.type !== "json-ld") continue;
    collectLdNodes(s.data, allNodes);
  }
  if (allNodes.length === 0) return null;
  const highlight = pickHighlight(allNodes);
  if (!highlight) return null;
  const type = ldTypeOf(highlight);
  if (type === "ItemList") {
    const items = Array.isArray(highlight.itemListElement) ? highlight.itemListElement : [];
    if (items.length === 0) return null;
    const block = formatItemListBlock(highlight);
    return block || null;
  }
  const generic = formatGenericBlock(highlight, type);
  return generic || null;
}

// ---------------------------------------------------------------------------
// JSON post-process: sanitise HTML string values to markdown,
// convert embedded <table> markup to JSON arrays.
// ---------------------------------------------------------------------------
//
// Lewis 2026-05-21 redirect (third time): "make it prioritise XHR JSON
// above all else - if not fallback to ssr/html - content, and make
// postprocess step to convert it to json regardless. json should
// sanitize html to markdown where relevant, tables turned into json".
//
// The XHR-first ranking layer lives in src/execution/index.ts
// rankEndpoints. This module handles the orthogonal piece: whatever the
// extractor returns, walk it and clean up string values that contain
// HTML so the agent receives JSON without raw markup. Tables embedded
// in string values become JSON arrays (header-row -> keys; data-row ->
// values), preserving structure that would otherwise be lost as
// markdown.

const HTML_TAG_RE = /<[a-z][a-z0-9]*(\s[^>]*)?>/i;
const TABLE_RE = /<table[\s\S]*?<\/table>/i;

function looksHtml(s: string): boolean {
  return s.length > 0 && HTML_TAG_RE.test(s);
}

function htmlTableToJson(tableHtml: string): Record<string, string>[] | null {
  try {
    const $ = cheerio.load(`<div>${tableHtml}</div>`, undefined, false);
    const $table = $("table").first();
    if (!$table.length) return null;
    const rows = parseTable($, $table);
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

// Minimal HTML -> markdown for inline content. Cheerio-based walk;
// covers the common formatting tags + links + lists + tables (which
// inline as markdown rather than JSON, since the parent string context
// can't accept an array). Falls back to text content for unknown tags.
function htmlToMarkdown(html: string): string {
  // Pre-strip script/style/noscript/iframe blocks entirely — cheerio's
  // default mode keeps their text content as a child text node which
  // can leak into the markdown output via the walker.
  const preStripped = html.replace(/<(script|style|noscript|iframe|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  try {
    const $ = cheerio.load(`<div id="_root_">${preStripped}</div>`, undefined, false);
    const root = $("#_root_").get(0);
    if (!root) return $("body").text().trim() || stripTags(html);
    const walk = (node: unknown): string => {
      const n = node as { type?: string; data?: string; name?: string; attribs?: Record<string, string>; children?: unknown[] };
      if (!n) return "";
      if (n.type === "text") return n.data ?? "";
      if (n.type !== "tag") {
        return (n.children ?? []).map(walk).join("");
      }
      const tag = (n.name ?? "").toLowerCase();
      const inner = (n.children ?? []).map(walk).join("");
      switch (tag) {
        case "h1": return `\n# ${inner.trim()}\n\n`;
        case "h2": return `\n## ${inner.trim()}\n\n`;
        case "h3": return `\n### ${inner.trim()}\n\n`;
        case "h4": return `\n#### ${inner.trim()}\n\n`;
        case "h5": return `\n##### ${inner.trim()}\n\n`;
        case "h6": return `\n###### ${inner.trim()}\n\n`;
        case "p": return `${inner.trim()}\n\n`;
        case "br": return "\n";
        case "hr": return "\n---\n\n";
        case "strong": case "b": return `**${inner}**`;
        case "em": case "i": return `*${inner}*`;
        case "code": return `\`${inner}\``;
        case "pre": return `\n\`\`\`\n${inner}\n\`\`\`\n\n`;
        case "blockquote": return inner.split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
        case "a": {
          const href = n.attribs?.href ?? "";
          return href ? `[${inner}](${href})` : inner;
        }
        case "img": {
          const src = n.attribs?.src ?? "";
          const alt = n.attribs?.alt ?? "";
          return src ? `![${alt}](${src})` : "";
        }
        case "li": return `- ${inner.trim()}\n`;
        case "ul": case "ol": return `\n${inner}\n`;
        case "table": return tableToMarkdown(node);
        case "thead": case "tbody": case "tfoot": case "tr": case "th": case "td":
          return inner;
        case "script": case "style": case "noscript": case "iframe": case "svg": return "";
        case "div": case "section": case "article": case "main": case "aside": case "nav": case "header": case "footer":
          return `${inner.trim()}\n`;
        case "span": case "small": case "abbr": case "cite": case "mark": case "sub": case "sup":
          return inner;
        default:
          return inner;
      }
    };
    return walk(root).trim();
  } catch {
    return stripTags(html);
  }
}

function tableToMarkdown(tableNode: unknown): string {
  try {
    const $ = cheerio.load("<div></div>", undefined, false);
    const $table = $((tableNode as unknown) as never);
    const rows = parseTable($, $table);
    if (rows.length === 0) return "";
    const headers = Object.keys(rows[0]);
    const headerRow = `| ${headers.join(" | ")} |`;
    const separator = `| ${headers.map(() => "---").join(" | ")} |`;
    const dataRows = rows.map((r) => `| ${headers.map((h) => String(r[h] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`);
    return `\n\n${headerRow}\n${separator}\n${dataRows.join("\n")}\n\n`;
  } catch {
    return "";
  }
}


function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Walk extraction output; for any string value that contains HTML
 * markup, convert to markdown. If the HTML is a single `<table>` and
 * the parser yields rows, REPLACE the string with the rows array (JSON)
 * — caller can then iterate. Recursion-bounded.
 */
export function sanitizeExtractionToJson(data: unknown, depth = 0): unknown {
  if (depth > 32 || data == null) return data;
  if (typeof data === "string") {
    if (!looksHtml(data)) return data;
    const trimmed = data.trim();
    // Whole-string-is-a-table: prefer the JSON array shape.
    if (TABLE_RE.test(trimmed) && trimmed.replace(/\s/g, "").startsWith("<table")) {
      const tableJson = htmlTableToJson(trimmed);
      if (tableJson && tableJson.length > 0) return tableJson;
    }
    return htmlToMarkdown(data);
  }
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeExtractionToJson(item, depth + 1));
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      out[k] = sanitizeExtractionToJson(obj[k], depth + 1);
    }
    return out;
  }
  return data;
}
