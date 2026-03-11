import { describe, expect, it } from "bun:test";
import { buildCanonicalDocumentEndpoint, deriveStructuredDataReplayCandidatesFromInputs, deriveStructuredDataReplayTemplate, deriveStructuredDataReplayUrl, isCanonicalReplayEndpoint } from "../src/execution/index.js";

describe("public structured replay urls", () => {
  it("rewrites npm search pages to the public search api", () => {
    expect(deriveStructuredDataReplayUrl("https://www.npmjs.com/search?q=openai")).toBe(
      "https://registry.npmjs.org/-/v1/search?text=openai&size=20",
    );
  });

  it("rewrites npm package pages to registry json", () => {
    expect(deriveStructuredDataReplayUrl("https://www.npmjs.com/package/openai")).toBe(
      "https://registry.npmjs.org/openai",
    );
  });

  it("rewrites PyPI project pages to package json", () => {
    expect(deriveStructuredDataReplayUrl("https://pypi.org/project/openai/")).toBe(
      "https://pypi.org/pypi/openai/json",
    );
  });

  it("rewrites Docker Hub search pages to the public search api", () => {
    expect(deriveStructuredDataReplayUrl("https://hub.docker.com/search?q=nginx")).toBe(
      "https://hub.docker.com/v2/search/repositories/?query=nginx&page_size=20",
    );
  });

  it("rewrites Docker Hub tag pages to the public tags api", () => {
    expect(deriveStructuredDataReplayUrl("https://hub.docker.com/r/library/nginx/tags")).toBe(
      "https://hub.docker.com/v2/repositories/library/nginx/tags/?page_size=25",
    );
  });

  it("rewrites GitLab explore pages to project search api", () => {
    expect(deriveStructuredDataReplayUrl("https://gitlab.com/explore/projects?name=openai")).toBe(
      "https://gitlab.com/api/v4/projects?search=openai&simple=true&per_page=20",
    );
  });

  it("rewrites GitHub search pages to repository search api", () => {
    expect(deriveStructuredDataReplayUrl("https://github.com/search?q=openai&type=repositories")).toBe(
      "https://api.github.com/search/repositories?q=openai&per_page=20",
    );
  });

  it("rewrites Hacker News search pages to Algolia search api", () => {
    expect(deriveStructuredDataReplayUrl("https://hn.algolia.com/?q=openai")).toBe(
      "https://hn.algolia.com/api/v1/search?query=openai&tags=story",
    );
  });

  it("rewrites Hugging Face model search pages to the public models api", () => {
    expect(deriveStructuredDataReplayUrl("https://huggingface.co/models?search=openai")).toBe(
      "https://huggingface.co/api/models?search=openai&limit=20",
    );
  });

  it("rewrites MDN search pages to the public docs search api", () => {
    expect(deriveStructuredDataReplayUrl("https://developer.mozilla.org/en-US/search?q=fetch")).toBe(
      "https://developer.mozilla.org/api/v1/search?q=fetch&page=1&page_size=20&locale=en-US",
    );
  });

  it("rewrites DEV tag pages to the public articles api", () => {
    expect(deriveStructuredDataReplayUrl("https://dev.to/t/javascript")).toBe(
      "https://dev.to/api/articles?tag=javascript&per_page=20",
    );
  });

  it("rewrites pub.dev package pages to the public package api", () => {
    expect(deriveStructuredDataReplayUrl("https://pub.dev/packages/http")).toBe(
      "https://pub.dev/api/packages/http",
    );
  });

  it("rewrites RubyGems gem pages to the public gem api", () => {
    expect(deriveStructuredDataReplayUrl("https://rubygems.org/gems/rails")).toBe(
      "https://rubygems.org/api/v1/gems/rails.json",
    );
  });

  it("rewrites Stack Overflow tag pages to the Stack Exchange api", () => {
    expect(deriveStructuredDataReplayUrl("https://stackoverflow.com/questions/tagged/javascript")).toBe(
      "https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=javascript&order=desc&sort=activity&pagesize=20&filter=default",
    );
  });

  it("rewrites Jmail search pages to the public email search api", () => {
    expect(deriveStructuredDataReplayUrl("https://jmail.world/search?q=clinton")).toBe(
      "https://jmail.world/api/emails/search?q=clinton&limit=50&page=1&source=all",
    );
  });

  it("rewrites Mastodon search pages to public search api", () => {
    expect(deriveStructuredDataReplayUrl("https://mastodon.social/search?q=openai")).toBe(
      "https://mastodon.social/api/v2/search?q=openai&resolve=false&type=statuses&limit=20",
    );
  });

  it("builds canonical replay endpoints with a generic replay template, not the page url", () => {
    const endpoint = buildCanonicalDocumentEndpoint("https://hn.algolia.com/?q=openai", "search hacker news");
    expect(endpoint?.url_template).toBe("https://hn.algolia.com/api/v1/search?query={q}&tags=story");
    expect(endpoint?.trigger_url).toBe("https://hn.algolia.com/?q=openai");
  });

  it("recognizes canonical replay endpoints from trigger urls", () => {
    expect(isCanonicalReplayEndpoint({
      method: "GET",
      url_template: "https://huggingface.co/api/models?search={search}&limit=20",
      trigger_url: "https://huggingface.co/models?search=openai",
    } as any)).toBe(true);
  });

  it("builds replay templates for blank public search pages so params can seed execution", () => {
    expect(deriveStructuredDataReplayTemplate("https://hn.algolia.com/")).toBe(
      "https://hn.algolia.com/api/v1/search?query={q}&tags=story",
    );
    expect(deriveStructuredDataReplayTemplate("https://www.npmjs.com/search")).toBe(
      "https://registry.npmjs.org/-/v1/search?text={q}&size=20",
    );
    expect(deriveStructuredDataReplayTemplate("https://github.com/search?type=repositories")).toBe(
      "https://api.github.com/search/repositories?q={q}&per_page=20",
    );
    expect(deriveStructuredDataReplayTemplate("https://developer.mozilla.org/en-US/search")).toBe(
      "https://developer.mozilla.org/api/v1/search?q={q}&page=1&page_size=20&locale=en-US",
    );
    expect(deriveStructuredDataReplayTemplate("https://jmail.world/search")).toBe(
      "https://jmail.world/api/emails/search?q={q}&limit={limit}&page={page}&source={source}",
    );
  });

  it("materializes concrete replay urls from blank public search pages plus params", () => {
    expect(deriveStructuredDataReplayCandidatesFromInputs("https://hn.algolia.com/", { q: "openai" })).toContain(
      "https://hn.algolia.com/api/v1/search?query=openai&tags=story",
    );
    expect(deriveStructuredDataReplayCandidatesFromInputs("https://www.npmjs.com/search", { q: "openai" })).toContain(
      "https://registry.npmjs.org/-/v1/search?text=openai&size=20",
    );
    expect(deriveStructuredDataReplayCandidatesFromInputs("https://github.com/search?type=repositories", { q: "openai" })).toContain(
      "https://api.github.com/search/repositories?q=openai&per_page=20",
    );
    expect(deriveStructuredDataReplayCandidatesFromInputs("https://developer.mozilla.org/en-US/search", { q: "fetch" })).toContain(
      "https://developer.mozilla.org/api/v1/search?q=fetch&page=1&page_size=20&locale=en-US",
    );
    expect(deriveStructuredDataReplayCandidatesFromInputs("https://jmail.world/search", { q: "clinton", limit: 50, page: 1, source: "all" })).toContain(
      "https://jmail.world/api/emails/search?q=clinton&limit=50&page=1&source=all",
    );
  });
});
