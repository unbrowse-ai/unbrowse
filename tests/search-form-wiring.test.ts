import { describe, expect, it } from "bun:test";
import { buildPageArtifactCapture } from "../src/execution/index.js";

describe("buildPageArtifactCapture search form wiring", () => {
  it("detects a search form in captured HTML and annotates the endpoint", () => {
    // HTML with both structured data (GitHub-style embedded JSON) and a search form
    const html = `
      <html><body>
        <form id="search-form" action="/search">
          <input type="text" name="q" placeholder="Search..." />
          <button type="submit">Search</button>
        </form>
        <script type="application/json" data-target="react-app.embeddedData">
          {"payload":{"results":[
            {"followers":10000,"language":"TypeScript","hl_trunc_description":"Official SDK","repo":{"repository":{"owner_login":"openai","name":"openai-node"}}},
            {"followers":25000,"language":"Python","hl_trunc_description":"Python SDK","repo":{"repository":{"owner_login":"openai","name":"openai-python"}}}
          ]}}
        </script>
      </body></html>
    `;

    const artifact = buildPageArtifactCapture(
      "https://github.com/search?q=openai&type=repositories",
      "search repositories",
      html,
    );

    // The endpoint should exist (DOM extraction succeeded)
    expect(artifact.endpoint).toBeDefined();

    // The search form should be detected and attached
    expect(artifact.search_form).toBeDefined();
    expect(artifact.search_form!.form_selector).toBe("form#search-form");
    expect(artifact.search_form!.fields.some((f) => f.name === "q")).toBe(true);
    expect(artifact.endpoint!.dom_extraction?.search_form).toBeDefined();
    expect(artifact.endpoint!.description).toContain("search form");
    // action_kind should be set to search
    expect(artifact.endpoint!.semantic?.action_kind).toBe("search");
    // Extraction metadata should flag search form
    const extraction = artifact.result?._extraction as Record<string, unknown>;
    expect(extraction.search_form_detected).toBe(true);
  });

  it("does not annotate search form when HTML has no forms", () => {
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

    const artifact = buildPageArtifactCapture(
      "https://github.com/search?q=openai&type=repositories",
      "search repositories",
      html,
    );

    expect(artifact.endpoint).toBeDefined();
    expect(artifact.search_form).toBeUndefined();
    expect(artifact.endpoint!.dom_extraction?.search_form).toBeUndefined();
    expect(artifact.endpoint!.description).not.toContain("search form");
  });
});
