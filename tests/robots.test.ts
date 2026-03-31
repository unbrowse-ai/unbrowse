import { describe, it, expect, beforeEach, mock } from "bun:test";
import { parseRobotsTxt, isAllowedByRobots, clearRobotsCache } from "../src/execution/robots.js";

describe("parseRobotsTxt", () => {
  it("parses a simple Disallow block", () => {
    const rules = parseRobotsTxt(`
User-agent: *
Disallow: /private/
`);
    expect(rules).toHaveLength(1);
    expect(rules[0].agents).toEqual(["*"]);
    expect(rules[0].disallow).toEqual(["/private/"]);
  });

  it("parses multiple agents in one block", () => {
    const rules = parseRobotsTxt(`
User-agent: googlebot
User-agent: unbrowse
Disallow: /admin/
`);
    expect(rules[0].agents).toEqual(["googlebot", "unbrowse"]);
    expect(rules[0].disallow).toEqual(["/admin/"]);
  });

  it("parses Allow directive", () => {
    const rules = parseRobotsTxt(`
User-agent: *
Disallow: /
Allow: /public/
`);
    expect(rules[0].allow).toEqual(["/public/"]);
  });

  it("ignores comments", () => {
    const rules = parseRobotsTxt(`
# This is a comment
User-agent: * # inline comment
Disallow: /secret/
`);
    expect(rules[0].disallow).toEqual(["/secret/"]);
  });

  it("handles empty robots.txt", () => {
    expect(parseRobotsTxt("")).toEqual([]);
  });

  it("respects blank-line group separator", () => {
    const rules = parseRobotsTxt(`
User-agent: googlebot
Disallow: /nogoogle/

User-agent: *
Disallow: /noone/
`);
    expect(rules).toHaveLength(2);
    expect(rules[0].agents).toEqual(["googlebot"]);
    expect(rules[1].agents).toEqual(["*"]);
  });
});

describe("isAllowedByRobots", () => {
  beforeEach(() => {
    clearRobotsCache();
  });

  it("allows everything when robots.txt returns 404", async () => {
    globalThis.fetch = mock(async () => new Response("", { status: 404 }));
    const allowed = await isAllowedByRobots("https://example.com/page");
    expect(allowed).toBe(true);
  });

  it("blocks a disallowed path", async () => {
    const body = `User-agent: *\nDisallow: /private/\n`;
    globalThis.fetch = mock(async () => new Response(body, { status: 200 }));
    const allowed = await isAllowedByRobots("https://example.com/private/data");
    expect(allowed).toBe(false);
  });

  it("allows a non-disallowed path", async () => {
    const body = `User-agent: *\nDisallow: /private/\n`;
    globalThis.fetch = mock(async () => new Response(body, { status: 200 }));
    const allowed = await isAllowedByRobots("https://example.com/public/data");
    expect(allowed).toBe(true);
  });

  it("Allow wins over Disallow when longer match", async () => {
    const body = `User-agent: *\nDisallow: /api/\nAllow: /api/public/\n`;
    globalThis.fetch = mock(async () => new Response(body, { status: 200 }));
    const blocked = await isAllowedByRobots("https://example.com/api/private");
    const allowed = await isAllowedByRobots("https://example.com/api/public/data");
    expect(blocked).toBe(false);
    expect(allowed).toBe(true);
  });

  it("unbrowse-specific rules override wildcard", async () => {
    const body = `User-agent: *\nAllow: /\n\nUser-agent: unbrowse\nDisallow: /nobot/\n`;
    globalThis.fetch = mock(async () => new Response(body, { status: 200 }));
    const allowed = await isAllowedByRobots("https://example.com/ok");
    const blocked = await isAllowedByRobots("https://example.com/nobot/page");
    expect(allowed).toBe(true);
    expect(blocked).toBe(false);
  });

  it("caches robots.txt and fetches only once per domain", async () => {
    const body = `User-agent: *\nDisallow: /x/\n`;
    let fetchCount = 0;
    globalThis.fetch = mock(async () => { fetchCount++; return new Response(body, { status: 200 }); });
    await isAllowedByRobots("https://cache-test.example.com/a");
    await isAllowedByRobots("https://cache-test.example.com/b");
    expect(fetchCount).toBe(1);
  });

  it("allows unparseable URLs", async () => {
    const allowed = await isAllowedByRobots("not-a-url");
    expect(allowed).toBe(true);
  });

  it("allows everything when fetch throws", async () => {
    globalThis.fetch = mock(async () => { throw new Error("network error"); });
    const allowed = await isAllowedByRobots("https://down.example.com/page");
    expect(allowed).toBe(true);
  });
});
