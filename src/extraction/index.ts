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

function normalizeLinkedInProfilePath(href: string | undefined): string | null {
  if (!href) return null;
  const clean = href.split("?")[0].replace(/\/+$/, "");
  const match = clean.match(/\/in\/([^/]+)$/);
  return match ? match[1] : null;
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

function extractLinkedInSpecial(html: string, intent: string): ExtractedStructure[] {
  if (!/linkedin/i.test(html)) return [];
  const intentLower = intent.toLowerCase();
  if (!/(search|people|person|profile|member)/.test(intentLower)) return [];
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const people: Record<string, string>[] = [];

  $("a[href*='/in/']").each((_, el) => {
    const $a = $(el);
    const handle = normalizeLinkedInProfilePath($a.attr("href"));
    if (!handle || seen.has(handle)) return;
    const name = cleanText($a.text());
    if (!name || name.length < 3 || name.length > 120) return;
    const card = $a.closest("li, div");
    const cardText = cleanText(card.text());
    if (cardText.length < name.length + 5) return;
    const headline = cleanText(
      card.find("div, span, p")
        .map((_, node) => cleanText($(node).text()))
        .get()
        .find((text) =>
          !!text &&
          text !== name &&
          text.length >= 8 &&
          text.length <= 220 &&
          !/^(message|connect|follow|premium|linkedin|see more|show all)$/i.test(text)
        ) ?? ""
    );
    const row: Record<string, string> = {
      name,
      url: `https://www.linkedin.com/in/${handle}`,
      public_identifier: handle,
    };
    if (headline) row.headline = headline;
    people.push(row);
    seen.add(handle);
  });

  return people.length >= 2 ? [{ type: "repeated-elements", data: people.slice(0, 10), element_count: people.length }] : [];
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

function extractXProfileSpecial(html: string, intent: string): ExtractedStructure[] {
  const intentLower = intent.toLowerCase();
  if (!/(person|people|profile|profiles|user|users|member)/.test(intentLower)) return [];
  if (!/(twitter|x\.com|twitter:|og:)/i.test(html)) return [];
  const $ = cheerio.load(html);
  const title = cleanText($("title").first().text());
  const ogTitle = cleanText($('meta[property="og:title"]').attr("content") ?? $('meta[name="twitter:title"]').attr("content") ?? "");
  const description = cleanText($('meta[name="description"]').attr("content") ?? $('meta[property="og:description"]').attr("content") ?? "");
  const canonical = ($('link[rel="canonical"]').attr("href") ?? $('meta[property="og:url"]').attr("content") ?? "").trim();

  const source = ogTitle || title;
  const titleMatch = source.match(/^(.*?)\s*\(@?([A-Za-z0-9_]{1,30})\)/);
  const handleFromUrl = canonical.match(/https?:\/\/(?:www\.)?x\.com\/([A-Za-z0-9_]{1,30})(?:\/|$)/)?.[1]
    ?? canonical.match(/https?:\/\/(?:www\.)?twitter\.com\/([A-Za-z0-9_]{1,30})(?:\/|$)/)?.[1];
  const username = titleMatch?.[2] ?? handleFromUrl ?? "";
  const name = cleanText(titleMatch?.[1] ?? source.replace(/\s*\/\s*[XT]$/i, ""));

  if (!name || !username) return [];

  const row: Record<string, string> = {
    name,
    username,
    public_identifier: username,
    url: canonical || `https://x.com/${username}`,
  };
  if (description) row.description = description;
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

function extractDevToPostSpecial(html: string, intent: string): ExtractedStructure[] {
  const intentLower = intent.toLowerCase();
  if (!/(devto|dev\.to|post|posts|article|articles)/.test(intentLower)) return [];
  if (!/dev\.to|crayons-story|data-content-user-id/i.test(html)) return [];
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const posts: Record<string, string>[] = [];

  $("article.crayons-story, .crayons-story, [data-content-user-id]").each((_, el) => {
    const $el = $(el);
    const titleLink = $el.find("h2 a[href], h3 a[href], a[href*='/'][href]").filter((__, a) => {
      const href = ($(a).attr("href") ?? "").split("?")[0];
      return /^\/[^/\s]+\/[^/\s]+/.test(href) && !/^\/(?:signin|login|enter|settings|search|tags|new|notifications)\b/i.test(href);
    }).first();
    const href = (titleLink.attr("href") ?? "").split("?")[0];
    const title = cleanText(titleLink.text());
    if (!href || !title || title.length < 6 || seen.has(href)) return;
    const description = cleanText($el.find("p, .crayons-story__snippet, [class*='snippet']").first().text());
    const author = cleanText($el.find("[class*='user-name'], [class*='author'], .crayons-story__secondary").first().text());
    const date = cleanText($el.find("time").first().text() || $el.find("[datetime]").first().attr("datetime") || "");
    const tags = $el.find("a[href^='/t/']").map((__, a) => cleanText($(a).text()).replace(/^#/, "")).get().filter(Boolean).slice(0, 8);
    const row: Record<string, string> = {
      title,
      url: href.startsWith("http") ? href : `https://dev.to${href}`,
      link: href,
    };
    if (description && description !== title) row.description = description;
    if (author && author.length < 120) row.author = author;
    if (date) row.date = date;
    if (tags.length > 0) row.tags = tags.join(", ");
    posts.push(row);
    seen.add(href);
  });

  return posts.length >= 1 ? [{ type: "repeated-elements", data: posts.slice(0, 20), element_count: posts.length }] : [];
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

function extractArxivAbstractSpecial(html: string, intent: string): ExtractedStructure[] {
  const intentLower = intent.toLowerCase();
  if (!/\b(arxiv|abstract|paper)\b/.test(intentLower)) return [];
  if (!/arxiv\.org|class=["'][^"']*abstract|citation_title/i.test(html)) return [];
  const $ = cheerio.load(html);
  const title = cleanText(
    $('meta[name="citation_title"]').attr("content")
    || $(".title").first().text().replace(/^\s*Title:\s*/i, "")
    || $("h1").first().text().replace(/^\s*Title:\s*/i, "")
    || $("title").first().text()
  );
  const abstract = cleanText(
    $(".abstract").first().text().replace(/^\s*Abstract:\s*/i, "")
    || $('meta[name="description"]').attr("content")
    || ""
  );
  if (!title || abstract.length < 40) return [];
  const authors = $(".authors a")
    .map((_, el) => cleanText($(el).text()))
    .get()
    .filter(Boolean)
    .slice(0, 20);
  const canonical = cleanText($('link[rel="canonical"]').attr("href") ?? $('meta[property="og:url"]').attr("content") ?? "");
  return [{
    type: "key-value",
    data: {
      title,
      abstract,
      summary: abstract,
      ...(authors.length > 0 ? { authors } : {}),
      ...(canonical ? { url: canonical } : {}),
    },
    element_count: 1,
  }];
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
      if (linkText && linkText.length > 2 && linkText.length < 200 && !/^(read|more|view|see|click)/i.test(linkText) && !/^\d+$/.test(linkText)) {
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
): ExtractionResult {
  if (hint?.selector) {
    const extracted = extractUsingSelector(html, hint.selector);
    if (extracted) {
      const assessment = assessIntentResult(extracted.data, intent);
      if (assessment.verdict === "pass") {
        return {
          data: extracted.data,
          extraction_method: extracted.type,
          confidence: 0.95,
          selector: hint.selector,
        };
      }
    }
  }
  return extractFromDOM(html, intent);
}

/**
 * Main entry point: clean HTML, extract structured data, and return
 * the best match for the given intent.
 */
export function extractFromDOM(html: string, intent: string): ExtractionResult {
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
  const linkedInStructures = extractLinkedInSpecial(workingHtml, intent);
  const packageSearchStructures = extractPackageSearchSpecial(workingHtml, intent);
  const xProfileStructures = extractXProfileSpecial(workingHtml, intent);
  const postStructures = extractPostSpecial(workingHtml, intent);
  const devToPostStructures = extractDevToPostSpecial(workingHtml, intent);
  const trendStructures = extractTrendSpecial(workingHtml, intent);
  const definitionStructures = extractDefinitionSpecial(workingHtml, intent);
  const packageDetailStructures = extractPackageDetailSpecial(workingHtml, intent);
  const arxivAbstractStructures = extractArxivAbstractSpecial(workingHtml, intent);
  const courseStructures = extractCourseSearchSpecial(workingHtml, intent);
  // Article extractor reads full html (not the 300KB-capped workingHtml) so the
  // wikipedia mw-parser-output marker survives even on giant pages with massive
  // reference sections that would otherwise push it past the cap.
  const articleStructures = extractArticleBodySpecial(html.length > 600_000 ? html.slice(0, 600_000) : html, intent);
  const structures = [...flashStructures, ...githubStructures, ...linkedInStructures, ...packageSearchStructures, ...xProfileStructures, ...postStructures, ...devToPostStructures, ...trendStructures, ...definitionStructures, ...packageDetailStructures, ...arxivAbstractStructures, ...courseStructures, ...articleStructures, ...spaStructures, ...parseStructured(cleaned)]
    .map((structure) => normalizeStructureForIntent(structure, intent));

  if (structures.length === 0) {
    return { data: null, extraction_method: "none", confidence: 0 };
  }

  // Score each structure by relevance to intent
  const intentWords = intent.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = structures.map((s) => ({
    structure: s,
    score: scoreRelevance(s, intentWords) + scoreSemanticFit(s, intent) + scoreSparseLinkList(s) + scoreFieldRichness(s),
  }));

  scored.sort((a, b) => b.score - a.score);

  const passing = scored.filter((candidate) => assessIntentResult(candidate.structure.data, intent).verdict === "pass");
  const bestPassing = (() => {
    if (passing.length === 0) return undefined;
    const bestPassingOverall = passing[0];
    const bestPassingSpa = passing.find((candidate) => candidate.structure.type.startsWith("spa-"));
    // Prefer cleaner SPA payloads when they're effectively tied with DOM-derived candidates.
    if (bestPassingSpa && bestPassingOverall && bestPassingSpa.score >= bestPassingOverall.score - 2) {
      return bestPassingSpa;
    }
    // Prefer article-body extraction over schema-only JSON-LD when intent is article-shaped:
    // a JSON-LD Article object has @type/name/url/dates but no body text or sections, which
    // doesn't satisfy "wikipedia article on quantum computing"-style intents. Article-body
    // returns title + summary + sections (the actual content the agent asked for).
    const isArticleIntent = /(wikipedia|article|wiki page|page on|read|content of|body of|summary of|about )/i.test(intent);
    if (isArticleIntent) {
      const bestArticle = scored.find((candidate) => candidate.structure.type === "article");
      if (bestArticle) {
        const articleData = bestArticle.structure.data as { sections?: unknown[] };
        if (articleData?.sections && Array.isArray(articleData.sections) && articleData.sections.length > 0) {
          return bestArticle;
        }
      }
    }
    return bestPassingOverall;
  })();
  if (bestPassing) {
    return {
      data: bestPassing.structure.data,
      extraction_method: bestPassing.structure.type,
      confidence: computeConfidence(bestPassing.structure, bestPassing.score),
      selector: bestPassing.structure.selector,
    };
  }

  const best = scored[0];
  if (isMessageLikeStructure(best.structure, intent)) {
    return {
      data: best.structure.data,
      extraction_method: best.structure.type,
      confidence: computeConfidence(best.structure, best.score),
      selector: best.structure.selector,
    };
  }

  if (scored.length === 1) {
    return {
      data: best.structure.data,
      extraction_method: best.structure.type,
      confidence: computeConfidence(best.structure, best.score),
      selector: best.structure.selector,
    };
  }

  const hasClearWinner = best.score > scored[1].score * 1.5;

  if (hasClearWinner && best.score > 0) {
    return {
      data: best.structure.data,
      extraction_method: best.structure.type,
      confidence: computeConfidence(best.structure, best.score),
      selector: best.structure.selector,
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
    selector: best.structure.selector,
  };
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
  let confidence = 0;

  // Base confidence from structure type
  switch (structure.type) {
    case "spa-nextjs":
      confidence = 0.9;
      break;
    case "spa-nuxt":
    case "spa-initial-state":
    case "spa-preloaded-state":
      confidence = 0.85;
      break;
    case "json-ld":
      confidence = 0.9;
      break;
    case "article":
      confidence = 0.9;
      break;
    case "itemlist":
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
