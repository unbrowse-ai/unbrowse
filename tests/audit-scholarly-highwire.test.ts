import { describe, expect, it } from "bun:test";
import { extractFromDOM } from "../src/extraction/index.js";

// Audit regression-guard for the arxiv per-host extractor removal.
//
// the platform-faithful rule (CLAUDE.md "Ranker philosophy: heuristics OUT"
// + "Anti-patterns: per-domain heuristics that don't generalise"): no
// `host === "arxiv.org"` and no arxiv-specific CSS classes
// (`.abstract`, `.authors a`, `.title`). The generic primitive subsumes
// the prior behaviour by reading universal web standards:
//
//   - Highwire `<meta name="citation_title|citation_author|citation_abstract
//     |citation_publication_date|citation_doi|citation_pdf_url">` — emitted
//     by arxiv, biorxiv, ACS, IEEE, Springer, PLOS, JSTOR, PubMed Central,
//     Google Scholar source pages.
//   - JSON-LD `schema.org/ScholarlyArticle` (or Article with sameAs DOI).
//
// Same code path therefore handles arxiv AND every Highwire-emitting
// publisher with no per-host arms.

describe("audit/scholarly-highwire: per-host arxiv extractor replaced by Highwire/JSON-LD primitive", () => {
  it("extracts title/abstract/authors from Highwire citation_* meta (any host)", () => {
    // Standards-conformant scholarly page whose only structured signal is
    // Highwire citation meta. No `.abstract` class, no `.authors` class,
    // no `arxiv.org` literal in the HTML.
    const html = `<!doctype html><html><head>
        <title>Example.org Preprint Server</title>
        <link rel="canonical" href="https://preprints.example.org/2026/0517.abs" />
        <meta name="citation_title" content="State persistence for long-running LLM agents" />
        <meta name="citation_author" content="Chen, Alex" />
        <meta name="citation_author" content="Park, Sam" />
        <meta name="citation_author" content="Okafor, Ada" />
        <meta name="citation_publication_date" content="2026/05/17" />
        <meta name="citation_doi" content="10.48550/example.2605.00917" />
        <meta name="citation_abstract" content="We introduce a checkpointing protocol for autonomous agents that survives process restarts. Across five long-horizon benchmarks, our protocol reduces re-execution cost by 47% relative to in-memory baselines." />
        <meta name="citation_pdf_url" content="https://preprints.example.org/2026/0517.pdf" />
      </head><body>
        <main>
          <h1>State persistence for long-running LLM agents</h1>
          <div>No .abstract class, no .authors class — Highwire is the only signal.</div>
        </main>
      </body></html>`;

    const extracted = extractFromDOM(html, "arxiv abstract for state persistence paper");
    // Highwire path returns a key-value structure with title/abstract.
    expect(extracted.data).toBeTruthy();
    const data = extracted.data as Record<string, unknown>;
    expect(typeof data.title).toBe("string");
    expect(String(data.title)).toContain("State persistence");
    expect(typeof data.abstract).toBe("string");
    expect(String(data.abstract)).toContain("checkpointing protocol");
    expect(String(data.abstract).length).toBeGreaterThan(40);
    // Authors: each citation_author tag should be surfaced.
    expect(Array.isArray(data.authors)).toBe(true);
    const authors = data.authors as string[];
    expect(authors.length).toBeGreaterThanOrEqual(3);
    expect(authors.some((a) => a.includes("Chen"))).toBe(true);
    expect(authors.some((a) => a.includes("Okafor"))).toBe(true);
    // Canonical url comes from <link rel="canonical">, not a host literal.
    expect(String(data.url)).toContain("preprints.example.org");
    // DOI is a universal scholarly identifier; surface when present.
    if (data.doi !== undefined) {
      expect(String(data.doi)).toContain("10.48550");
    }
  });

  it("extracts ScholarlyArticle from JSON-LD when Highwire is absent (any host)", () => {
    // No Highwire meta at all — JSON-LD schema.org/ScholarlyArticle only.
    const html = `<!doctype html><html><head>
        <title>OpenLab Preprint</title>
        <link rel="canonical" href="https://openlab.example.net/papers/agent-checkpointing" />
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "ScholarlyArticle",
          "headline": "Agent checkpointing under partial network failure",
          "abstract": "We study how autonomous agents recover from network partitions when their tool calls span multiple seconds. A two-phase log protocol reduces double-execution to under 1% across all evaluated workloads.",
          "author": [
            { "@type": "Person", "name": "Dana Iyer" },
            { "@type": "Person", "name": "Yuki Tanaka" }
          ],
          "datePublished": "2026-04-30",
          "url": "https://openlab.example.net/papers/agent-checkpointing"
        }
        </script>
      </head><body>
        <main><h1>Agent checkpointing under partial network failure</h1></main>
      </body></html>`;

    const extracted = extractFromDOM(html, "scholarly paper about agent checkpointing");
    expect(extracted.data).toBeTruthy();
    const data = extracted.data as Record<string, unknown>;
    expect(String(data.title)).toContain("Agent checkpointing");
    expect(String(data.abstract)).toContain("two-phase log protocol");
    expect(Array.isArray(data.authors)).toBe(true);
    const authors = data.authors as string[];
    expect(authors.some((a) => a.includes("Iyer"))).toBe(true);
  });

  it("returns cleanly when no Highwire, no ScholarlyArticle JSON-LD, no abstract signal is present", () => {
    // Marketing page with NO scholarly signals. The primitive must not
    // invent a fake scholarly key-value row from unrelated DOM noise.
    const html = `<!doctype html><html><head>
        <title>Cool Startup Landing</title>
        <meta property="og:type" content="website" />
      </head><body>
        <main>
          <h1>Welcome</h1>
          <p>We sell pickles online. No papers. No abstracts.</p>
          <button>Buy now</button>
        </main>
      </body></html>`;

    const extracted = extractFromDOM(html, "arxiv abstract");
    expect(extracted).toBeTruthy();
    // The scholarly primitive must NOT have populated a fake key-value
    // row off of this page. If anything else extracted (metadata
    // fallback, etc.), that's fine — what we forbid is a spurious
    // title/abstract pair pretending to be a paper.
    if (extracted.data && typeof extracted.data === "object" && !Array.isArray(extracted.data)) {
      const data = extracted.data as Record<string, unknown>;
      if (typeof data.abstract === "string") {
        // If somehow an abstract field surfaced, it cannot reference
        // anything paper-shaped — there is no paper here.
        expect(data.abstract.length).toBeLessThan(40);
      }
    }
  });
});
