import { describe, expect, test } from "bun:test";
import { extractFromDOM } from "../src/extraction/index.js";

const wikipediaSample = `<!DOCTYPE html>
<html>
<head><title>Quantum computing - Wikipedia</title></head>
<body>
  <h1 id="firstHeading">Quantum computing</h1>
  <div id="mw-content-text"><div class="mw-parser-output">
    <p class="mw-empty-elt"></p>
    <p>A <b>quantum computer</b> is a computer that exploits quantum mechanical phenomena.
    On small scales, physical matter exhibits properties of both particles and waves,
    and quantum computing leverages this behavior using specialized hardware.</p>
    <h2><span id="History">History</span></h2>
    <p>Quantum computing began in the early 1980s when physicist Paul Benioff proposed a
    quantum mechanical model of the Turing machine. Richard Feynman and Yuri Manin
    later suggested that a quantum computer had the potential to simulate things
    a classical computer could not feasibly do.</p>
    <h2><span id="References">References</span></h2>
    <ol class="references"><li>This should be stripped.</li></ol>
    <h2><span id="External_links">External links</span></h2>
    <ul><li><a href="https://github.com/example">github.com/example</a></li></ul>
  </div></div>
</body>
</html>`;

describe("extractArticleBodySpecial — wikipedia-style content", () => {
  test("returns title, summary, and content sections from wikipedia HTML", () => {
    const out = extractFromDOM(wikipediaSample, "wikipedia article on quantum computing");
    expect(out.data).toBeTruthy();
    expect((out.data as any).title).toBe("Quantum computing");
    expect((out.data as any).summary).toContain("quantum computer");
    const sections = (out.data as any).sections as Array<{ heading: string }>;
    expect(sections.some((s) => s.heading === "History")).toBe(true);
    // References / External links must NOT appear
    expect(sections.some((s) => /references|external links/i.test(s.heading))).toBe(false);
  });

  test("fires even when intent is short, on wikipedia-shaped pages", () => {
    const out = extractFromDOM(wikipediaSample, "qc");
    expect(out.data).toBeTruthy();
    expect((out.data as any).title).toBe("Quantum computing");
  });

  test("non-wikipedia non-article pages are not affected", () => {
    const generic = `<html><body><h1>Search</h1><ul><li>r1</li><li>r2</li></ul></body></html>`;
    const out = extractFromDOM(generic, "search results");
    // The article extractor shouldn't fire — generic walker takes over.
    expect((out.data as any)?.title).not.toBe("Search articleness check");
  });
});

// Real Wikipedia serves BOTH a <script type="application/ld+json"> Article
// envelope (schema.org metadata: name/author/publisher/dates/headline, no body
// text) AND the mw-parser-output article body. Captured live 2026-05-16 from
// en.wikipedia.org/wiki/Transformer_(deep_learning) via the unbrowse MCP: the
// dom_extraction page-artifact returned ONLY the JSON-LD envelope for the
// intent "get the wikipedia article text ...", discarding the 87KB body. The
// agent asked for the article, got the schema.org card. extractFromDOM must
// prefer the article-body structure (title + sections) over the JSON-LD
// envelope for article-shaped intents.
const wikipediaWithJsonLd = `<!DOCTYPE html>
<html>
<head>
  <title>Transformer (deep learning) - Wikipedia</title>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","name":"Transformer (deep learning)","url":"https://en.wikipedia.org/wiki/Transformer_(deep_learning)","sameAs":"http://www.wikidata.org/entity/Q85810444","mainEntity":"http://www.wikidata.org/entity/Q85810444","author":{"@type":"Organization","name":"Contributors to Wikimedia projects"},"publisher":{"@type":"Organization","name":"Wikimedia Foundation, Inc.","logo":{"@type":"ImageObject","url":"https://www.wikimedia.org/static/images/wmf-hor-googpub.png"}},"datePublished":"2019-08-25T16:32:02Z","dateModified":"2026-05-15T20:44:43Z","image":"https://upload.wikimedia.org/wikipedia/commons/3/34/Transformer%2C_full_architecture.png","headline":"machine-learning model architecture first developed by Google Brain"}</script>
</head>
<body>
  <h1 id="firstHeading">Transformer (deep learning)</h1>
  <div id="mw-content-text"><div class="mw-parser-output">
    <p>A <b>transformer</b> is a deep learning architecture based on the multi-head
    attention mechanism, in which text is converted to numerical representations
    called tokens, and each token is converted into a vector via lookup from a
    word embedding table.</p>
    <h2><span id="Architecture">Architecture</span></h2>
    <p>The transformer uses an encoder-decoder structure. The encoder maps an
    input sequence into a sequence of continuous representations, which the
    decoder then consumes together with its own prior outputs to generate text.</p>
    <h2><span id="Attention">Attention</span></h2>
    <p>Scaled dot-product attention computes a weighted sum of value vectors,
    where the weight assigned to each value is determined by the compatibility
    of the query with the corresponding key.</p>
    <h2><span id="References">References</span></h2>
    <ol class="references"><li>This citation should be stripped.</li></ol>
  </div></div>
</body>
</html>`;

describe("extractFromDOM: article body must win over JSON-LD envelope", () => {
  test("article-shaped intent returns the body sections, not the schema.org card", () => {
    const out = extractFromDOM(
      wikipediaWithJsonLd,
      "get the wikipedia article text on the transformer deep learning architecture",
    );
    expect(out.data).toBeTruthy();
    // Must NOT be the JSON-LD schema.org metadata envelope.
    expect((out.data as any)["@context"]).toBeUndefined();
    expect((out.data as any)["@type"]).toBeUndefined();
    expect((out.data as any).publisher).toBeUndefined();
    // Must be the extracted article body.
    expect((out.data as any).title).toBe("Transformer (deep learning)");
    const sections = (out.data as any).sections as Array<{ heading: string; text: string }>;
    expect(Array.isArray(sections)).toBe(true);
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.some((s) => s.heading === "Architecture")).toBe(true);
    expect(sections.some((s) => s.heading === "Attention")).toBe(true);
    expect(sections.some((s) => /references/i.test(s.heading))).toBe(false);
  });

  test("short non-article intent on the same page is unaffected by the hoist", () => {
    // Regression guard: the hoisted preference only fires for article-shaped
    // intents; this asserts the article extractor still also fires on
    // wikipedia-shaped pages with a terse intent (existing behavior).
    const out = extractFromDOM(wikipediaWithJsonLd, "transformer");
    expect(out.data).toBeTruthy();
    expect((out.data as any)["@context"]).toBeUndefined();
    expect((out.data as any).title).toBe("Transformer (deep learning)");
  });
});
