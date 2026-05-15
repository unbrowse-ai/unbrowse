import { describe, expect, test } from "bun:test";
import { buildPageArtifactCapture } from "../src/execution/index.js";

describe("buildPageArtifactCapture", () => {
  test("strips self-referential url params from replayable page artifact endpoints", () => {
    const html = `
      <html><body>
        <main>
          <ul>
            <li>
              <a href="https://www.linkedin.com/in/jane-doe">Jane Doe</a>
              <div>PM at OpenAI</div>
            </li>
            <li>
              <a href="https://www.linkedin.com/in/john-smith">John Smith</a>
              <div>Engineer at Anthropic</div>
            </li>
          </ul>
        </main>
      </body></html>
    `;
    const out = buildPageArtifactCapture(
      "https://www.linkedin.com/search/results/people/?keywords=openai&url=https%3A%2F%2Fwww.linkedin.com%2Fsearch%2Fresults%2Fpeople%2F%3Fkeywords%3Dopenai&type=accounts",
      "search people",
      html,
      true,
    );
    expect(out.endpoint?.url_template).toBe("https://www.linkedin.com/search/results/people/?keywords={keywords}&type={type}");
    expect(out.endpoint?.query).toEqual({ keywords: "openai", type: "accounts" });
    expect(out.endpoint?.semantic?.example_request).toEqual({ keywords: "openai", type: "accounts" });
  });

  test("normalizes indexed query params on page artifact endpoints", () => {
    const html = `
      <html><body>
        <main>
          <ul>
            <li>
              <a href="https://www.linkedin.com/in/jane-doe">Jane Doe</a>
              <div>PM at OpenAI</div>
            </li>
            <li>
              <a href="https://www.linkedin.com/in/john-smith">John Smith</a>
              <div>Engineer at Anthropic</div>
            </li>
          </ul>
        </main>
      </body></html>
    `;
    const out = buildPageArtifactCapture(
      "https://www.linkedin.com/search/results/people/?filters[0][value]=sf&filters[1][value]=eng",
      "search people",
      html,
      false,
    );
    expect(out.endpoint?.url_template).toBe(
      "https://www.linkedin.com/search/results/people/?filters%5B0%5D%5Bvalue%5D={filters_0_value}&filters%5B1%5D%5Bvalue%5D={filters_1_value}",
    );
    expect(out.endpoint?.query).toEqual({
      "filters[0][value]": "sf",
      "filters[1][value]": "eng",
    });
    expect(out.endpoint?.semantic?.example_request).toEqual({
      "filters[0][value]": "sf",
      "filters[1][value]": "eng",
    });
  });
});
