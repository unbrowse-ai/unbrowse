import { describe, expect, test } from "bun:test";
import { scanBundlesForRoutes } from "../src/reverse-engineer/bundle-scanner.js";

describe("scanBundlesForRoutes", () => {
  test("drops auth and settings bundle routes from public root captures", () => {
    const routes = scanBundlesForRoutes(new Map([
      [
        "https://example.com/app.js",
        [
          "fetch('/manage/account/webauthn-provision/options')",
          "fetch('/settings')",
          "fetch('/org/create?track=homepage')",
          "fetch('/api/search?q=openai')",
          "fetch('/v2/packages/list')",
        ].join(";\n"),
      ],
    ]), "https://example.com");

    const paths = routes.map((route) => route.path);
    expect(paths).toContain("/api/search");
    expect(paths).toContain("/v2/packages/list");
    expect(paths).not.toContain("/manage/account/webauthn-provision/options");
    expect(paths).not.toContain("/settings");
    expect(paths).not.toContain("/org/create");
  });

  test("keeps public account-search APIs that happen to contain account nouns", () => {
    const routes = scanBundlesForRoutes(new Map([
      [
        "https://example.com/mastodon.js",
        "fetch('/api/v1/accounts/search?q=openai')",
      ],
    ]), "https://mastodon.social");

    expect(routes.map((route) => route.path)).toContain("/api/v1/accounts/search");
  });
});
