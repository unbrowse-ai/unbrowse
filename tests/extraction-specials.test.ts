import { describe, expect, it } from "bun:test";
import { extractFromDOM } from "../src/extraction/index.js";

describe("special HTML extraction", () => {
  it("extracts GitHub repository search rows from search-like html", () => {
    const html = `
      <html><body>
        <main>
          <div class="search-results-container">
            <div>
              <a href="/openai/openai-node">openai/openai-node</a>
              <p>Official JavaScript SDK</p>
              <span itemprop="programmingLanguage">TypeScript</span>
              <a href="/openai/openai-node/stargazers">10,000</a>
            </div>
            <div>
              <a href="/openai/openai-python">openai/openai-python</a>
              <p>Official Python SDK</p>
              <span itemprop="programmingLanguage">Python</span>
              <a href="/openai/openai-python/stargazers">25,000</a>
            </div>
          </div>
        </main>
      </body></html>
    `;

    const extracted = extractFromDOM(html, "search repositories");
    expect(extracted.extraction_method).toBe("repeated-elements");
    expect(Array.isArray(extracted.data)).toBe(true);
    expect((extracted.data as Array<Record<string, string>>)[0]?.full_name).toBe("openai/openai-node");
  });

  it("extracts GitHub repository rows from embedded search payload json", () => {
    const html = `
      <html><body>
        <script type="application/json" data-target="react-app.embeddedData">
          {"payload":{"results":[
            {"followers":10000,"language":"TypeScript","hl_trunc_description":"Official SDK","repo":{"repository":{"owner_login":"openai","name":"openai-node"}}},
            {"followers":25000,"language":"Python","hl_trunc_description":"Python SDK","repo":{"repository":{"owner_login":"openai","name":"openai-python"}}}
          ]}}
        </script>
      </body></html>
    `;

    const extracted = extractFromDOM(html, "search repositories");
    expect(extracted.extraction_method).toBe("repeated-elements");
    expect((extracted.data as Array<Record<string, string>>)[0]?.stargazers_count).toBe("10000");
  });

  it("extracts LinkedIn people-like rows from search html", () => {
    const html = `
      <html><body>
        <main>
          <ul>
            <li>
              <a href="https://www.linkedin.com/in/sam-altman/">Sam Altman</a>
              <div>CEO at OpenAI</div>
            </li>
            <li>
              <a href="https://www.linkedin.com/in/greg-brockman/">Greg Brockman</a>
              <div>President at OpenAI</div>
            </li>
          </ul>
        </main>
      </body></html>
    `;

    const extracted = extractFromDOM(html, "search people");
    expect(extracted.extraction_method).toBe("repeated-elements");
    expect(Array.isArray(extracted.data)).toBe(true);
    expect((extracted.data as Array<Record<string, string>>)[0]?.headline).toContain("OpenAI");
  });

  it("extracts PyPI package rows from search html", () => {
    const html = `
      <html><body>
        <main>
          <a class="package-snippet" href="/project/openai/">
            <span class="package-snippet__name">openai</span>
            <span class="package-snippet__version">1.66.0</span>
            <p class="package-snippet__description">Python client for the OpenAI API</p>
          </a>
          <a class="package-snippet" href="/project/openai-agents/">
            <span class="package-snippet__name">openai-agents</span>
            <span class="package-snippet__version">0.1.0</span>
            <p class="package-snippet__description">Agents SDK</p>
          </a>
        </main>
      </body></html>
    `;

    const extracted = extractFromDOM(html, "search packages");
    expect(extracted.extraction_method).toBe("repeated-elements");
    expect(Array.isArray(extracted.data)).toBe(true);
    expect((extracted.data as Array<Record<string, string>>)[0]?.name).toBe("openai");
    expect((extracted.data as Array<Record<string, string>>)[0]?.version).toBe("1.66.0");
  });

  it("prefers rich question cards over sparse navigation chips", () => {
    const html = `
      <html><body>
        <main>
          <div class="tabs">
            <a href="/questions/tagged/javascript?tab=Newest">Newest</a>
            <a href="/questions/tagged/javascript?tab=Unanswered">Unanswered</a>
            <a href="/questions/tagged/javascript?tab=Bounties">Bounties</a>
            <a href="/questions/tagged/javascript?tab=Frequent">Frequent</a>
          </div>
          <div class="question-card result">
            <h2><a href="/questions/1/why-does-fetch-fail">Why does fetch fail here?</a></h2>
            <div class="question-summary">Browser request returns an empty body in production.</div>
            <span class="vote-count">10</span>
            <span class="answer-count">2 answers</span>
            <div class="author">alice</div>
          </div>
          <div class="question-card result">
            <h2><a href="/questions/2/how-do-i-parse-json">How do I parse JSON safely?</a></h2>
            <div class="question-summary">Looking for a safe parser pattern for malformed payloads.</div>
            <span class="score">7</span>
            <span class="answer-count">1 answer</span>
            <time>2026-03-09</time>
          </div>
        </main>
      </body></html>
    `;

    const extracted = extractFromDOM(html, "get tag questions");
    expect(extracted.extraction_method).toBe("repeated-elements");
    expect(Array.isArray(extracted.data)).toBe(true);
    expect((extracted.data as Array<Record<string, string>>)[0]?.title).toContain("fetch fail");
    expect((extracted.data as Array<Record<string, string>>)[0]?.score).toBe("10");
  });

  it("rejects sparse post-like chip rows in favor of richer records", () => {
    const html = `
      <html><body>
        <main>
          <div class="tag-cloud">
            <a href="/tags/js">javascript</a>
            <a href="/tags/html">html</a>
            <a href="/tags/css">css</a>
            <a href="/tags/dom">dom</a>
          </div>
          <article class="post-card result">
            <h2><a href="/posts/1">Portable stats</a></h2>
            <p>Deep dive into portable query planning.</p>
            <span class="author">beto</span>
            <span class="score">69</span>
          </article>
          <article class="post-card result">
            <h2><a href="/posts/2">S3 API compatibility is awesome</a></h2>
            <p>Using S3-compatible APIs across multiple clouds.</p>
            <span class="author">ruptwelve</span>
            <span class="score">2</span>
          </article>
        </main>
      </body></html>
    `;

    const extracted = extractFromDOM(html, "get posts");
    expect(extracted.extraction_method).toBe("repeated-elements");
    expect(Array.isArray(extracted.data)).toBe(true);
    expect((extracted.data as Array<Record<string, string>>)[0]?.title).toContain("Portable stats");
    expect((extracted.data as Array<Record<string, string>>)[0]?.author).toBe("beto");
  });

  it("extracts lobsters-style story links from /s/ urls", () => {
    const html = `
      <html><body>
        <main>
          <ol class="stories">
            <li class="story">
              <span class="score">69</span>
              <a class="u-url" href="/s/abc123/portable_stats">Portable stats</a>
              <span class="byline">beto</span>
            </li>
            <li class="story">
              <span class="score">12</span>
              <a class="u-url" href="/s/def456/http_apis">HTTP APIs are nice</a>
              <span class="byline">ruptwelve</span>
            </li>
          </ol>
        </main>
      </body></html>
    `;

    const extracted = extractFromDOM(html, "get posts");
    expect(extracted.extraction_method).toBe("repeated-elements");
    expect((extracted.data as Array<Record<string, string>>)[0]?.url).toBe("/s/abc123/portable_stats");
  });

  it("extracts single-page definitions", () => {
    const html = `
      <html><body>
        <main class="entry-body">
          <h1>agent</h1>
          <div class="definition">someone who acts for or represents another person or company</div>
        </main>
      </body></html>
    `;

    const extracted = extractFromDOM(html, "get definition");
    expect(extracted.extraction_method).toBe("key-value");
    expect((extracted.data as Record<string, string>).term).toBe("agent");
    expect((extracted.data as Record<string, string>).definition).toContain("represents another");
  });
});
