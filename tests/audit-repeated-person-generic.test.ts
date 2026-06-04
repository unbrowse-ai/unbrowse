import { describe, expect, it } from "bun:test";
import { extractFromDOM } from "../src/extraction/index.js";

// Audit regression-guard for the LinkedIn per-host extractor removal.
//
// the platform-faithful rule (CLAUDE.md "Ranker philosophy: heuristics OUT"
// + "Anti-patterns: per-domain heuristics that don't generalise"): no
// `host === "linkedin.com"`, no `linkedin` literal in extractor code, no
// hardcoded `https://www.linkedin.com/in/${handle}` URL fallback, no
// per-host CSS hints like `a[href*='/in/']`.
//
// The generic primitive subsumes the prior LinkedIn search-results behaviour
// by reading universal web standards:
//
//   - JSON-LD `schema.org/ItemList` containing `Person` items — emitted by
//     standards-conformant directory/search pages (alumni directories,
//     team pages, federated social discovery, About.me search, etc).
//   - Multiple JSON-LD `schema.org/Person` nodes anywhere in the document
//     (search pages on social platforms that emit per-result Person LD).
//   - HTML5 semantic <li>/<article> person cards with a heading-linked name
//     and a headline-shaped sibling (no CSS-class or path-shape heuristic).
//
// Same code path therefore handles LinkedIn search AND any standards-
// conformant people-listing site (Mastodon discovery, company team pages,
// alumni directories, etc) with no per-host arms.

describe("audit/repeated-person-generic: per-host LinkedIn extractor replaced by JSON-LD ItemList<Person> primitive", () => {
  it("extracts repeated people from a JSON-LD ItemList<Person> (any host)", () => {
    // Standards-conformant company-team / directory page. The only
    // structured signal is JSON-LD ItemList. No `linkedin.com` literal.
    const html = `<!doctype html><html><head>
        <title>Team Directory — Acme Robotics</title>
        <link rel="canonical" href="https://acme.example/team" />
        <meta property="og:url" content="https://acme.example/team" />
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "ItemList",
          "itemListElement": [
            {
              "@type": "ListItem",
              "position": 1,
              "item": {
                "@type": "Person",
                "name": "Priya Anand",
                "jobTitle": "Principal Engineer, Manipulation",
                "url": "https://acme.example/team/priya-anand"
              }
            },
            {
              "@type": "ListItem",
              "position": 2,
              "item": {
                "@type": "Person",
                "name": "Marcus Lim",
                "jobTitle": "VP Research",
                "url": "https://acme.example/team/marcus-lim"
              }
            },
            {
              "@type": "ListItem",
              "position": 3,
              "item": {
                "@type": "Person",
                "name": "Yuki Tanaka",
                "jobTitle": "Founding Mechanical Engineer",
                "url": "https://acme.example/team/yuki-tanaka"
              }
            }
          ]
        }
        </script>
      </head><body>
        <main><h1>Our Team</h1></main>
      </body></html>`;

    const extracted = extractFromDOM(html, "search people at acme robotics");
    expect(extracted.data).toBeTruthy();
    // ItemList<Person> should surface as a repeated-elements array.
    expect(Array.isArray(extracted.data)).toBe(true);
    const rows = extracted.data as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // Each row has the universal person fields. No `linkedin.com` hardcode.
    const names = rows.map((r) => String(r.name));
    expect(names).toContain("Priya Anand");
    expect(names).toContain("Marcus Lim");
    expect(names).toContain("Yuki Tanaka");
    // URL must come from JSON-LD `url`, NOT a hardcoded linkedin.com fallback.
    const priya = rows.find((r) => String(r.name) === "Priya Anand")!;
    expect(String(priya.url)).toContain("acme.example");
    expect(String(priya.url)).not.toContain("linkedin.com");
    // Headline-style jobTitle should surface as `headline` (universal field
    // used by every people-listing primitive).
    expect(String(priya.headline ?? priya.job_title ?? "")).toContain("Engineer");
  });

  it("extracts repeated people from multiple top-level JSON-LD Person nodes (any host)", () => {
    // Search-results page that emits one schema.org/Person per result block
    // instead of wrapping them in an ItemList. Common on directory sites and
    // standards-conformant social platforms.
    const html = `<!doctype html><html><head>
        <title>People matching "engineer" — Microblog</title>
        <link rel="canonical" href="https://microblog.example/search?q=engineer" />
      </head><body>
        <main>
          <h1>Search results</h1>
          <article>
            <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"Person","name":"Alex Park","alternateName":"alexpark","url":"https://microblog.example/@alexpark","description":"Robotics engineer."}
            </script>
          </article>
          <article>
            <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"Person","name":"Dana Iyer","alternateName":"daniyer","url":"https://microblog.example/@daniyer","description":"ML engineer."}
            </script>
          </article>
        </main>
      </body></html>`;

    const extracted = extractFromDOM(html, "search people engineer");
    expect(extracted.data).toBeTruthy();
    expect(Array.isArray(extracted.data)).toBe(true);
    const rows = extracted.data as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const names = rows.map((r) => String(r.name));
    expect(names).toContain("Alex Park");
    expect(names).toContain("Dana Iyer");
    // URLs come from each Person's own `url` — never a hardcoded host.
    for (const r of rows) {
      expect(String(r.url)).toContain("microblog.example");
      expect(String(r.url)).not.toContain("linkedin.com");
    }
  });

  it("returns cleanly when no Person ItemList, no repeated Person nodes, no person signal", () => {
    // Generic landing page with NO people-listing signal. The primitive must
    // NOT invent fake person rows from generic <li> or <a> noise.
    const html = `<!doctype html><html><head>
        <title>Cool Startup Landing</title>
        <meta property="og:type" content="website" />
      </head><body>
        <main>
          <h1>Welcome</h1>
          <ul>
            <li><a href="/pricing">Pricing</a></li>
            <li><a href="/docs">Docs</a></li>
            <li><a href="/contact">Contact</a></li>
          </ul>
          <p>We sell pickles online. Not a people-listing page.</p>
        </main>
      </body></html>`;

    const extracted = extractFromDOM(html, "find people at cool startup");
    // Must NOT have synthesised a repeated-person array off of nav links.
    if (extracted.data && Array.isArray(extracted.data)) {
      const rows = extracted.data as Array<Record<string, unknown>>;
      // If any rows surfaced (from some other primitive), none of them
      // should look like a fabricated person row.
      for (const r of rows) {
        // A real person row has a `name` shaped like a personal name,
        // not "Pricing" / "Docs" / "Contact".
        if (typeof r.name === "string") {
          expect(["Pricing", "Docs", "Contact"]).not.toContain(r.name);
        }
      }
    }
  });
});
