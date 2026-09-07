/**
 * GATE: all three surfaces source replay credentials the same way.
 *
 * A learned route on an authenticated site is worthless if the replay goes out
 * logged-out. The product's answer is that the credential comes from THIS
 * machine — the vault first, then the local browser cookie store — and is
 * attached to the direct HTTP replay. That seam is shared:
 *
 *     executeEndpoint (src/execution/index.ts:2901)
 *       -> reloadExecutionAuthState (:303)
 *          -> getAuthCookies (src/auth/index.ts:596)
 *             -> extractBrowserCookies (src/auth/browser-cookies.ts)
 *       -> serverFetch (:3597) attaches them as a Cookie header
 *
 * This gate proves the seam is reached from ALL THREE surfaces and not just
 * one, so a surface that grows its own execute path (there is precedent — see
 * the report) cannot silently start replaying logged-out.
 *
 * It is also the regression guard for the browser-profile-root rewrite in
 * src/auth/browser-profile-roots.ts: the fixture profile is discovered through
 * that resolver, so a resolver that stops finding a profile turns this red
 * instead of degrading into "the site returned the logged-out page".
 *
 * WHAT THIS GATE PROVES
 *   For skill (CLI), MCP and SDK, each in its OWN fresh isolated HOME:
 *     1. the surface harvested the session cookie from the local browser
 *        profile in that HOME (nothing was pre-loaded into a vault), and
 *     2. attached it to the direct HTTP replay of the learned route, and
 *     3. the origin, which 401s without it, returned the authenticated payload.
 *
 * WHAT THIS GATE DOES NOT PROVE
 *   - No real credential and no real browser profile is involved. The profile
 *     is a synthetic Firefox `cookies.sqlite` written into the temp HOME, and
 *     the origin is loopback. It proves the PATH is wired, not that any
 *     particular real browser's on-disk format still parses.
 *   - It does not cover Chromium-family value decryption (Firefox stores
 *     cookie values in plaintext; Chromium does not).
 *   - It does not cover the REMOTE surfaces: src/sdk -> dist-sdk sends its
 *     credential to beta-api.unbrowse.ai and never reads a local cookie store,
 *     and src/cli-v7/breath/execute.ts (the `unbrowse execute` handler) has no
 *     vault or browser-cookie lookup at all. Both are reported, not gated.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FIXTURE_MARKER,
  REPO_ROOT,
  hermeticEnv,
  makeHermeticHome,
  seedLearnedRoute,
  runSurface,
  type HermeticHome,
} from "./_learned-route-fixture.js";
import { Unbrowse } from "../packages/sdk/src/client.js";

const INTENT = "list the fixture items";
const TOKEN = "FIXTURE_SESSION_TOKEN";

/**
 * A synthetic Firefox profile in the throwaway HOME. Firefox keeps cookie
 * values in plaintext, so no real keychain, no real profile and no real
 * credential is involved.
 */
function seedSyntheticBrowserProfile(h: HermeticHome): void {
  const profile = join(h.home, ".mozilla", "firefox", "gate.default-release");
  mkdirSync(profile, { recursive: true });
  execFileSync("sqlite3", [
    join(profile, "cookies.sqlite"),
    "CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT, path TEXT, " +
      "expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER); " +
      "INSERT INTO moz_cookies (name,value,host,path,expiry,lastAccessed,creationTime,isSecure,isHttpOnly,sameSite) " +
      `VALUES ('fixture_session','${TOKEN}','127.0.0.1','/',9999999999,1,1,0,1,1);`,
  ]);
}

interface GatedOrigin {
  origin: string;
  seen: string[];
  authedHits: number;
  stop(): void;
}

