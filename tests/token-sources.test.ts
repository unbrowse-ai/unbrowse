import { describe, expect, test } from "bun:test";
import { findTokenSources, extractTokenFromHtml, extractTokenFromBundle } from "../src/reverse-engineer/token-sources.js";

const RAILS_TOKEN = "K7LxVhPqN9mW2sR4tB8cF3yZ6aE1dG5uJ";

describe("findTokenSources - HTML meta", () => {
  test("finds rails-style csrf-token meta tag", () => {
    const html = `<!doctype html><html><head>
      <meta charset="utf-8">
      <meta name="csrf-token" content="${RAILS_TOKEN}">
      <meta name="csrf-param" content="authenticity_token">
    </head><body></body></html>`;
    const sources = findTokenSources(RAILS_TOKEN, html);
    expect(sources.length).toBeGreaterThan(0);
    const meta = sources.find((s) => s.kind === "html-meta");
    expect(meta).toBeDefined();
    expect(meta?.meta_name).toBe("csrf-token");
    expect(meta?.meta_attr).toBe("content");
  });

  test("finds meta tag with property attr and value attr", () => {
    const html = `<meta property="session-token" value="${RAILS_TOKEN}">`;
    const sources = findTokenSources(RAILS_TOKEN, html);
    const meta = sources.find((s) => s.kind === "html-meta");
    expect(meta).toBeDefined();
    expect(meta?.meta_name).toBe("session-token");
    expect(meta?.meta_attr).toBe("value");
  });

  test("extractTokenFromHtml round-trips a rotated value", () => {
    const rotated = "R0T4TeDvalu3SeeD1987xyzFreshToken";
    const html = `<html><head><meta name="csrf-token" content="${rotated}"></head></html>`;
    const sources = findTokenSources(RAILS_TOKEN, `<html><head><meta name="csrf-token" content="${RAILS_TOKEN}"></head></html>`);
    const metaSrc = sources.find((s) => s.kind === "html-meta")!;
    expect(extractTokenFromHtml(metaSrc, html)).toBe(rotated);
  });
});

describe("findTokenSources - inline <script>", () => {
  test("finds token in window.__INITIAL_STATE__ hydration blob", () => {
    const token = "hydr4t3dJsonTokenVal789xyzABCDef";
    const html = `<html><body>
      <div id="app"></div>
      <script>window.__INITIAL_STATE__ = {"user":{"id":42},"csrfToken":"${token}","flags":[]}</script>
    </body></html>`;
    const sources = findTokenSources(token, html);
    const inline = sources.find((s) => s.kind === "html-inline-script");
    expect(inline).toBeDefined();
    expect(inline?.inline_script_regex).toBeDefined();

    // Round-trip against a page where the token has rotated
    const rotated = "Rotat3dJsonTokenVal999xyzFreshHYD";
    const rotatedHtml = html.replace(token, rotated);
    expect(extractTokenFromHtml(inline!, rotatedHtml)).toBe(rotated);
  });

  test("finds token in var assignment", () => {
    const token = "VarAsgnTokenValue1234567890ABCdef";
    const html = `<script>var authToken = "${token}"; var other = 1;</script>`;
    const sources = findTokenSources(token, html);
    const inline = sources.find((s) => s.kind === "html-inline-script");
    expect(inline).toBeDefined();
    const rotated = "VarRotatedFreshTokenXYZvalue00009";
    const rotatedHtml = `<script>var authToken = "${rotated}"; var other = 1;</script>`;
    expect(extractTokenFromHtml(inline!, rotatedHtml)).toBe(rotated);
  });
});

describe("findTokenSources - JS bundles", () => {
  test("finds bearer token literal in JS bundle", () => {
    const bearer = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
    const bundleContent = `
      !function(e){var t={};function n(o){if(t[o])return t[o].exports;}
      const BEARER_TOKEN="${bearer}";
      module.exports={api:BEARER_TOKEN};
    `;
    const bundles = new Map([
      ["https://abs.x.com/assets/main.a1b2c3d4.js", bundleContent],
    ]);
    const sources = findTokenSources(bearer, undefined, bundles);
    const bundle = sources.find((s) => s.kind === "js-bundle");
    expect(bundle).toBeDefined();
    expect(bundle?.bundle_url_pattern).toContain("main");
    expect(bundle?.bundle_regex).toBeDefined();

    const rotatedBearer = "AAAAAAAAAAAAAAAAAAAAANEWTOKEN888AAnNwIzUejRCOuH5E6I8xnZz4puTs%3DNEWnewNEWnewNEWnewNEWnewNEWnewNEW";
    const rotatedContent = bundleContent.replace(bearer, rotatedBearer);
    expect(extractTokenFromBundle(bundle!, rotatedContent)).toBe(rotatedBearer);
  });
});

describe("findTokenSources - edge cases", () => {
  test("rejects tokens shorter than minimum length", () => {
    const html = `<meta name="csrf-token" content="abc123">`;
    expect(findTokenSources("abc123", html)).toEqual([]);
  });

  test("returns empty when token not present in html or bundles", () => {
    const html = `<html><head></head><body>hello</body></html>`;
    expect(findTokenSources(RAILS_TOKEN, html)).toEqual([]);
  });

  test("dedupes identical sources", () => {
    const html = `<meta name="csrf-token" content="${RAILS_TOKEN}"><meta name="csrf-token" content="${RAILS_TOKEN}">`;
    const sources = findTokenSources(RAILS_TOKEN, html);
    const metaSources = sources.filter((s) => s.kind === "html-meta");
    expect(metaSources.length).toBe(1);
  });
});
