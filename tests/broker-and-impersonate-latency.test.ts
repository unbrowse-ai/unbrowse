import { describe, expect, it, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as kuri from "../src/kuri/client.js";
import {
  resolveCurlImpersonatePython,
  resetCurlImpersonateProbe,
  tryCurlImpersonateFetch,
} from "../src/capture/curl-impersonate-fallback.js";

/**
 * Two ladder rungs that failed slowly and silently, both found on a live run.
 *
 * The TLS-impersonation rung resolved its python helper against `process.cwd()`,
 * so it only ever worked when the CLI was invoked from the repo root; from
 * anywhere else — which includes every npm install — it handed python a path
 * that does not exist and returned null, indistinguishable from "the site
 * blocked us".
 *
 * The broker reuse probe ran /discover + /tabs on the 30s OPERATION timeout even
 * though it was only deciding "can I reuse this?", so a foreign broker that
 * never answered cost 30 seconds before we spawned our own anyway.
 */
describe("impersonation rung resolves its helper independently of cwd", () => {
  const originalCwd = process.cwd();
  const originalPython = process.env.UNBROWSE_PYTHON;
  let scratch: string | null = null;

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalPython === undefined) delete process.env.UNBROWSE_PYTHON;
    else process.env.UNBROWSE_PYTHON = originalPython;
    resetCurlImpersonateProbe();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  });

  /**
   * Stand-in interpreter: succeeds the `import curl_cffi` probe, and for a real
   * call REFUSES a helper path that does not exist — exactly as python would.
   * That refusal is what makes this a falsifier rather than a tautology.
   */
  function fakePython(dir: string): string {
    const bin = join(dir, "fake-python");
    writeFileSync(
      bin,
      `#!/bin/sh
if [ "$1" = "-c" ]; then exit 0; fi
if [ ! -f "$1" ]; then exit 3; fi
echo '{"status":200,"bytes":5,"html_b64":"aGVsbG8=","final_url":"https://example.test/","proxy_used":false,"impersonate":"chrome131"}'
`,
      { mode: 0o755 },
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  it("finds the helper when the process runs from an unrelated directory", async () => {
    scratch = mkdtempSync(join(tmpdir(), "unbrowse-imp-"));
    process.env.UNBROWSE_PYTHON = fakePython(scratch);
    resetCurlImpersonateProbe();
    // No scripts/ directory here — the pre-fix cwd-relative lookup resolves to a
    // missing file and the fake interpreter exits 3.
    process.chdir(scratch);

    const result = await tryCurlImpersonateFetch({
      url: "https://example.test/",
      impersonate: "chrome131",
      timeoutMs: 10_000,
      forceDirect: true,
    });

    expect(result).not.toBeNull();
    expect(result?.status).toBe(200);
  });

  it("reports an interpreter only when it can actually import curl_cffi", async () => {
    scratch = mkdtempSync(join(tmpdir(), "unbrowse-imp-"));
    const bin = join(scratch, "no-curl-python");
    writeFileSync(bin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    chmodSync(bin, 0o755);
    process.env.UNBROWSE_PYTHON = bin;
    resetCurlImpersonateProbe();

    // Falls through the candidate list; whatever it settles on, it must never be
    // the interpreter that cannot import the module.
    const chosen = await resolveCurlImpersonatePython();
    expect(chosen).not.toBe(bin);
  });
});

describe("broker reuse decision is bounded", () => {
  it("gives up on an unresponsive broker instead of waiting out the request timeout", async () => {
    const state = {
      process: null,
      port: 7700,
      cdpPort: null,
      managedChrome: false,
      ready: false,
      startPromise: null,
      requestedPort: 7700,
    };

    const started = Date.now();
    const reused = await kuri.reuseHealthyBrokerIfPossible(
      state as any,
      { headless: false, attachToExistingChrome: true },
      {
        isHealthyPort: async () => true,
        discoverCdpPort: async () => {},
        ensureUserChromeRunning: async () => {},
        // A broker that accepts the connection and then never answers — the
        // shape that used to cost the full 30s operation timeout, twice.
        ensureTabsDiscovered: () => new Promise<void>(() => {}),
        listTabs: () => new Promise<never[]>(() => {}),
        terminateBrokerOnPort: async () => {},
      },
    );
    const elapsed = Date.now() - started;

    // Verdict unchanged (an unobservable broker is not reusable) — only the wait
    // is gone. Pre-fix this never resolved at all under injected deps.
    expect(reused).toBe(false);
    expect(elapsed).toBeLessThan(20_000);
    // And a foreign broker is still never terminated.
    expect(state.process).toBeNull();
  }, 30_000);
});
