import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

// Falsifiers for plan-v6 (`execute --raw default`, `--summarize` opts in to
// extraction_hints envelope). The seed lives at src/cli.ts:1413 — the
// truncation gate flipped polarity from `!rawFlag` (default truncate) to
// `summarizeFlag` (default raw, opt-in truncate).

const TESTS_DIR = dirname(new URL(import.meta.url).pathname);
const ROOT = join(TESTS_DIR, "..");
const servers = new Set<ReturnType<typeof createServer>>();

async function startExecuteServer(executeResponse: unknown): Promise<{ baseUrl: string }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    for await (const _ of req) { /* drain */ }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(executeResponse));
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  await Promise.all(
    [...servers].map((server) =>
      new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
    ),
  );
  servers.clear();
});

async function runCli(baseUrl: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args, "--no-auto-start"], {
    cwd: ROOT,
    env: { ...process.env, UNBROWSE_URL: baseUrl },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function buildLargeResult(): Array<Record<string, string>> {
  return Array.from({ length: 100 }, (_, i) => ({
    id: `item-${i}`,
    title: `Walmart product ${i}: ${"coffee ".repeat(20)}`,
    description: `Long product description ${i}: ${"premium ground coffee blend ".repeat(15)}`,
    price: `$${(i * 1.23).toFixed(2)}`,
  }));
}

const TRACE = { trace_id: "t", skill_id: "s", endpoint_id: "e", success: true, status_code: 200 };

describe("execute --summarize (plan-v6 raw-default flip)", () => {
  it("golden: default >64KB → result, no envelope", async () => {
    const largeResult = buildLargeResult();
    const { baseUrl } = await startExecuteServer({ trace: TRACE, result: largeResult });
    const cli = await runCli(baseUrl, ["breath", "execute", "--skill", "s", "--endpoint", "e"]);
    expect(cli.code).toBe(0);
    const body = JSON.parse(cli.stdout.trim() || "{}");
    expect(body.extraction_hints).toBeUndefined();
    expect(Array.isArray(body.result)).toBe(true);
    expect(body.result.length).toBe(100);
    expect(JSON.stringify(largeResult).length).toBeGreaterThan(65_536);
  }, 30_000);

  it("golden: --summarize >64KB → extraction_hints envelope", async () => {
    const largeResult = buildLargeResult();
    const { baseUrl } = await startExecuteServer({ trace: TRACE, result: largeResult });
    const cli = await runCli(baseUrl, ["breath", "execute", "--skill", "s", "--endpoint", "e", "--summarize"]);
    expect(cli.code).toBe(0);
    const body = JSON.parse(cli.stdout.trim() || "{}");
    expect(body.extraction_hints).toBeDefined();
    expect(body.extraction_hints.message).toMatch(/over 64KB/);
    expect(typeof body.extraction_hints.response_bytes).toBe("number");
    expect(body.extraction_hints.response_bytes).toBeGreaterThan(65_536);
    expect(body.result).toBeUndefined();
  }, 30_000);

  it("control: <64KB → result regardless of flags", async () => {
    const smallResult = [{ id: "tiny", title: "small" }];
    const { baseUrl } = await startExecuteServer({ trace: TRACE, result: smallResult });
    const cli = await runCli(baseUrl, ["breath", "execute", "--skill", "s", "--endpoint", "e"]);
    expect(cli.code).toBe(0);
    const body = JSON.parse(cli.stdout.trim() || "{}");
    expect(body.extraction_hints).toBeUndefined();
    expect(body.result).toEqual(smallResult);
  }, 30_000);

  it("edge: --raw still works (back-compat skin) on >64KB", async () => {
    const largeResult = buildLargeResult();
    const { baseUrl } = await startExecuteServer({ trace: TRACE, result: largeResult });
    const cli = await runCli(baseUrl, ["breath", "execute", "--skill", "s", "--endpoint", "e", "--raw"]);
    expect(cli.code).toBe(0);
    const body = JSON.parse(cli.stdout.trim() || "{}");
    expect(body.extraction_hints).toBeUndefined();
    expect(Array.isArray(body.result)).toBe(true);
    expect(body.result.length).toBe(100);
  }, 30_000);

  it("edge: --summarize with <64KB skips envelope (inner threshold guard)", async () => {
    const smallResult = [{ id: "tiny", title: "small" }];
    const { baseUrl } = await startExecuteServer({ trace: TRACE, result: smallResult });
    const cli = await runCli(baseUrl, ["breath", "execute", "--skill", "s", "--endpoint", "e", "--summarize"]);
    expect(cli.code).toBe(0);
    const body = JSON.parse(cli.stdout.trim() || "{}");
    expect(body.extraction_hints).toBeUndefined();
    expect(body.result).toEqual(smallResult);
  }, 30_000);

  it("adversarial: --summarize + --raw → summarize wins (envelope emitted)", async () => {
    const largeResult = buildLargeResult();
    const { baseUrl } = await startExecuteServer({ trace: TRACE, result: largeResult });
    const cli = await runCli(baseUrl, ["breath", "execute", "--skill", "s", "--endpoint", "e", "--summarize", "--raw"]);
    expect(cli.code).toBe(0);
    const body = JSON.parse(cli.stdout.trim() || "{}");
    // Documented precedence: --summarize takes priority. Codified so future
    // reshuffles surface here instead of silently changing behavior.
    expect(body.extraction_hints).toBeDefined();
    expect(body.result).toBeUndefined();
  }, 30_000);
});
