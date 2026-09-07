/**
 * GATE: the JS-challenge rung is optional, honest, and correctly shaped.
 *
 * The rung exists because the impersonate rungs cannot reach the JS-challenge
 * class — measured: 18/100 corpus sites are blocked to both plain HTTP and
 * obscura (bench/sites100/CHALLENGE-RATE-FINDINGS.md).
 *
 * The properties that matter are the degradation ones. An uninstalled patchright
 * must be a SKIP (null → the ladder advances), never a throw and never a fake
 * result; and a headless fallback must never be silently substituted for headed,
 * because that would report a block that is really our own fingerprint.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseHelperOutput,
  buildHelperArgs,
  helperPath,
  tryPatchrightFetch,
} from "../src/capture/patchright-fetch.js";

describe("parseHelperOutput", () => {
  test("a real page parses into a result", () => {
    const got = parseHelperOutput(JSON.stringify({ ok: true, status: 200, html: "<html>hi</html>", bytes: 15 }));
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.result.status).toBe(200);
      expect(got.result.html).toContain("hi");
      expect(got.result.bytes).toBe(15);
    }
  });

  test("a missing install is a NAMED reason, not a crash", () => {
    const got = parseHelperOutput(JSON.stringify({ ok: false, error: "patchright_not_installed", hint: "pip install patchright" }));
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.reason).toBe("patchright_not_installed");
      expect(got.hint).toContain("pip install");
    }
  });

  test("a headless-refusal is surfaced rather than silently downgraded", () => {
    const got = parseHelperOutput(JSON.stringify({ ok: false, error: "no_display_for_headed" }));
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("no_display_for_headed");
  });

  test("garbage output is unparsable, never a fake success", () => {
    expect(parseHelperOutput("not json").ok).toBe(false);
    expect(parseHelperOutput("").ok).toBe(false);
  });

  test("bytes are derived when the helper omits them", () => {
    const got = parseHelperOutput(JSON.stringify({ ok: true, status: 200, html: "abcd" }));
    if (got.ok) expect(got.result.bytes).toBe(4);
  });
});

describe("buildHelperArgs", () => {
  test("threads timeout and proxy", () => {
    const a = buildHelperArgs("/h.py", { url: "https://x.test/", timeoutMs: 9000, proxy: "http://p:1" });
    expect(a.slice(0, 2)).toEqual(["/h.py", "https://x.test/"]);
    expect(a).toContain("--timeout-ms"); expect(a).toContain("9000");
    expect(a).toContain("--proxy");      expect(a).toContain("http://p:1");
  });
  test("cookies ride as JSON, never shell-quoted", () => {
    const a = buildHelperArgs("/h.py", { url: "https://x.test/", cookies: [{ name: "s", value: "v'; rm -rf /" }] });
    const jar = a[a.indexOf("--cookies") + 1];
    expect(JSON.parse(jar)[0].value).toBe("v'; rm -rf /");
  });
  test("omits --cookies when there are none", () => {
    expect(buildHelperArgs("/h.py", { url: "https://x.test/" })).not.toContain("--cookies");
  });
});

describe("tryPatchrightFetch degradation", () => {
  test("no python => null (a skip), not a throw", async () => {
    const got = await tryPatchrightFetch({ url: "https://x.test/", pythonResolver: async () => null });
    expect(got).toBeNull();
  });

  test("helper refusing to run => null, so the ladder simply advances", async () => {
    const got = await tryPatchrightFetch({
      url: "https://x.test/",
      pythonResolver: async () => "/usr/bin/python3",
      runner: async () => JSON.stringify({ ok: false, error: "patchright_not_installed" }),
    });
    expect(got).toBeNull();
  });

  test("a runner that throws => null, never propagates", async () => {
    const got = await tryPatchrightFetch({
      url: "https://x.test/",
      pythonResolver: async () => "/usr/bin/python3",
      runner: async () => { throw new Error("boom"); },
    });
    expect(got).toBeNull();
  });

  test("a real page comes back as a result", async () => {
    const got = await tryPatchrightFetch({
      url: "https://x.test/",
      pythonResolver: async () => "/usr/bin/python3",
      runner: async () => JSON.stringify({ ok: true, status: 200, html: "<html>real</html>", bytes: 17 }),
    });
    expect(got?.status).toBe(200);
    expect(got?.html).toContain("real");
  });
});

describe("the shipped helper", () => {
  test("exists and never silently degrades headed->headless", () => {
    const p = helperPath();
    expect(p).not.toBeNull();
    const src = readFileSync(p!, "utf8");
    // headless is only ever mentioned as a refusal reason, never as a launch arg
    expect(src).toContain('"headless": False');
    expect(src).toContain("no_display_for_headed");
    expect(src).not.toContain('"headless": True');
  });
});
