import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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

async function startFallbackServer(): Promise<{ baseUrl: string }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if ((req.url ?? "") === "/v1/skills/skill-404") {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Skill not found" }));
      return;
    }
    if ((req.url ?? "") === "/v1/skills") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        skills: [
          {
            skill_id: "skill-404",
            version: "1.0.0",
            domain: "www.linkedin.com",
            intent_signature: "get timeline",
            description: "listed only",
            execution_type: "http",
            auth_profile_ref: null,
            endpoints: [],
            intents: ["get timeline"],
            examples: [],
            lifecycle: "active",
            operation_graph: { operations: [], edges: [] },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      }));
      return;
    }
    res.statusCode = 500;
    res.end(`unexpected url ${(req.url ?? "")}`);
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}` };
}

describe("client getSkill fallback", () => {
  it("falls back to the list endpoint when direct skill lookup 404s", async () => {
    const server = await startFallbackServer();
    const home = mkdtempSync(join(tmpdir(), "unbrowse-getskill-home-"));
    const configDir = mkdtempSync(join(tmpdir(), "unbrowse-getskill-config-"));
    const skillCacheDir = mkdtempSync(join(tmpdir(), "unbrowse-getskill-cache-"));
    const proc = Bun.spawn([
      process.execPath,
      "-e",
      `import { getSkill } from "./src/client/index.js";
const skill = await getSkill("skill-404");
console.log(JSON.stringify({ skill_id: skill?.skill_id ?? null }));`,
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        UNBROWSE_CONFIG_DIR: configDir,
        UNBROWSE_SKILL_CACHE_DIR: skillCacheDir,
        UNBROWSE_BACKEND_URL: server.baseUrl,
        UNBROWSE_LOCAL_ONLY: "0",
        UNBROWSE_BACKEND_OFFLINE: "0",
        UNBROWSE_LOCAL_CACHES: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(stderr.trim()).toBe("");
    expect(JSON.parse(stdout).skill_id).toBe("skill-404");
  });
});
