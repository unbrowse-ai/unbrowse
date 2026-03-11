import { describe, expect, it } from "bun:test";
import { buildPageArtifactCapture, projectResultForIntent } from "../src/execution/index.js";
import { deriveTemplateParamsFromContextUrl, mergeContextTemplateParams, normalizeQueryBindingKey } from "../src/template-params.js";

describe("root runtime regressions", () => {
  it("hydrates templated path params from context url", () => {
    const inferred = deriveTemplateParamsFromContextUrl(
      "https://www.linkedin.com/search/{search}/{slug}/?keywords={keywords}",
      "https://www.linkedin.com/search/results/people/?keywords=openai",
    );
    expect(inferred).toEqual({
      search: "results",
      slug: "people",
      keywords: "openai",
    });
  });

  it("merges context-derived params without overwriting explicit params", () => {
    const merged = mergeContextTemplateParams(
      { keywords: "anthropic" },
      "https://www.linkedin.com/search/{search}/{slug}/?keywords={keywords}",
      "https://www.linkedin.com/search/results/people/?keywords=openai",
    );
    expect(merged).toEqual({
      search: "results",
      slug: "people",
      keywords: "anthropic",
    });
  });

  it("normalizes indexed query keys into stable binding names", () => {
    expect(normalizeQueryBindingKey("filters[0][value]")).toBe("filters_0_value");
    expect(normalizeQueryBindingKey("filters[1][field]")).toBe("filters_1_field");
    expect(normalizeQueryBindingKey("tags[]")).toBe("tags_item");
  });

  it("aliases raw indexed params onto templated query bindings", () => {
    const merged = mergeContextTemplateParams(
      { "filters[0][value]": "sf", "filters[1][value]": "eng" },
      "https://example.com/jobs?filters%5B0%5D%5Bvalue%5D={filters_0_value}&filters%5B1%5D%5Bvalue%5D={filters_1_value}",
      undefined,
    );
    expect(merged).toEqual({
      "filters[0][value]": "sf",
      "filters[1][value]": "eng",
      filters_0_value: "sf",
      filters_1_value: "eng",
    });
  });

  it("hydrates indexed query bindings from context url", () => {
    const inferred = deriveTemplateParamsFromContextUrl(
      "https://example.com/jobs?filters%5B0%5D%5Bvalue%5D={filters_0_value}&filters%5B1%5D%5Bvalue%5D={filters_1_value}",
      "https://example.com/jobs?filters[0][value]=sf&filters[1][value]=eng",
    );
    expect(inferred).toEqual({
      filters_0_value: "sf",
      filters_1_value: "eng",
    });
  });

  it("unwraps extracted payload wrappers before intent projection", () => {
    const projected = projectResultForIntent({
      data: [
        { name: "Sam Altman", public_identifier: "samaltman", headline: "CEO" },
      ],
      _extraction: { source: "rendered-dom", confidence: 0.9 },
    }, "search people");
    expect(projected).toEqual([
      { name: "Sam Altman", public_identifier: "samaltman", headline: "CEO" },
    ]);
  });

  it("builds a valid page-artifact endpoint from server-rendered package search pages", () => {
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

    const built = buildPageArtifactCapture(
      "https://pypi.org/search/?q=openai",
      "search packages",
      html,
    );

    expect(built.endpoint?.description).toBe("Captured page artifact for search packages");
    expect(Array.isArray((built.result?.data as Array<Record<string, unknown>>))).toBe(true);
    expect((built.result?.data as Array<Record<string, unknown>>)[0]?.name).toBe("openai");
  });
});
