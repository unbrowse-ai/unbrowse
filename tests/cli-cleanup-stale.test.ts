import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

const TESTS_DIR = dirname(new URL(import.meta.url).pathname);
const ROOT = join(TESTS_DIR, "..");
const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map((server) =>
      new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
    ),
  );
  servers.clear();
});

async function startServer(): Promise<{
  baseUrl: string;
  lastRequest: () => { method: string; path: string; body: unknown } | null;
}> {
  let lastRequest: { method: string; path: string; body: unknown } | null = null;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    lastRequest = {
      method: req.method ?? "GET",
      path: req.url ?? "/",
      body: raw ? JSON.parse(raw) : null,
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    lastRequest: () => lastRequest,
  };
}

async function runCli(baseUrl: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args, "--no-auto-start"], {
    cwd: ROOT,
    env: {
      ...process.env,
      UNBROWSE_URL: baseUrl,
    },
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

describe("cleanup-stale CLI", () => {
  it("posts cleanup filters to the local server", async () => {
    const server = await startServer();

    const cli = await runCli(server.baseUrl, [
      "build",
      "cleanup-stale",
      "--skill", "skill-123",
      "--domain", "x.com",
      "--limit", "5",
    ]);

    expect(cli.code).toBe(0);
    expect(server.lastRequest()).toEqual({
      method: "POST",
      path: "/v1/stale/cleanup",
      body: {
        skill_id: "skill-123",
        domain: "x.com",
        limit: 5,
      },
    });
  });
});
