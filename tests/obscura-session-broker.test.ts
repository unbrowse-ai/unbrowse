/**
 * GATE: the obscura session broker's pure logic + HTTP client framing. Hermetic —
 * injected fetch, a temp sessions dir, no spawn, no network. The live cross-CLI
 * persistence is proven by native/obscura-capture/broker-gate.sh.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMcpHttpArgs,
  parseToolText,
  sessionsDir,
  sessionFile,
  ObscuraHttpClient,
  readObscuraSession,
  attachObscuraSession,
  listObscuraSessions,
  type ObscuraSessionRecord,
} from "../src/obscura/session-broker.js";

describe("buildMcpHttpArgs", () => {
  test("http server argv on a port", () => {
    expect(buildMcpHttpArgs(3210)).toEqual(["mcp", "--http", "--host", "127.0.0.1", "--port", "3210"]);
    expect(buildMcpHttpArgs(3210, ["--stealth"])).toContain("--stealth");
  });
});

describe("parseToolText", () => {
  test("plain JSON tools/call reply", () => {
    expect(parseToolText('{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"zed"}]}}')).toBe("zed");
  });
  test("SSE data frame", () => {
    expect(parseToolText('event: message\ndata: {"result":{"content":[{"type":"text","text":"ok"}]}}\n\n')).toBe("ok");
  });
  test("throws on rpc error", () => {
    expect(() => parseToolText('{"error":{"code":-32000,"message":"boom"}}')).toThrow(/obscura mcp error/);
  });
});

describe("sessionsDir / sessionFile", () => {
  test("honor UNBROWSE_OBSCURA_SESSIONS_DIR", () => {
    const env = { UNBROWSE_OBSCURA_SESSIONS_DIR: "/tmp/xyz" };
    expect(sessionsDir(env)).toBe("/tmp/xyz");
    expect(sessionFile("abc", env)).toBe("/tmp/xyz/abc.json");
  });
  test("fall back to HOME/.unbrowse", () => {
    expect(sessionsDir({ HOME: "/home/u" })).toBe("/home/u/.unbrowse/obscura-sessions");
  });
});

describe("ObscuraHttpClient (injected fetch)", () => {
  function fakeClient() {
    const sent: Array<{ method: string; name?: string; args?: Record<string, unknown> }> = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const req = JSON.parse(init.body);
      sent.push({ method: req.method, name: req.params?.name, args: req.params?.arguments });
      const text =
        req.method === "tools/call"
          ? JSON.stringify({ result: { content: [{ type: "text", text: `ok:${req.params.name}` }] } })
          : JSON.stringify({ result: {} });
      return { text: async () => text };
    }) as unknown as typeof fetch;
    return { sent, client: new ObscuraHttpClient(9999, fetchImpl) };
  }

  test("initializes once, then dispatches tools with args", async () => {
    const { sent, client } = fakeClient();
    const out = await client.fill("input[name=username]", "zed");
    expect(sent[0].method).toBe("initialize");
    const fill = sent.find((s) => s.name === "browser_fill");
    expect(fill?.args).toEqual({ selector: "input[name=username]", value: "zed" });
    expect(out).toBe("ok:browser_fill");
    await client.navigate("https://x.test/");
    expect(sent.filter((s) => s.method === "initialize").length).toBe(1);
  });
});

describe("record read / attach / list (temp dir)", () => {
  test("attach resolves the recorded port; list enumerates ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sessions-"));
    const env = { UNBROWSE_OBSCURA_SESSIONS_DIR: dir };
    const rec: ObscuraSessionRecord = { sessionId: "s1", port: 4321, pid: 1234, createdAt: 1, bin: "/x/obscura" };
    writeFileSync(join(dir, "s1.json"), JSON.stringify(rec));
    expect(readObscuraSession("s1", env)?.port).toBe(4321);
    expect(listObscuraSessions(env)).toEqual(["s1"]);
    // attach builds a client pointed at the recorded port (no network here)
    const client = attachObscuraSession("s1", { env, fetchImpl: (async () => ({ text: async () => "{}" })) as unknown as typeof fetch });
    expect(client).toBeInstanceOf(ObscuraHttpClient);
    expect(existsSync(join(dir, "s1.json"))).toBe(true);
  });

  test("attach throws for an unknown session", () => {
    const env = { UNBROWSE_OBSCURA_SESSIONS_DIR: mkdtempSync(join(tmpdir(), "obs-empty-")) };
    expect(() => attachObscuraSession("nope", { env })).toThrow(/no obscura session/);
  });
});
