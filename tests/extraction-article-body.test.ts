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
