import { describe, expect, test } from "bun:test";
import { templatizeQueryParams } from "../src/execution/index.js";

// Originally these asserted via buildPageArtifactCapture, but that function
// short-circuits to {} when extractFromDOM confidence <= 0.2 (the test HTML
// fixtures don't trip a high enough confidence). The templatization rule
// itself lives in templatizeQueryParams — test that directly. See contract
// 56a44529 for the drift rationale.
describe("templatizeQueryParams", () => {
  test("strips self-referential url params and templates remaining keys", () => {
    const out = templatizeQueryParams(
      "https://www.linkedin.com/search/results/people/?keywords=openai&url=https%3A%2F%2Fwww.linkedin.com%2Fsearch%2Fresults%2Fpeople%2F%3Fkeywords%3Dopenai&type=accounts",
    );
    expect(out).toBe(
      "https://www.linkedin.com/search/results/people/?keywords={keywords}&type={type}",
    );
  });

  test("normalizes indexed query param keys (filters[0][value]) to underscore-safe binding names", () => {
    const out = templatizeQueryParams(
      "https://www.linkedin.com/search/results/people/?filters[0][value]=sf&filters[1][value]=eng",
    );
    expect(out).toBe(
      "https://www.linkedin.com/search/results/people/?filters%5B0%5D%5Bvalue%5D={filters_0_value}&filters%5B1%5D%5Bvalue%5D={filters_1_value}",
    );
  });
});
