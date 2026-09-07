import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

type CapturedRequest = {
  method: string;
  path: string;
  body: unknown;
};

const TESTS_DIR = dirname(new URL(import.meta.url).pathname);
const ROOT = join(TESTS_DIR, "..");
const servers = new Set<ReturnType<typeof createServer>>();

async function startJsonEchoServer(responseBody: unknown = { ok: true }): Promise<{
  baseUrl: string;
  lastRequest: () => CapturedRequest | null;
  close: () => Promise<void>;
}> {
  let last: CapturedRequest | null = null;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    last = {
      method: req.method ?? "GET",
      path: req.url ?? "/",
      body: raw ? JSON.parse(raw) : null,
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(responseBody));
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    lastRequest: () => last,
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      servers.delete(server);
    },
  };
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

describe("CLI input payload ingestion (integration)", () => {
  // Three-verb collapse / stateless runtime: the daemon-HTTP request-payload
  // tests that lived here (resolve -> POST /v1/intent/resolve, execute -> POST
  // /v1/skills/.../execute, browse text/click -> /v1/browse/*) were removed.
  // Those commands no longer forward to a local daemon over UNBROWSE_URL:
  // `eval resolve`/`breath execute` resolve in-process (cache-first + direct
  // backend on miss), and browse reads attach to Chrome directly via CDP
  // (src/cli-v7/eval/text.ts etc.). The param-merge / payload-ingestion logic
  // they asserted is covered in-process by tests/input-payload-ingestion.test.ts.
  // The foundry publish-bundle path below still flows through api()/UNBROWSE_URL,
  // so it keeps its end-to-end forwarding assertion.

  it("sends publish-bundle to the foundry publish route", async () => {
    const server = await startJsonEchoServer({ ok: true });

    const cli = await runCli(server.baseUrl, [
      "build", "publish-bundle",
      "--preset", "skills/x-account-operator/foundry-preset.json",
      "--hosts", "codex,claude",
      "--site-url", "https://www.unbrowse.ai",
    ]);

    expect(cli.code).toBe(0);
    expect(server.lastRequest()).toEqual({
      method: "POST",
      path: "/v1/foundry/publish-bundle",
      body: {
        preset_path: "skills/x-account-operator/foundry-preset.json",
        hosts: ["codex", "claude"],
        site_url: "https://www.unbrowse.ai",
      },
    });
  });
});
