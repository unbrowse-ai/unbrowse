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

function extractSearchTermsSpecial(html: string, intent: string): ExtractedStructure[] {
  if (!/\bsearch term/.test(intent.toLowerCase()) && !/class="search-terms"/i.test(html)) return [];
  const $ = cheerio.load(html);
  const rows: Record<string, string>[] = [];
  $("ul.search-terms li.item a[href]").each((_, el) => {
    const $a = $(el);
    const term = cleanText($a.text());
    const href = $a.attr("href")?.trim() ?? "";
    if (!term || term.length > 200) return;
    const row: Record<string, string> = { term };
    if (href) row.url = href;
    rows.push(row);
  });
  if (rows.length === 0) return [];
  return [{
    type: "repeated-elements",
    data: rows,
    element_count: rows.length,
    selector: "ul.search-terms li.item",
  }];
}

function extractMagentoReviewSpecial(html: string, intent: string): ExtractedStructure[] {
  const lower = intent.toLowerCase();
  if (!/\breview|reviewer/.test(lower) && !/class="review-item"/i.test(html)) return [];
  if (!/class="review-item"/i.test(html)) return [];
  const $ = cheerio.load(html);
  const rows: Record<string, string>[] = [];
  $("li.review-item").each((_, el) => {
    const $item = $(el);
    const title = cleanText($item.find(".review-title").first().text());
    const body = cleanText($item.find(".review-content").first().text());
    const author = cleanText($item.find("[itemprop='author'], .review-author .review-details-value").first().text());
    const date = cleanText($item.find("[itemprop='datePublished'], .review-date .review-details-value").first().text());
    const ratingText = cleanText($item.find("[itemprop='ratingValue']").first().text()).replace(/%/g, "");
    const ratingPercent = Number(ratingText);
    const row: Record<string, string> = {};
    if (title) row.title = title;
    if (body) row.body = body;
    if (author) row.author = author;
    if (date) row.date = date;
    if (Number.isFinite(ratingPercent)) {
      row.rating = String(Math.max(1, Math.min(5, Math.round(ratingPercent / 20))));
      row.rating_percent = String(ratingPercent);
    }
    if (Object.keys(row).length >= 2) rows.push(row);
  });
  if (rows.length === 0) return [];
  return [{
    type: "repeated-elements",
    data: rows,
    element_count: rows.length,
    selector: "li.review-item",
  }];
}

function extractPostmillForumSpecial(html: string, intent: string): ExtractedStructure[] {
  const lower = intent.toLowerCase();
  if (!/\bforum\b/.test(lower) && !/class="submission__title"/i.test(html)) return [];
  if (!/class="submission__title"/i.test(html)) return [];
  const $ = cheerio.load(html);
  const pageTitle = cleanText($("title").first().text());
  const subreddit = pageTitle || cleanText($(".page-heading").first().text());
  const rows: Record<string, string>[] = [];
  $("article.submission").each((_, el) => {
    const $item = $(el);
    const title = cleanText($item.find(".submission__title a").first().text());
    const author = cleanText($item.find(".submission__submitter strong, .submission__submitter").first().text());
    const commentsUrl = $item.find(".submission__nav a[href*='/f/']").first().attr("href")?.trim() ?? "";
    const score = cleanText($item.find(".vote__net-score").first().text()).replace(/[^\d-]/g, "");
    const date = $item.find("time").first().attr("datetime")?.trim() ?? cleanText($item.find("time").first().text());
    const commentsText = cleanText($item.find(".submission__nav a strong").first().text());
    const row: Record<string, string> = {};
    if (title) row.title = title;
    if (author) row.author = author;
    if (commentsUrl) {
      row.url = commentsUrl;
      row.permalink = commentsUrl;
      row.comments_url = commentsUrl;
    }
    if (subreddit) row.subreddit = subreddit;
    if (score) row.score = score;
    if (date) row.date = date;
    const commentsCount = commentsText.match(/([0-9,]+)/)?.[1]?.replace(/,/g, "");
    if (commentsCount) row.num_comments = commentsCount;
    if (Object.keys(row).length >= 4) rows.push(row);
  });
  if (rows.length === 0) return [];
  return [{
    type: "repeated-elements",
    data: rows,
    element_count: rows.length,
    selector: "article.submission",
  }];
}

