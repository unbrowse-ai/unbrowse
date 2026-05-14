import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const MCP_ENTRY = path.join(REPO, "src", "mcp.ts");

type Rpc = { id?: number | string; result?: unknown; error?: unknown };

let tmpHome: string;
let stub: http.Server | undefined;
let stubPort = 0;

beforeEach(async () => {
  tmpHome = mkdtempSync(path.join(tmpdir(), "unbrowse-reflect-"));
  stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/v1/health")) {
        res.end(JSON.stringify({ ok: true, version: "stub", code_hash: "stub" }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  stubPort = 17500 + Math.floor(Math.random() * 200);
  await new Promise<void>((r) => stub!.listen(stubPort, () => r()));
});

afterEach(async () => {
  if (stub) await new Promise<void>((r) => stub!.close(() => r()));
  stub = undefined;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function spawnMcp(): ChildProcess {
  const env = {
    ...process.env,
    HOME: tmpHome,
    UNBROWSE_TELEMETRY: "1",
    UNBROWSE_URL: `http://127.0.0.1:${stubPort}`,
    UNBROWSE_NO_AUTO_START: "1",
    MCP_SERVER_MODE: "1",
  };
  return spawn("bun", [MCP_ENTRY, "--no-auto-start"], { env, stdio: ["pipe", "pipe", "pipe"] });
}

async function runRpc(messages: Array<Record<string, unknown>>): Promise<Rpc[]> {
  const proc = spawnMcp();
  const responses: Rpc[] = [];
  let buf = "";
  proc.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        responses.push(JSON.parse(line));
      } catch {
        // skip stderr leak
      }
    }
  });
  proc.stderr!.on("data", () => {});

  await new Promise((r) => setTimeout(r, 300));
  for (const m of messages) {
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  }
  proc.stdin!.end();
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      proc.kill();
      resolve();
    }, 8000);
    proc.on("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
  return responses;
}

function readSessionEvents(): Array<Record<string, unknown>> {
  const sessionsDir = path.join(tmpHome, ".unbrowse", "sessions");
  const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  expect(files.length).toBeGreaterThan(0);
  const raw = readFileSync(path.join(sessionsDir, files[0]), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("unbrowse_reflect tool (P2)", () => {
  test("tools/list exposes unbrowse_reflect", async () => {
    const responses = await runRpc([
      { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/list" },
    ]);
    const list = responses.find((r) => r.id === 2);
    const tools = (list?.result as { tools?: Array<{ name: string }> })?.tools ?? [];
    expect(tools.map((t) => t.name)).toContain("unbrowse_reflect");
  }, 15000);

  test("calling unbrowse_reflect writes a reflection event with intent_status", async () => {
    const responses = await runRpc([
      { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/call", params: { name: "unbrowse_reflect", arguments: { intent_status: "achieved" } } },
    ]);
    const resp = responses.find((r) => r.id === 2);
    const sc = (resp?.result as { structuredContent?: { ok?: boolean; intent_status?: string } })?.structuredContent;
    expect(sc?.ok).toBe(true);
    expect(sc?.intent_status).toBe("achieved");

    const events = readSessionEvents();
    const reflection = events.find((e) => e.event === "reflection");
    expect(reflection).toBeDefined();
    expect(reflection!.intent_status).toBe("achieved");
    expect(events.map((e) => e.event)).not.toContain("reflection_missing");
  }, 15000);

  test("session with tool call but no reflect emits reflection_missing on session_end", async () => {
    await runRpc([
      { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/call", params: { name: "unbrowse_health", arguments: {} } },
    ]);
    const events = readSessionEvents();
    const types = events.map((e) => e.event);
    expect(types).toContain("reflection_missing");
    const end = events.find((e) => e.event === "session_end") as Record<string, unknown>;
    expect(end?.reflection_status).toBe("missing");
  }, 15000);

  test("initialize instructions field contains REFLECTION paragraph", async () => {
    const responses = await runRpc([
      { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    ]);
    const init = responses.find((r) => r.id === 1);
    const inst = (init?.result as { instructions?: string })?.instructions ?? "";
    expect(inst).toMatch(/REFLECTION/);
    expect(inst).toMatch(/unbrowse_reflect/);
  }, 15000);

  test("source wiring: addExecuteNextStepHints and addCaptureNextStepHints carry reflect_when_done", () => {
    const src = readFileSync(path.join(REPO, "src", "mcp.ts"), "utf8");
    const reflectHintCount = (src.match(/reflect_when_done:/g) ?? []).length;
    expect(reflectHintCount).toBeGreaterThanOrEqual(2);
  });
});
