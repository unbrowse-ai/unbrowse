/**
 * GATE: the SDK surface can replay a learned route natively.
 *
 * "The SDK" is ambiguous in this repo and the ambiguity matters, so this gate
 * is explicit about which one it covers:
 *
 *   packages/sdk  (@unbrowse/sdk)  — an HTTP client for a LOCAL unbrowse
 *       runtime (default base http://localhost:6969, with spawn/adopt helpers
 *       in packages/sdk/src/runtime.ts). It can reach the local route store,
 *       because the runtime it talks to is the one that owns that store.
 *       THIS is what the gate covers.
 *
 *   src/sdk -> dist-sdk (`unbrowse/sdk`) — a REMOTE client. Its default base
 *       URL is https://beta-api.unbrowse.ai (src/sdk/client.ts:31), its
 *       constructor refuses to build without an Unbrowse credential
 *       (src/sdk/client.ts:61-64), and `unfetch` (src/sdk/fetch.ts) is the
 *       platform fetch with an optional 402 handler. There is no code path in
 *       it that reads the local route store. It is NOT gated here, because a
 *       gate it could pass would not be a gate for this claim.
 *
 * WHAT THIS GATE PROVES
 *   1. `new Unbrowse({ baseUrl }).resolve({ intent, url })` against a live
 *      local runtime surfaces the learned route out of the local route store.
 *   2. `.execute(skillId, { params: { endpoint_id } })` causes a DIRECT HTTP
 *      GET to the learned route's own URL — never supplied by the caller — and
 *      returns its bytes to the SDK caller.
 *   3. The SDK's wire contract (paths, request body shape, response parsing)
 *      still matches the runtime's routes. A rename on either side goes red.
 *   4. The runtime runs under an isolated HOME with the marketplace and live
 *      browser capture disabled, so the learned route is the only source of
 *      the payload.
 *
 * WHAT THIS GATE DOES NOT PROVE
 *   - It does not exercise `Unbrowse.spawn()` / `Unbrowse.local()`, i.e. the
 *     binary-location and readiness-probe logic in packages/sdk/src/runtime.ts.
 *     Those need an installed `unbrowse` binary. The gate uses the same
 *     `baseUrl` contract those helpers ultimately produce.
 *   - It does not exercise `startUnbrowseServer`'s process management
 *     (pidfile, idle reaper) — see tests/_learned-route-runtime.ts.
 *   - It does not prove authenticated replay, and no real credential is used.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  FIXTURE_MARKER,
  LEARNED_PATH,
  REPO_ROOT,
  hermeticEnv,
  makeHermeticHome,
  seedLearnedRoute,
  startFixtureOrigin,
  type FixtureOrigin,
} from "./_learned-route-fixture.js";
import { Unbrowse } from "../packages/sdk/src/client.js";

const INTENT = "list the fixture items";
const SKILL_ID = "sdkgatefixture";

interface Runtime {
  baseUrl: string;
  stderr: () => string;
  stop: () => void;
}

/** Spawn tests/_learned-route-runtime.ts and wait for `READY <port>`. */
async function startRuntime(env: Record<string, string>): Promise<Runtime> {
  const proc = Bun.spawn(["bun", "tests/_learned-route-runtime.ts"], {
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let stderrText = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      stderrText += decoder.decode(chunk, { stream: true });
    }
  })();

  let out = "";
  const decoder = new TextDecoder();
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const deadline = Date.now() + 120_000;
  let port = 0;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    const m = out.match(/READY (\d+)/);
    if (m) {
      port = Number(m[1]);
      break;
    }
  }
  reader.releaseLock();
  if (!port) {
    proc.kill();
    throw new Error(`runtime never reported READY\nstdout=${out}\nstderr=${stderrText.slice(-3000)}`);
  }
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stderr: () => stderrText,
    stop: () => proc.kill(),
  };
}

let fixture: FixtureOrigin | null = null;
let runtime: Runtime | null = null;
afterEach(() => {
  runtime?.stop();
  runtime = null;
  fixture?.stop();
  fixture = null;
});

describe("sdk surface replays a learned route", () => {
  test(
    "@unbrowse/sdk resolve + execute replays the learned route as a direct API call",
    async () => {
      const home = makeHermeticHome("sdk");
      fixture = startFixtureOrigin();
      const origin = fixture.origin;
      const { endpointId } = seedLearnedRoute(home, origin, { skillId: SKILL_ID, intent: INTENT });

      runtime = await startRuntime(hermeticEnv(home));
      const client = new Unbrowse({ baseUrl: runtime.baseUrl, timeoutMs: 120_000 });

      const resolved = await client.resolve({ intent: INTENT, url: `${origin}/` });
      const resolvedText = JSON.stringify(resolved);
      const diagResolve = `resolve=${resolvedText.slice(0, 3000)}\nruntime stderr=${runtime.stderr().slice(-2000)}`;

      // 1. The route store answered through the SDK's own resolve() wire shape.
      expect(resolvedText, `resolve did not surface the learned skill\n${diagResolve}`).toContain(SKILL_ID);
      expect(resolvedText, `resolve did not surface the learned endpoint\n${diagResolve}`).toContain(endpointId);

      const executed = await client.execute(SKILL_ID, {
        params: { endpoint_id: endpointId, url: `${origin}/` },
        intent: INTENT,
      });
      const executedText = JSON.stringify(executed);
      const diag =
        `execute=${executedText.slice(0, 3000)}\nruntime stderr=${runtime.stderr().slice(-2000)}\n` +
        `origin saw=${JSON.stringify(fixture.seen)}`;

      // 2. The learned route was actually requested over HTTP.
      expect(fixture.replayed(), `origin never saw GET ${LEARNED_PATH}\n${diag}`).toBe(true);

      // 3. Its bytes reached the SDK caller.
      expect(executedText, `payload marker missing from execute result\n${diag}`).toContain(FIXTURE_MARKER);

      // 4. No browser was driven.
      expect(runtime.stderr(), `browse ladder was entered — this is not a native replay\n${diag}`)
        .not.toMatch(/handing off to browser ladder|live-capture/i);
    },
    240_000,
  );
});