function extractPostmillCommentSpecial(html: string, intent: string): ExtractedStructure[] {
  const lower = intent.toLowerCase();
  if (!/\bcomment/.test(lower) && !/class="comment__body"/i.test(html)) return [];
  if (!/class="comment__body"/i.test(html)) return [];
  const $ = cheerio.load(html);
  const postTitle = cleanText($(".submission__title").first().text()) || cleanText($("title").first().text());
  const postAuthor = cleanText($(".submission__submitter strong, .submission__submitter").first().text());
  const rows: Record<string, string>[] = [];
  $("article.comment").each((_, el) => {
    const $item = $(el);
    const author = cleanText($item.find(".comment__info a[href^='/user/'] strong, .comment__info a[href^='/user/']").first().text());
    const body = cleanText($item.find(".comment__body").first().text());
    const permalink = $item.find(".comment__permalink").first().attr("href")?.trim() ?? "";
    const scoreText = cleanText($item.find(".vote__net-score").first().text())
      .replace(/[−–—]/g, "-")
      .replace(/&minus;/g, "-")
      .replace(/[^\d-]/g, "");
    const row: Record<string, string> = {};
    if (author) row.author = author;
    if (body) row.body = body;
    if (permalink) {
      row.url = permalink;
      row.permalink = permalink;
    }
    if (scoreText) row.score = scoreText;
    if (postTitle) row.post_title = postTitle;
    if (postAuthor) row.post_author = postAuthor;
    if (Object.keys(row).length >= 3) rows.push(row);
  });
  if (rows.length === 0) return [];
  return [{
    type: "repeated-elements",
    data: rows,
    element_count: rows.length,
    selector: "article.comment",
  }];
}

/**
 * Extract structured data embedded by SPA frameworks BEFORE cleanDOM strips scripts.
 * Must be called on raw HTML.
 */
export function extractSPAData(html: string): SPAExtraction[] {
  const results: SPAExtraction[] = [];

  // --- Next.js: <script id="__NEXT_DATA__" type="application/json"> ---
  const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const parsed = JSON.parse(nextDataMatch[1]);
      const pageProps = parsed?.props?.pageProps;
      if (pageProps && typeof pageProps === "object" && Object.keys(pageProps).length > 0) {
        results.push({
          type: "spa-nextjs",
          data: pageProps,
          element_count: countDataElements(pageProps),
        });
      }
    } catch { /* malformed __NEXT_DATA__ */ }
  }

  // --- Nuxt.js: window.__NUXT__={...} or <script>window.__NUXT__=... ---
  const nuxtMatch = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});?\s*(?:<\/script>|$)/i);
  if (nuxtMatch) {
    try {
      const parsed = JSON.parse(nuxtMatch[1]);
      const data = parsed?.data?.[0] ?? parsed?.state ?? parsed;
      if (data && typeof data === "object" && Object.keys(data).length > 0) {
        results.push({
          type: "spa-nuxt",
          data,
          element_count: countDataElements(data),
        });
      }
    } catch { /* malformed __NUXT__ — often not pure JSON, skip */ }
  }

  // --- Generic: window.__INITIAL_STATE__ ---
  const initialStateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*(?:<\/script>|$)/i);
  if (initialStateMatch) {
    try {
      const parsed = JSON.parse(initialStateMatch[1]);
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
  const preloadedMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});?\s*(?:<\/script>|$)/i);
  if (preloadedMatch) {
    try {
      const parsed = JSON.parse(preloadedMatch[1]);
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
        results.push({
          type: "spa-preloaded-state",
          data: parsed,
          element_count: countDataElements(parsed),
        });
      }
    } catch { /* malformed __PRELOADED_STATE__ */ }
  }

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
  const normalizedLawNet = normalizeLawNetSearchRows(objectRows);
  if (normalizedLawNet.length >= 1) {
    return {
      ...structure,
      data: normalizedLawNet,
      element_count: normalizedLawNet.length,
    };
  }
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

