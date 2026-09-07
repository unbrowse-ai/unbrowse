// Witness for the proxy-default fix (2026-06-20):
//   1. The browser NEVER launches with the broken `--proxy-server=per-context`
//      literal (standard Chrome treats it as a real proxy host and fails every
//      navigation with ERR_PROXY_CONNECTION_FAILED when the context has no proxy).
//   2. The browser default is RAW (no --proxy-server flag) — a connection that works.
//   3. A real proxy URL is still honored verbatim.
//   4. The egress proxy is a health-gated ladder: try proxy, but fall back to RAW
//      automatically when the proxy is in a structural-failure cooldown (proxy died).
//
// Run: bun test tests/proxy-defaults.test.ts
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChromeArgs } from "../src/cdp/chrome.js";
import { resolveEgressProxy } from "../src/execution/proxy-fetch.js";
import { recordFailure } from "../src/values/failure-cache.js";

const BASE = { headless: true, userDataDir: "/tmp/x" };

describe("browser proxy defaults", () => {
  test("never emits the broken per-context literal", () => {
    for (const opts of [
      BASE,
      { ...BASE, perContextProxy: true },
      { ...BASE, perContextProxy: undefined },
    ]) {
      const args = buildChromeArgs(opts);
      expect(args.some((a) => a.includes("per-context"))).toBe(false);
    }
  });

  test("default is RAW — no --proxy-server flag at all", () => {
    const args = buildChromeArgs(BASE);
    expect(args.some((a) => a.startsWith("--proxy-server"))).toBe(false);
  });

  test("a real proxy URL is honored verbatim", () => {
    const args = buildChromeArgs({ ...BASE, proxy: "http://real.example:3128" });
    expect(args).toContain("--proxy-server=http://real.example:3128");
  });
});

describe("egress proxy ladder: proxy, then raw if proxy died", () => {
  let dir: string;
  const env = {
    IPROYAL_USER: "u",
    IPROYAL_PASS: "p",
    IPROYAL_HOST: "geo.iproyal.com",
    IPROYAL_PORT: "12321",
  } as unknown as NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fc-"));
  });

  test("uses the iproyal proxy when healthy (no recorded failure)", () => {
    const url = resolveEgressProxy(env, dir);
    expect(url).toContain("geo.iproyal.com:12321");
  });

  test("falls back to RAW when the proxy is in a structural cooldown", () => {
    // proxy died -> a structural failure was recorded against it
    recordFailure("http://geo.iproyal.com:12321", "structural", "proxy", dir);
    const url = resolveEgressProxy(env, dir);
    expect(url).toBeUndefined();
  });
});