/** Origin that 401s the learned route unless the harvested cookie is present. */
function startGatedOrigin(): GatedOrigin {
  const state = { authedHits: 0 };
  const seen: string[] = [];
  const rows = Array.from({ length: 25 }, (_, i) => ({
    id: i + 1,
    title: `FIXTURE_ROW_${i + 1}`,
    body: "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(3),
  }));
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      const cookie = req.headers.get("cookie") ?? "";
      seen.push(`${req.method} ${path} cookie=${cookie.includes(TOKEN) ? "authed" : "anon"}`);
      if (path === "/api/items") {
        if (!cookie.includes(TOKEN)) {
          return new Response(JSON.stringify({ error: "unauthenticated" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        if (req.method === "GET") state.authedHits += 1;
        return new Response(JSON.stringify({ items: rows }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("<html><head><title>Gated fixture</title></head><body><h1>Sign in</h1></body></html>", {
        headers: { "content-type": "text/html" },
      });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    seen,
    get authedHits() {
      return state.authedHits;
    },
    stop: () => server.stop(true),
  };
}

let gated: GatedOrigin | null = null;
const stoppers: Array<() => void> = [];
afterEach(() => {
  while (stoppers.length) stoppers.pop()!();
  gated?.stop();
  gated = null;
});

describe("replay credentials come from this machine on every surface", () => {
  test(
    "skill surface (CLI) attaches the locally-harvested cookie to the replay",
    async () => {
      const home = makeHermeticHome("auth-skill");
      seedSyntheticBrowserProfile(home);
      gated = startGatedOrigin();
      seedLearnedRoute(home, gated.origin, { skillId: "authskillfixture", intent: INTENT });

      const run = await runSurface(
        ["bun", "src/cli.ts", INTENT, "--url", `${gated.origin}/`, "--json"],
        hermeticEnv(home),
      );
      const diag = `exit=${run.code}\nstdout=${run.stdout.slice(0, 2000)}\nstderr=${run.stderr.slice(-2000)}\norigin saw=${JSON.stringify(gated.seen)}`;

      expect(gated.authedHits, `no authenticated replay reached the origin\n${diag}`).toBeGreaterThan(0);
      expect(run.stdout, `authenticated payload did not reach the caller\n${diag}`).toContain(FIXTURE_MARKER);
    },
    240_000,
  );

  test(
    "mcp surface attaches the locally-harvested cookie to the replay",
    async () => {
      const home = makeHermeticHome("auth-mcp");
      seedSyntheticBrowserProfile(home);
      gated = startGatedOrigin();
      const { endpointId } = seedLearnedRoute(home, gated.origin, { skillId: "authmcpfixture", intent: INTENT });

      const proc = Bun.spawn(["bun", "src/mcp.ts"], {
        cwd: REPO_ROOT,
        env: hermeticEnv(home),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      stoppers.push(() => proc.kill());

      const frames: Array<{ id?: number; result?: unknown }> = [];
      let stderrText = "";
      void (async () => {
        let buf = "";
        const dec = new TextDecoder();
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
          buf += dec.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line.startsWith("{")) {
              try {
                frames.push(JSON.parse(line));
              } catch {
                /* not a frame */
              }
            }
          }
        }
      })();
      void (async () => {
        const dec = new TextDecoder();
        for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
          stderrText += dec.decode(chunk, { stream: true });
        }
      })();

      let id = 0;
      const call = async (method: string, params?: unknown) => {
        const my = ++id;
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
        await proc.stdin.flush();
        const deadline = Date.now() + 120_000;
        for (;;) {
          const hit = frames.find((f) => f.id === my);
          if (hit) return hit;
          if (Date.now() > deadline) throw new Error(`MCP timed out on ${method}\n${stderrText.slice(-2000)}`);
          await Bun.sleep(25);
        }
      };

      await call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "replay-auth-gate", version: "1" },
      });
      const executed = await call("tools/call", {
        name: "unbrowse_breath_execute",
        arguments: { skill: "authmcpfixture", endpoint: endpointId, url: `${gated.origin}/` },
      });
      const text = JSON.stringify(executed.result);
      const diag = `execute=${text.slice(0, 2000)}\nstderr=${stderrText.slice(-2000)}\norigin saw=${JSON.stringify(gated.seen)}`;

      expect(gated.authedHits, `no authenticated replay reached the origin\n${diag}`).toBeGreaterThan(0);
      expect(text, `authenticated payload did not reach the MCP client\n${diag}`).toContain(FIXTURE_MARKER);
    },
    240_000,
  );

  test(
    "sdk surface attaches the locally-harvested cookie to the replay",
    async () => {
      const home = makeHermeticHome("auth-sdk");
      seedSyntheticBrowserProfile(home);
      gated = startGatedOrigin();
      const { endpointId } = seedLearnedRoute(home, gated.origin, { skillId: "authsdkfixture", intent: INTENT });

      const proc = Bun.spawn(["bun", "tests/_learned-route-runtime.ts"], {
        cwd: REPO_ROOT,
        env: hermeticEnv(home),
        stdout: "pipe",
        stderr: "pipe",
      });
      stoppers.push(() => proc.kill());
      let stderrText = "";
      void (async () => {
        const dec = new TextDecoder();
        for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
          stderrText += dec.decode(chunk, { stream: true });
        }
      })();

      let out = "";
      let port = 0;
      const dec = new TextDecoder();
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        out += dec.decode(value, { stream: true });
        const m = out.match(/READY (\d+)/);
        if (m) {
          port = Number(m[1]);
          break;
        }
      }
      reader.releaseLock();
      expect(port, `runtime never reported READY\nstdout=${out}\nstderr=${stderrText.slice(-2000)}`).toBeGreaterThan(0);

      const client = new Unbrowse({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 120_000 });
      const executed = await client.execute("authsdkfixture", {
        params: { endpoint_id: endpointId, url: `${gated.origin}/` },
        intent: INTENT,
      });
      const text = JSON.stringify(executed);
      const diag = `execute=${text.slice(0, 2000)}\nruntime stderr=${stderrText.slice(-2000)}\norigin saw=${JSON.stringify(gated.seen)}`;

      expect(gated.authedHits, `no authenticated replay reached the origin\n${diag}`).toBeGreaterThan(0);
      expect(text, `authenticated payload did not reach the SDK caller\n${diag}`).toContain(FIXTURE_MARKER);
    },
    240_000,
  );
});