function parseLawNetCitation(title: string): { case_name?: string; citation?: string } {
  const match = title.match(/^(.*?)\s*-\s*(\[[^\]]+\].+)$/);
  if (!match) return {};
  const case_name = cleanText(match[1] ?? "");
  const citation = cleanText(match[2] ?? "");
  return {
    ...(case_name ? { case_name } : {}),
    ...(citation ? { citation } : {}),
  };
}

function parseLawNetLabeledField(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(`${escaped}\\s*:\\s*([\\s\\S]*?)(?=\\s+(?:Court|Corams?|Decision Date|Case Number|Catchword)\\s*:|$)`, "i"),
  );
  const value = cleanText(match?.[1] ?? "");
  return value || undefined;
}

function isLikelyLawNetSearchShell(rows: Array<Record<string, string>>): boolean {
  return rows.some((row) => {
    if (row.title === "Search Results") return true;
    const keys = Object.keys(row);
    if (!keys.some((key) => /^heading_\d+$/.test(key))) return false;
    return Object.values(row).some((value) =>
      typeof value === "string" &&
      (/Results returned:/i.test(value) || /\bCourt\s*:/.test(value) || /\[\d{4}\]/.test(value))
    );
  });
}

function parseLawNetCaseRow(text: string): Record<string, string> | null {
  const cleaned = cleanText(text.replace(/\u00a0/g, " "));
  if (!cleaned) return null;
  if (
    cleaned === "Search Results" ||
    /^Results returned:/i.test(cleaned) ||
    /^(Catchword|Category|Courts|Coram|Jurisdiction|Years|Title \[A to Z\]|Title \[Z to A\]|Date \[latest first\])$/i.test(cleaned) ||
    /^Please enter the no\. of words before and after\./i.test(cleaned)
  ) {
    return null;
  }
  if (!/\[\d{4}\]/.test(cleaned)) return null;

  const marker = cleaned.search(/\s+(?:Court|Corams?|Decision Date|Case Number|Catchword)\s*:/i);
  const title = cleanText(marker >= 0 ? cleaned.slice(0, marker) : cleaned);
  if (!title || !/\[\d{4}\]/.test(title) || title.length < 12) return null;

  const row: Record<string, string> = {
    title,
    ...parseLawNetCitation(title),
  };
  const court = parseLawNetLabeledField(cleaned, "Court");
  const coram = parseLawNetLabeledField(cleaned, "Corams") ?? parseLawNetLabeledField(cleaned, "Coram");
  const decision_date = parseLawNetLabeledField(cleaned, "Decision Date");
  const case_number = parseLawNetLabeledField(cleaned, "Case Number");
  const catchword = parseLawNetLabeledField(cleaned, "Catchword");
  if (court) row.court = court;
  if (coram) row.coram = coram;
  if (decision_date) row.decision_date = decision_date;
  if (case_number) row.case_number = case_number;
  if (catchword) row.catchword = catchword;
  row.raw_text = cleaned;
  return row;
}

