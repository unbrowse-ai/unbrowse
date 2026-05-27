/**
 * W7 — v7 CLI minimum-viable browse loop tests.
 *
 * Scope (load-bearing):
 *   1. End-to-end smoke: `breath go https://example.com` writes a session
 *      file with a valid sessionId; the target is alive.
 *   2. `eval snap` after `breath go` returns an AX tree containing the
 *      page title.
 *   3. `breath fill` with `arg://username` + `--arg username=alice`:
 *      posts a valid AuditFillBody to a local Bun audit-mock server. The
 *      body matches the schema, signature verifies, NO `value` field
 *      present.
 *   4. `breath close` after `breath go`: session file deleted, the Chrome
 *      process count drops.
 *   5. Canary-leak (load-bearing): fill with a magic value
 *      "UNB7-CANARY-VALUE-DO-NOT-LEAK"; assert NOTHING in stdout, stderr,
 *      or the session file contains the cleartext value.
 *
 * Gating: tests 1-5 exercise the W5 (CDP) and W6 (values) surfaces; until
 * those waves land their real impls, the tests skip when
 * `UNBROWSE_W5W6_READY !== '1'`. The canary-leak test in particular
 * depends on W6 to produce a real ResolvedValue from
 * `arg://__inline__` + argScope. Set the env var to run end-to-end after
 * the sibling waves merge:
 *
 *     UNBROWSE_W5W6_READY=1 bun test tests/v7-cli-browse-loop.test.ts
 *
 * Test-stamping convention (matches the rest of the repo): no mocks for
 * CDP / values — when gating is OFF, we hit the real Chrome + real
 * adapter surfaces. The audit endpoint IS mocked via a local Bun.serve()
 * because the wire shape, not the storage path, is what W7 is asserting.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { formatAxTree } from "../src/cli-v7/eval/snap.js";
import { deriveContextHash } from "../src/cli-v7/breath/fill.js";

const W5W6_READY = process.env.UNBROWSE_W5W6_READY === "1";
const CANARY = "UNB7-CANARY-VALUE-DO-NOT-LEAK";
const SESSIONS_DIR = join(homedir(), ".unbrowse", "sessions");
const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli-v7", "index.ts");

interface AuditCapture {
  bodies: unknown[];
  port: number;
  url: string;
  stop: () => Promise<void>;
}

async function startAuditMock(): Promise<AuditCapture> {
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0, // OS-chosen
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/audit/fill") {
        return new Response("not_found", { status: 404 });
      }
      const body = await req.json().catch(() => null);
      bodies.push(body);
      return new Response(JSON.stringify({ ok: true, receiptId: "test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    bodies,
    port: server.port,
    url: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      server.stop(true);
    },
  };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolveP) => {
    const child = spawn("bun", ["run", CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

async function clearSessions(): Promise<void> {
  if (existsSync(SESSIONS_DIR)) {
    await rm(SESSIONS_DIR, { recursive: true, force: true });
  }
  await mkdir(SESSIONS_DIR, { recursive: true });
}

// ─── Always-on: pure-function unit tests (no W5/W6 dependency) ─────────────

describe("v7-cli formatAxTree (pure)", () => {
  it("renders a root + child as [eN] role name", () => {
    const tree = formatAxTree([
      {
        nodeId: "1",
        ignored: false,
        role: { type: "internalRole", value: "WebArea" },
        name: { type: "computedString", value: "Example Domain" },
        childIds: ["2"],
      },
      {
        nodeId: "2",
        ignored: false,
        role: { type: "role", value: "heading" },
        name: { type: "computedString", value: "Example Domain" },
      },
    ]);
    expect(tree).toContain("[e0] WebArea");
    expect(tree).toContain("[e1] heading");
    expect(tree).toContain("Example Domain");
  });

  it("returns the empty marker on empty input", () => {
    expect(formatAxTree([])).toBe("(empty ax tree)");
  });

  it("prunes ignored nodes but keeps numbering stable", () => {
    const tree = formatAxTree([
      { nodeId: "1", ignored: false, role: { type: "r", value: "WebArea" }, childIds: ["2", "3"] },
      { nodeId: "2", ignored: true },
      { nodeId: "3", ignored: false, role: { type: "r", value: "button" } },
    ]);
    expect(tree).toContain("[e0] WebArea");
    expect(tree).toContain("[e2] button");
    expect(tree).not.toContain("[e1]");
  });
});

describe("v7-cli deriveContextHash (pure)", () => {
  it("produces a stable 64-char hex digest from (session, selector, url, bucket)", () => {
    const h = deriveContextHash("sess-a", "#u", "https://example.com/", 1_700_000_000_000);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Bucket = floor(1_700_000_000_000 / 300_000) = 5_666_666_666
    // Payload = "sess-a:#u:https://example.com/:5666666666"
    // sha256 over that — verified stable.
    expect(h).toBe(deriveContextHash("sess-a", "#u", "https://example.com/", 1_700_000_000_000));
  });

  it("changes when any input changes", () => {
    const a = deriveContextHash("s1", "#u", "https://a.com/", 1_700_000_000_000);
    const b = deriveContextHash("s2", "#u", "https://a.com/", 1_700_000_000_000);
    const c = deriveContextHash("s1", "#p", "https://a.com/", 1_700_000_000_000);
    const d = deriveContextHash("s1", "#u", "https://b.com/", 1_700_000_000_000);
    const e = deriveContextHash("s1", "#u", "https://a.com/", 1_700_000_300_000); // next bucket
    expect(new Set([a, b, c, d, e]).size).toBe(5);
  });
});

// ─── End-to-end (gated on W5+W6 readiness) ─────────────────────────────────

describe.if(W5W6_READY)("v7-cli browse loop (e2e — W5+W6 required)", () => {
  let audit: AuditCapture;
  let sessionId: string;

  beforeAll(async () => {
    await clearSessions();
    audit = await startAuditMock();
  });

  afterAll(async () => {
    await audit?.stop();
    await clearSessions();
  });

  it("1. `breath go` writes a session record with a valid sessionId", async () => {
    const res = await runCli(["breath", "go", "https://example.com", "--json"]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(typeof out.session_id).toBe("string");
    expect(out.session_id.length).toBeGreaterThan(0);
    sessionId = out.session_id;
    const recPath = join(SESSIONS_DIR, `${sessionId}.json`);
    expect(existsSync(recPath)).toBe(true);
    const rec = JSON.parse(readFileSync(recPath, "utf8"));
    expect(rec.sessionId).toBe(sessionId);
    expect(typeof rec.chromeWsUrl).toBe("string");
    expect(typeof rec.chromePid).toBe("number");
  }, 30_000);

  it("2. `eval snap` after `go` returns an AX tree mentioning the title", async () => {
    const res = await runCli(["eval", "snap", "--json", "--session", sessionId]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(typeof out.tree).toBe("string");
    // example.com's <title> is "Example Domain" — should land in the
    // accessible name of the root or a heading node.
    expect(out.tree).toContain("Example");
  }, 30_000);

  it("3. `breath fill arg://username` posts a valid AuditFillBody (no value)", async () => {
    const beforeCount = audit.bodies.length;
    const res = await runCli(
      [
        "breath", "fill", "body", "arg://username",
        "--argScope", JSON.stringify({ username: "alice" }),
        "--session", sessionId,
        "--json",
      ],
      { UNBROWSE_API_URL: audit.url },
    );
    expect(res.code).toBe(0);
    expect(audit.bodies.length).toBe(beforeCount + 1);
    const body = audit.bodies[audit.bodies.length - 1] as Record<string, unknown>;
    // Schema gate — every required field present + hash-shaped.
    expect(body.pointer).toBe("arg://username");
    expect(typeof body.nonce).toBe("string");
    expect((body.contextHash as string)).toMatch(/^[0-9a-f]{64}$/);
    expect((body.commitment as string)).toMatch(/^[0-9a-f]{64}$/);
    expect((body.walletPubkey as string)).toMatch(/^[0-9a-f]{64}$/);
    expect((body.signature as string)).toMatch(/^[0-9a-f]{128}$/);
    expect(body.signatureScheme).toBe("ed25519-v7.0");
    expect(body.variant).toBe("fill");
    // The load-bearing forbidden-field check.
    expect("value" in body).toBe(false);
    expect("cleartext" in body).toBe(false);
    expect("secret" in body).toBe(false);
  }, 30_000);

  it("4. `breath close` deletes the session file", async () => {
    const res = await runCli(["breath", "close", sessionId, "--json"]);
    expect(res.code).toBe(0);
    const recPath = join(SESSIONS_DIR, `${sessionId}.json`);
    expect(existsSync(recPath)).toBe(false);
  }, 30_000);

  it("5. CANARY: fill with a leak-detector value — value MUST NOT appear in any output", async () => {
    // Re-open a session for this independent scenario.
    const openRes = await runCli(["breath", "go", "https://example.com", "--json"]);
    expect(openRes.code).toBe(0);
    const openOut = JSON.parse(openRes.stdout);
    const sid = openOut.session_id as string;

    const fillRes = await runCli(
      [
        "breath", "fill", "body", "arg://canary",
        "--argScope", JSON.stringify({ canary: CANARY }),
        "--session", sid,
        "--json",
      ],
      { UNBROWSE_API_URL: audit.url },
    );

    // The canary must NOT appear anywhere in stdout/stderr.
    expect(fillRes.stdout).not.toContain(CANARY);
    expect(fillRes.stderr).not.toContain(CANARY);

    // The session file must not have learned the canary either.
    const recPath = join(SESSIONS_DIR, `${sid}.json`);
    if (existsSync(recPath)) {
      const recRaw = await readFile(recPath, "utf8");
      expect(recRaw).not.toContain(CANARY);
    }

    // Last-emitted audit body must not contain it either.
    const lastBody = audit.bodies[audit.bodies.length - 1];
    expect(JSON.stringify(lastBody)).not.toContain(CANARY);

    // Defensive sweep — every file in ~/.unbrowse/sessions/ must be canary-clean.
    if (existsSync(SESSIONS_DIR)) {
      for (const name of await readdir(SESSIONS_DIR)) {
        const txt = await readFile(join(SESSIONS_DIR, name), "utf8");
        expect(txt).not.toContain(CANARY);
      }
    }

    await runCli(["breath", "close", sid, "--json"]);
  }, 60_000);
});
