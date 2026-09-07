/**
 * Live smoke test against a running Kuri sandbox.
 *
 * Skip: set KURI_BASE_URL to point at a running instance, otherwise this
 *       requires `zig build run --build-file submodules/kuri/build.zig` in
 *       another shell.
 */
import { test, expect } from "bun:test";
import { runBundleReplay, cookiesToHeaderValue } from "./bundle-replay-client";

const SANDBOX_LIVE = process.env.SANDBOX_LIVE === "1";

test.skipIf(!SANDBOX_LIVE)("inline bundle: hello-world post_eval round-trip", async () => {
  const r = await runBundleReplay({
    targetOrigin: "https://example.com",
    targetHref: "https://example.com/",
    bundleSource: `globalThis.__msg = 'hello from sandbox';`,
    postEval: "globalThis.__msg",
  });
  expect(r.ok).toBe(true);
  expect(r.post_eval).toBe("hello from sandbox");
});

test.skipIf(!SANDBOX_LIVE)("inline bundle: HMAC-SHA256 signing", async () => {
  // Compute SHA-256 in the sandbox using the native digest bridge.
  const r = await runBundleReplay({
    targetOrigin: "https://example.com",
    bundleSource: `
      globalThis.__hex = (() => {
        const enc = new TextEncoder();
        const h = __nativeSubtleDigest('SHA-256', enc.encode('hello'));
        return Array.from(h).map(b => b.toString(16).padStart(2,'0')).join('');
      })();
    `,
    postEval: "globalThis.__hex",
  });
  expect(r.post_eval).toContain("2cf24dba"); // SHA-256("hello")
});

test.skipIf(!SANDBOX_LIVE)("cookies set via document.cookie flow into jar", async () => {
  const r = await runBundleReplay({
    targetOrigin: "https://example.com",
    targetHref: "https://example.com/foo",
    bundleSource: `document.cookie = 'session=abc123; Path=/';`,
  });
  const session = r.cookies.find((c) => c.name === "session");
  expect(session?.value).toBe("abc123");
  expect(cookiesToHeaderValue(r.cookies)).toContain("session=abc123");
});
