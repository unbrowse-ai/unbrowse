import { describe, expect, it } from "bun:test";
import { buildPageArtifactCapture, projectResultForIntent } from "../src/execution/index.js";
import { extractFromDOMWithHint } from "../src/extraction/index.js";

describe("skill generation root cause", () => {
  const hintedHtml = `
    <html><body>
      <div class="person-card result">
        <strong>Sam Altman</strong>
        <p>CEO at OpenAI</p>
      </div>
      <div class="person-card result">
        <strong>Greg Brockman</strong>
        <p>President at OpenAI</p>
      </div>
      <div class="person-card result">
        <strong>Kevin Weil</strong>
        <p>Chief Product Officer</p>
      </div>
    </body></html>
  `;

  it("stores replay hints and semantic metadata on page-artifact skills", () => {
    const artifact = buildPageArtifactCapture(
      "https://example.com/search/people?keywords=openai",
      "search people",
      hintedHtml,
      true,
    );
    expect(artifact.endpoint?.dom_extraction?.selector).toBeTruthy();
    expect(artifact.endpoint?.response_schema?.type).toBe("array");
    expect(artifact.endpoint?.semantic?.resource_kind).toBe("person");
    expect(artifact.endpoint?.semantic?.example_response_compact).toBeTruthy();
    expect(artifact.endpoint?.semantic?.auth_required).toBe(true);
  });

  it("replays extraction from stored selector hints", () => {
    const hinted = extractFromDOMWithHint(hintedHtml, "search people", { selector: "div.person-card.result" });
    expect(Array.isArray(hinted.data)).toBe(true);
    expect(hinted.selector).toBe("div.person-card.result");
  });

  it("projects wrapped page-artifact payloads to direct records", () => {
    const projected = projectResultForIntent({
      data: [
        { name: "Sam Altman", public_identifier: "sam-altman" },
        { name: "Greg Brockman", public_identifier: "greg-brockman" },
      ],
      _extraction: { source: "rendered-dom", selector: "div.person-card.result" },
    }, "search people");
    expect(Array.isArray(projected)).toBe(true);
    expect((projected as Array<Record<string, string>>)[0]?.name).toBe("Sam Altman");
  });
});