export function normalizeLawNetSearchRows(rows: Array<Record<string, string>>): Array<Record<string, string>> {
  if (rows.length === 0 || !isLikelyLawNetSearchShell(rows)) return [];

  const bestByTitle = new Map<string, Record<string, string>>();
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (typeof value !== "string") continue;
      const parsed = parseLawNetCaseRow(value);
      if (!parsed) continue;
      const existing = bestByTitle.get(parsed.title);
      if (!existing || Object.keys(parsed).length > Object.keys(existing).length) {
        bestByTitle.set(parsed.title, parsed);
      }
    }
  }

  return [...bestByTitle.values()];
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

  // Extract links
  const links: string[] = [];
  $el.find("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
      links.push(href);
    }
  });
  if (links.length > 0) {
    fields["link"] = links[0];
    fields["url"] = links[0];
  }

  // Fallback title from link text
  if (!fields["title"] && links.length > 0) {
    const linkText = $el.find("a").first().text().trim();
    if (linkText && linkText.length > 2 && linkText.length < 200 && !/^(read|more|view|see|click)/i.test(linkText)) {
      fields["title"] = linkText;
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

function scoreCaseRowElements(structure: ExtractedStructure): number {
  if (structure.type !== "repeated-elements" || !Array.isArray(structure.data)) return 0;
  const items = structure.data as Array<Record<string, unknown>>;
  if (items.length < 2) return 0;
  const caseLike = items.filter((item) =>
    typeof item.title === "string" &&
    (
      typeof item.case_name === "string" ||
      typeof item.citation === "string" ||
      typeof item.case_number === "string" ||
      typeof item.court === "string"
    ),
  ).length;
  if (caseLike >= Math.min(3, items.length)) return 220;
  if (caseLike >= 2) return 140;
  return 0;
}

function scoreSearchShellNoise(structure: ExtractedStructure): number {
  if (structure.type !== "key-value" || !structure.data || typeof structure.data !== "object") return 0;
  const record = structure.data as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title : "";
  const description = typeof record.description === "string" ? record.description : "";
  const headingCount = Object.keys(record).filter((key) => /^heading_\d+$/.test(key)).length;
  if (/^search results$/i.test(title) && /results returned:/i.test(description) && headingCount >= 6) {
    return -260;
  }
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
  // Cap HTML size to prevent cheerio from hanging on massive pages
  const MAX_HTML_SIZE = 300_000;
  const rawHtml = html;
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

  // Extract SPA-embedded data from raw HTML BEFORE cleanDOM strips scripts
  const spaStructures = extractSPAData(rawHtml);
  const flashStructures = extractFlashNoticeSpecial(rawHtml, intent);
  const cleaned = cleanDOM(workingHtml);
  const searchTermStructures = extractSearchTermsSpecial(rawHtml, intent);
  const magentoReviewStructures = extractMagentoReviewSpecial(rawHtml, intent);
  const postmillForumStructures = extractPostmillForumSpecial(rawHtml, intent);
  const postmillCommentStructures = extractPostmillCommentSpecial(rawHtml, intent);
  const githubStructures = extractGitHubSpecial(rawHtml, intent);
  const linkedInStructures = extractLinkedInSpecial(rawHtml, intent);
  const packageSearchStructures = extractPackageSearchSpecial(rawHtml, intent);
  const xProfileStructures = extractXProfileSpecial(rawHtml, intent);
  const postStructures = extractPostSpecial(rawHtml, intent);
  const trendStructures = extractTrendSpecial(rawHtml, intent);
  const definitionStructures = extractDefinitionSpecial(rawHtml, intent);
  const courseStructures = extractCourseSearchSpecial(rawHtml, intent);
  const structures = [...flashStructures, ...searchTermStructures, ...magentoReviewStructures, ...postmillForumStructures, ...postmillCommentStructures, ...githubStructures, ...linkedInStructures, ...packageSearchStructures, ...xProfileStructures, ...postStructures, ...trendStructures, ...definitionStructures, ...courseStructures, ...spaStructures, ...parseStructured(cleaned)]
    .map((structure) => normalizeStructureForIntent(structure, intent));

  if (structures.length === 0) {
    return { data: null, extraction_method: "none", confidence: 0 };
  }

  // Score each structure by relevance to intent
  const intentWords = intent.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = structures.map((s) => ({
    structure: s,
    score:
      scoreRelevance(s, intentWords) +
      scoreSemanticFit(s, intent) +
      scoreSparseLinkList(s) +
      scoreFieldRichness(s) +
      scoreCaseRowElements(s) +
      scoreSearchShellNoise(s),
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
