/**
 * readability — a faithful port of the arc90 / Mozilla-Readability core scoring
 * onto cheerio (unbrowse already loads cheerio; no jsdom dep).
 *
 * Why (the exa contents bench, d87-99): cleanDOM's main-region heuristic and
 * density-pick/prune cannot separate the article body from PROSE-LIKE chrome
 * (speaker bios, event details, related-article SUMMARIES) — those have real
 * paragraphs, so link-density and class-blacklists either miss them or eat real
 * content. Readability's actual algorithm distinguishes them with TWO signals
 * heuristics lack: (1) class/id WEIGHT as a SCORE (not a removal blacklist) —
 * chrome containers (sidebar/related/comment/author/footer) score NEGATIVE; the
 * article (content/post/article/entry) scores POSITIVE; and (2) ADDITIVE
 * assembly — the article is BUILT UP from the top-scoring candidate plus only
 * its high-scoring siblings, so low-scoring chrome is never appended.
 *
 * Returns the assembled article HTML, or null when no confident candidate (the
 * caller falls back to cleanDOM; the readable-markdown content-loss guard is a
 * further net).
 */
import * as cheerio from "cheerio";

const POSITIVE = /\b(article|body|content|entry|hentry|main|page|post|text|blog|story|markdown|prose)\b/i;
const NEGATIVE = /\b(combx|comment|contact|foot|footer|footnote|masthead|media|meta|outbrain|promo|related|recommend|scroll|share|shoutbox|sidebar|sponsor|shopping|tags|tool|widget|nav|navbar|menu|breadcrumb|pagination|pager|author|byline|bio|subscribe|newsletter|social|popular|trending|disqus|modal|banner|cookie)\b/i;

type El = ReturnType<ReturnType<typeof cheerio.load>>;

function linkDensity($: ReturnType<typeof cheerio.load>, $el: El): number {
  const textLen = $el.text().replace(/\s+/g, " ").trim().length || 1;
  let linkLen = 0;
  $el.find("a").each((_, a) => { linkLen += $(a).text().length; });
  return linkLen / textLen;
}

function classWeight($el: El): number {
  const c = `${$el.attr("class") ?? ""} ${$el.attr("id") ?? ""}`;
  let w = 0;
  if (POSITIVE.test(c)) w += 25;
  if (NEGATIVE.test(c)) w -= 25;
  return w;
}

export function extractArticle(html: string): string | null {
  const $ = cheerio.load(html);
  // strip non-content scaffolding up front (tags only — never by content class).
  $("script, style, noscript, svg, iframe, form, nav, header, footer, aside").remove();

  // 1. score paragraph-ish leaves, propagate to parent + grandparent.
  const scores = new Map<unknown, number>();
  const ensure = ($n: El): void => {
    if (!$n.length) return;
    const node = $n[0];
    if (!scores.has(node)) scores.set(node, 1 + classWeight($n));
  };
  $("p, td, pre, li, blockquote").each((_, el) => {
    const $el = $(el);
    const text = $el.text().replace(/\s+/g, " ").trim();
    if (text.length < 25) return;
    let contentScore = 1;
    contentScore += text.split(",").length; // sentence-ish density
    contentScore += Math.min(Math.floor(text.length / 100), 3);
    const parent = $el.parent();
    const grand = parent.parent();
    ensure(parent);
    if (parent.length) scores.set(parent[0], (scores.get(parent[0]) as number) + contentScore);
    ensure(grand);
    if (grand.length) scores.set(grand[0], (scores.get(grand[0]) as number) + contentScore / 2);
  });

  // 2. top candidate = max score after the link-density penalty.
  let top: El | null = null;
  let topScore = -1;
  for (const [node, raw] of scores) {
    const $node = $(node as never);
    const score = raw * (1 - linkDensity($, $node));
    if (score > topScore) { topScore = score; top = $node; }
  }
  if (!top || topScore < 12) return null;

  // 3. additive assembly: the candidate + only siblings that themselves score
  //    above a fraction of the top, or are clean prose paragraphs. Chrome
  //    (negative class-weight, link-heavy) falls below the bar and is dropped.
  const threshold = Math.max(10, topScore * 0.2);
  const parent = top.parent().length ? top.parent() : top;
  const parts: string[] = [];
  parent.children().each((_, sib) => {
    const $sib = $(sib);
    let keep = false;
    if (top && sib === top[0]) {
      keep = true;
    } else {
      const sScore = (scores.get(sib) as number | undefined ?? 0) * (1 - linkDensity($, $sib));
      if (sScore >= threshold) keep = true;
      else if ($sib.is("p")) {
        const t = $sib.text().replace(/\s+/g, " ").trim();
        if (t.length > 80 && linkDensity($, $sib) < 0.25) keep = true;
      }
    }
    if (keep) parts.push($.html($sib) ?? "");
  });
  const assembled = parts.join("\n").trim();
  if (assembled.length > 200) return assembled;
  return top.html() ?? null;
}
