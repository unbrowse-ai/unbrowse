/**
 * GATE: the MCP server surface can replay a learned route natively.
 *
 * Driven the way a host actually drives it: `bun src/mcp.ts` is spawned as a
 * real child process and spoken to over stdio JSON-RPC. Nothing is imported
 * in-process, so the transport, the tool registry, the argument validation and
 * the in-process Fastify app all participate.
 *
 * WHAT THIS GATE PROVES
 *   1. `unbrowse_eval_resolve` with an intent + a PAGE url surfaces the learned
 *      route (skill id + endpoint id) out of the local route store.
 *   2. `unbrowse_breath_execute` on that route issues a DIRECT HTTP GET to the
 *      learned route's own URL — which the caller never supplied — and returns
 *      its bytes to the MCP client.
 *   3. Both happen with the marketplace and live browser capture disabled, so
 *      the learned route is the only possible source of the payload.
 *   4. The child runs under an isolated HOME, so the cookie/profile readers in
 *      src/auth cannot reach this machine's real browser stores. If a future
 *      change makes execute depend on a real profile being present, this gate
 *      goes red rather than passing by borrowing the developer's session.
 *
 * WHAT THIS GATE DOES NOT PROVE
 *   - It does not cover the `UNBROWSE_MCP_V7_DISPATCH` path. That env var
 *     re-routes the same tool names through src/cli-v7 handlers, which is a
 *     DIFFERENT implementation with different auth behaviour (see the report).
 *     The default (off) path is what is gated here.
 *   - It does not prove authenticated replay; the fixture route is
 *     unauthenticated and no real credential is used.
 *   - It does not prove the MCP's remote/marketplace execute path
 *     (`UNBROWSE_MCP_HTTP_BACKEND=1`), which contacts a third-party host.
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

const INTENT = "list the fixture items";
const SKILL_ID = "mcpgatefixture";

interface RpcFrame {
  id?: number;
  result?: { structuredContent?: unknown; isError?: boolean; content?: unknown };
  error?: unknown;
}

/**
 * A live stdio MCP session against a spawned `bun src/mcp.ts`.
 * Frames are newline-delimited JSON on the child's stdout; the child also
 * writes diagnostics to stderr, which we keep for failure messages.
 */
async function withMcpSession<T>(
  env: Record<string, string>,
  body: (call: (method: string, params?: unknown) => Promise<RpcFrame>, stderr: () => string) => Promise<T>,
): Promise<T> {
  const proc = Bun.spawn(["bun", "src/mcp.ts"], {
    cwd: REPO_ROOT,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const frames: RpcFrame[] = [];
  let stderrText = "";
  let closed = false;

  const readStdout = (async () => {
    let buf = "";
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        try {
          frames.push(JSON.parse(line) as RpcFrame);
        } catch {
          /* not a frame */
        }
      }
    }
    closed = true;
  })();
  const readStderr = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      stderrText += decoder.decode(chunk, { stream: true });
    }
  })();

  let nextId = 1;
  const call = async (method: string, params?: unknown): Promise<RpcFrame> => {
    const id = nextId++;
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    await proc.stdin.flush();
    const deadline = Date.now() + 120_000;
    for (;;) {
      const hit = frames.find((f) => f.id === id);
      if (hit) return hit;
      if (closed) throw new Error(`MCP child closed stdout before answering ${method}\n${stderrText.slice(-2000)}`);
      if (Date.now() > deadline) throw new Error(`MCP timed out on ${method}\n${stderrText.slice(-2000)}`);
      await Bun.sleep(25);
    }
  };

  try {
    return await body(call, () => stderrText);
  } finally {
    try {
      proc.stdin.end();
    } catch {
      /* already closed */
    }
    proc.kill();
    await Promise.allSettled([proc.exited, readStdout, readStderr]);
  }
}

function asText(frame: RpcFrame): string {
  return JSON.stringify(frame.result ?? frame.error ?? frame);
}

let fixture: FixtureOrigin | null = null;
afterEach(() => {
  fixture?.stop();
  fixture = null;
});

describe("mcp surface replays a learned route", () => {
  test(
    "unbrowse_eval_resolve then unbrowse_breath_execute replays the learned route as a direct API call",
    async () => {
      const home = makeHermeticHome("mcp");
      fixture = startFixtureOrigin();
      const origin = fixture.origin;
      const { endpointId } = seedLearnedRoute(home, origin, { skillId: SKILL_ID, intent: INTENT });

      await withMcpSession(hermeticEnv(home), async (call, stderr) => {
        await call("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "replay-surface-gate", version: "1" },
        });

        const resolved = await call("tools/call", {
          name: "unbrowse_eval_resolve",
          arguments: { intent: INTENT, url: `${origin}/` },
        });
        const resolvedText = asText(resolved);
        const diagResolve = `resolve=${resolvedText.slice(0, 3000)}\nstderr=${stderr().slice(-2000)}`;

        // 1. The route store answered: the learned skill + endpoint are named.
        expect(resolved.result?.isError, `resolve returned an error\n${diagResolve}`).not.toBe(true);
        expect(resolvedText, `resolve did not surface the learned skill\n${diagResolve}`).toContain(SKILL_ID);
        expect(resolvedText, `resolve did not surface the learned endpoint\n${diagResolve}`).toContain(endpointId);

        const executed = await call("tools/call", {
          name: "unbrowse_breath_execute",
          arguments: { skill: SKILL_ID, endpoint: endpointId, url: `${origin}/` },
        });
        const executedText = asText(executed);
        const diag =
          `execute=${executedText.slice(0, 3000)}\nstderr=${stderr().slice(-2000)}\n` +
          `origin saw=${JSON.stringify(fixture!.seen)}`;

        // 2. The learned route was actually requested over HTTP.
        expect(fixture!.replayed(), `origin never saw GET ${LEARNED_PATH}\n${diag}`).toBe(true);

        // 3. Its bytes reached the MCP client.
        expect(executed.result?.isError, `execute returned an error\n${diag}`).not.toBe(true);
        expect(executedText, `payload marker missing from execute result\n${diag}`).toContain(FIXTURE_MARKER);

        // 4. No browser was driven.
        expect(stderr(), `browse ladder was entered — this is not a native replay\n${diag}`)
          .not.toMatch(/handing off to browser ladder|live-capture/i);
      });
    },
    240_000,
  );
});
