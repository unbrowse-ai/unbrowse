import { describe, expect, test } from "bun:test";
import { extractFromDOM, extractFromDOMWithHint } from "../src/extraction/index.js";

describe("intent-specific DOM extraction", () => {
  test("extracts post rows from social-style articles", () => {
    const html = `
      <html><body><main>
        <article><a href="/@alice/123">alice</a><p>OpenAI shipped a new thing today.</p></article>
        <article><a href="/@bob/456">bob</a><p>This is a second post body for ranking.</p></article>
      </main></body></html>
    `;
    const extracted = extractFromDOM(html, "search posts");
    expect(Array.isArray(extracted.data)).toBe(true);
    expect((extracted.data as Array<Record<string, string>>)[0]?.username).toBe("alice");
  });

  test("extracts topic rows from trending-style anchors", () => {
    const html = `
      <html><body><main>
        <section><div>Trending now <a href="/search?q=%23OpenAI">#OpenAI</a></div></section>
        <section><div>Trending now <a href="/search?q=%23Agents">#Agents</a></div></section>
      </main></body></html>
    `;
    const extracted = extractFromDOM(html, "get trending topics");
    expect(Array.isArray(extracted.data)).toBe(true);
    expect((extracted.data as Array<Record<string, string>>).length).toBeGreaterThan(1);
  });

  test("falls back from bad selector hints when fresh extraction matches intent better", () => {
    const html = `
      <html><body><main>
        <div class="bad-card"><a href="/users/openai">OpenAI</a></div>
        <article><a href="/@alice/123">alice</a><p>OpenAI shipped a new thing today.</p></article>
        <article><a href="/@bob/456">bob</a><p>This is a second post body for ranking.</p></article>
      </main></body></html>
    `;
    const extracted = extractFromDOMWithHint(html, "search posts", { selector: ".bad-card" });
    expect(Array.isArray(extracted.data)).toBe(true);
    expect((extracted.data as Array<Record<string, string>>)[0]?.username).toBe("alice");
  });

  test("extracts x profile rows from meta tags", () => {
    const html = `
      <html>
        <head>
          <title>OpenAI (@OpenAI) / X</title>
          <meta property="og:title" content="OpenAI (@OpenAI) / X" />
          <meta name="description" content="OpenAI is an AI research and deployment company." />
          <link rel="canonical" href="https://x.com/OpenAI" />
        </head>
        <body><main></main></body>
      </html>
    `;
    const extracted = extractFromDOM(html, "get user profile");
    expect(extracted.extraction_method).toBe("key-value");
    expect((extracted.data as Record<string, string>)?.username).toBe("OpenAI");
    expect((extracted.data as Record<string, string>)?.name).toBe("OpenAI");
  });
});
