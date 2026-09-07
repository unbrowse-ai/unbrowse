import { describe, expect, test } from "bun:test";
import { materializeRealWorldCase } from "../evals/real-world-cases.js";

describe("materializeRealWorldCase", () => {
  test("materializes linkedin people search root into a real search URL", () => {
    const out = materializeRealWorldCase({
      id: "linkedin-search-people",
      domain: "linkedin.com",
      url: "https://www.linkedin.com",
      intent: "search people",
      auth: true,
      expected_fields: ["name", "headline"],
    });
    expect(out.url).toBe("https://www.linkedin.com/search/results/people/?keywords=openai");
  });

  test("materializes x root profile into a concrete profile URL", () => {
    const out = materializeRealWorldCase({
      id: "x-profile",
      domain: "x.com",
      url: "https://x.com",
      intent: "get user profile",
      auth: true,
      expected_fields: ["name", "username"],
    });
    expect(out.url).toBe("https://x.com/OpenAI");
  });

  test("keeps already-specific URLs unchanged", () => {
    const out = materializeRealWorldCase({
      id: "mastodon-search",
      domain: "mastodon.social",
      url: "https://mastodon.social/search?q=openai",
      intent: "search posts",
      auth: false,
      expected_fields: ["content"],
    });
    expect(out).toBeNull();
  });

  test("materializes npm package search root into a real search URL", () => {
    const out = materializeRealWorldCase({
      id: "npm-search-packages",
      domain: "npmjs.com",
      url: "https://www.npmjs.com",
      intent: "search packages",
      auth: false,
      expected_fields: ["name", "version"],
    });
    expect(out.url).toBe("https://www.npmjs.com/search?q=openai");
  });

  test("materializes PyPI package info root into a concrete project URL", () => {
    const out = materializeRealWorldCase({
      id: "pypi-package-info",
      domain: "pypi.org",
      url: "https://www.pypi.org",
      intent: "get package info",
      auth: false,
      expected_fields: ["name", "version"],
    });
    expect(out.url).toBe("https://pypi.org/project/openai/");
  });

  test("drops PyPI search from the public no-auth eval set", () => {
    const out = materializeRealWorldCase({
      id: "pypi-search-packages",
      domain: "pypi.org",
      url: "https://www.pypi.org",
      intent: "search packages",
      auth: false,
      expected_fields: ["name", "version"],
    });
    expect(out).toBeNull();
  });

  test("drops Mastodon public timeline from the public no-auth eval set", () => {
    const out = materializeRealWorldCase({
      id: "mastodon-public-timeline",
      domain: "mastodon.social",
      url: "https://mastodon.social",
      intent: "get public timeline",
      auth: false,
      expected_fields: ["content"],
    });
    expect(out).toBeNull();
  });

  test("materializes Docker Hub image tags root into a concrete repo tags URL", () => {
    const out = materializeRealWorldCase({
      id: "docker-tags",
      domain: "hub.docker.com",
      url: "https://hub.docker.com",
      intent: "get image tags",
      auth: false,
      expected_fields: ["name", "last_updated"],
    });
    expect(out.url).toBe("https://hub.docker.com/r/library/nginx/tags");
  });

  test("materializes GitLab project details root into a concrete project URL", () => {
    const out = materializeRealWorldCase({
      id: "gitlab-project-detail",
      domain: "gitlab.com",
      url: "https://www.gitlab.com",
      intent: "get project details",
      auth: false,
      expected_fields: ["name", "description"],
    });
    expect(out.url).toBe("https://gitlab.com/gitlab-org/gitlab");
  });
});
