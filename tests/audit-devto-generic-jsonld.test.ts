import { describe, expect, it } from "bun:test";
import { extractFromDOM } from "../src/extraction/index.js";

// Audit regression-guard for the dev.to per-host extractor removal.
//
// The substrate-faithful rule (CLAUDE.md "Ranker philosophy: heuristics OUT"
// + "Anti-patterns: per-domain heuristics that don't generalise"): no
// `host === "dev.to"` arms. The generic primitive must subsume the old
// dev.to-specific behaviour by reading universal web standards instead:
//   - JSON-LD schema.org (`@type` in Article/BlogPosting/NewsArticle, ItemList)
//   - OpenGraph (`og:type=article`, `og:url` for base-URL resolution)
//   - HTML5 semantic elements (`<article>` + `<h2><a>` + `<time>`)
//
// Same code path therefore must handle dev.to, Medium-style blog indexes,
// and any other repeated-article site that emits standards-conformant HTML.

describe("audit/devto-generic-jsonld: per-host devto extractor replaced by JSON-LD/OG primitive", () => {
  it("extracts repeated articles from JSON-LD schema.org ItemList (any host)", () => {
    // Generic blog index whose only structured signal is JSON-LD ItemList of
    // BlogPosting entries. No CSS class hints, no `crayons-story`, no host.
    const html = `<!doctype html><html><head>
        <title>Tech Blog</title>
        <link rel="canonical" href="https://example.org/blog" />
        <meta property="og:type" content="website" />
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "ItemList",
          "itemListElement": [
            {
              "@type": "ListItem",
              "position": 1,
              "url": "https://example.org/post/state-persistence-langgraph",
              "item": {
                "@type": "BlogPosting",
                "headline": "State persistence with LangGraph and PostgreSQL",
                "url": "https://example.org/post/state-persistence-langgraph",
                "author": { "@type": "Person", "name": "Alex Chen" },
                "datePublished": "2026-05-10T00:00:00Z",
                "description": "A deep dive into agent state durability."
              }
            },
            {
              "@type": "ListItem",
              "position": 2,
              "item": {
                "@type": "BlogPosting",
                "headline": "Building agents with tools",
                "url": "https://example.org/post/building-agents-with-tools",
                "author": { "@type": "Person", "name": "Sam Park" },
                "datePublished": "2026-05-12T00:00:00Z"
              }
            }
          ]
        }
        </script>
      </head><body><main>
        <div>No useful repeated DOM cards here — JSON-LD is the only signal.</div>
      </main></body></html>`;

    const extracted = extractFromDOM(html, "get posts");
    expect(extracted.extraction_method).toBe("repeated-elements");
    expect(Array.isArray(extracted.data)).toBe(true);
    const rows = extracted.data as Array<Record<string, string>>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]?.title).toContain("State persistence");
    expect(rows[0]?.url).toContain("example.org/post/state-persistence-langgraph");
    expect(rows[0]?.author).toContain("Alex Chen");
    expect(rows[1]?.title).toContain("Building agents");
  });

  it("falls back cleanly when no JSON-LD, OG:type=article, or repeated <article> is present", () => {
    // A homepage with NO standards signals and NO repeated articles.
    // The generic primitive must return cleanly (no crash, no spurious
    // rows). Downstream extractors (article-body, html metadata fallback)
    // get to do their job. We assert the contract: no exception is
    // thrown, and the call returns SOME ExtractFromDOM result (may be
    // any method including "none" or metadata fallback) — what we
    // specifically forbid is the per-host extractor having produced a
    // fake repeated-elements row off of unrelated DOM noise.
    const html = `<!doctype html><html><head>
        <title>Just a marketing page</title>
        <meta property="og:type" content="website" />
      </head><body>
        <main>
          <h1>Welcome</h1>
          <p>This is a marketing page without articles, JSON-LD, or repeated cards.</p>
          <button>Sign up</button>
        </main>
      </body></html>`;

    // Must not throw. Must not invent repeated-elements from this page.
    const extracted = extractFromDOM(html, "get posts");
    expect(extracted).toBeTruthy();
    if (extracted.extraction_method === "repeated-elements") {
      const rows = extracted.data as Array<Record<string, string>>;
      // If something matched, it cannot be a fake article row — there are
      // no posts on this page.
      expect(rows.length).toBe(0);
    }
  });
});
