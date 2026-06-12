/**
 * W24.1 — A1 falsifier for `eval trace` under stateless mode + backend 503.
 *
 * Genesis 1:6 — *"Let there be an expanse to divide the waters from the waters."*
 * STATELESS_BOUNDARY §H rule 1 — "No CLI primitive writes to `~/.unbrowse/`
 * except (a) wallet bootstrap, (b) tmp working dir under
 * `~/.unbrowse/tmp/<sigHash>/` auto-rm'd by the next primitive."
 *
 * The bug this test pins: pre-W24.1, `eval trace` under stateless mode would
 * write `~/.unbrowse/traces/<domain>.jsonl` on backend-503 binding-missing —
 * outside tmp/, so A1 falsifier `find ~/.unbrowse -type f ! -path '*wallet*'
 * ! -path '*<slash>tmp<slash>*'` returned that file. Honest verdict: A1 fails.
 *
 * Falsifier protocol (4 cells):
 *
 *   E1. STATELESS + 503: after the trace-append call, the A1 falsifier
 *       (excluding wallet + tmp) returns ZERO files. The pending rows DO
 *       live somewhere — under `~/.unbrowse/tmp/<sigHash>/trace-pending.jsonl`
 *       — but tmp/ is the sanctioned working dir.
 *   E2. STATELESS + 503: the pending file IS recoverable from tmp on the next
 *       firing — its contents are valid JSONL StoredTrace rows with
 *       `_v7_pending: true` set on each.
 *   E3. STATELESS + 200: no pending file is left behind (rmLocalTraceFile
 *       cleans both legacy + tmp paths idempotently).
 *   E4. LEGACY (no UNBROWSE_STATELESS): existing W10-D path holds — the v6
 *       trace store at `~/.unbrowse/traces/<domain>.jsonl` is the read source;
 *       no v7 POST is attempted; the file is preserved.
 *
 * Pattern adopted from `tests/v7-cli-eval-meta.test.ts` — spawn the real CLI
 * binary, point UNBROWSE_API_URL at a `Bun.serve` mock backend, override HOME
 * so the file landings happen under an isolated tmp dir (no real
 * `~/.unbrowse/` pollution). Real wallet, real fs, real network — no mocks
 * (CLAUDE.md "Never mock in tests").
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli-v7", "index.ts");

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

/**
 * A1 falsifier scan — find every file under `<homeOverride>/.unbrowse/` that
 * is NOT under a `tmp/` subtree and NOT a wallet file. Returns absolute paths
 * (relative-stripped homeOverride for readable assert messages).
 */
function a1Scan(homeOverride: string): string[] {
  const root = join(homeOverride, ".unbrowse");
  if (!existsSync(root)) return [];
  const hits: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const fp = join(dir, name);
      let st;
      try { st = statSync(fp); } catch { continue; }
      if (st.isDirectory()) {
        // Walk into the dir, but the file-test below applies the path filter.
        walk(fp);
      } else if (st.isFile()) {
        const rel = fp.slice(root.length);
        // Mirror A1 falsifier: `! -path '*wallet*' ! -path '*<slash>tmp<slash>*'`.
        if (rel.includes("wallet")) continue;
        if (rel.includes("/tmp/")) continue;
        hits.push(fp);
      }
    }
  };
  walk(root);
  return hits;
}

// ─── E1+E2+E3 — STATELESS + 503 / 200 paths ────────────────────────────────

describe("W24.1 — A1 falsifier holds for eval trace under stateless + backend 503", () => {
  let homeOverride: string;
  let traceDir: string;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let nextStatus: { code: number; body: unknown } = {
    code: 503,
    body: { error: "binding_missing", _binding_missing: "TRACE_STATE" },
  };
  const HOST = "example.com";

  beforeAll(async () => {
    homeOverride = mkdtempSync(join(tmpdir(), "unb-w24-home-"));
    traceDir = mkdtempSync(join(tmpdir(), "unb-w24-trace-"));

    // Seed a real v6 StoredTrace into the trace-store-dir override — the
    // CLI reads it, projects it, posts it.
    const prevEnv = process.env.UNBROWSE_TRACE_STORE_DIR;
    process.env.UNBROWSE_TRACE_STORE_DIR = traceDir;
    try {
      const { storeExecutionTrace } = await import("../src/lib/graph-core/trace-store.js");
      storeExecutionTrace({
        trace_id: "t-w24-1",
        domain: HOST,
        intent: "w24 a1 falsifier",
        endpoint_sequence: ["https://example.com/api"],
        selected_endpoint_id: "ep-A",
        params: { q: "hello" },
        success: true,
        timestamp: new Date().toISOString(),
      });
    } finally {
      if (prevEnv === undefined) {
        // Keep set — beforeAll's seed needs the path. The child CLI process
        // gets it via the explicit env override on each runCli call.
      } else {
        process.env.UNBROWSE_TRACE_STORE_DIR = prevEnv;
      }
    }

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/v1/trace/append") {
          return new Response(JSON.stringify(nextStatus.body), {
            status: nextStatus.code,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not_found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
    if (homeOverride && existsSync(homeOverride)) {
      rmSync(homeOverride, { recursive: true, force: true });
    }
    if (traceDir && existsSync(traceDir)) {
      rmSync(traceDir, { recursive: true, force: true });
    }
  });

  it("E1 — stateless mode + 503: A1 falsifier returns zero files outside tmp/", async () => {
    nextStatus = {
      code: 503,
      body: { error: "binding_missing", _binding_missing: "TRACE_STATE" },
    };
    const apiBase = `http://127.0.0.1:${server!.port}`;
    const res = await runCli(["eval", "trace", HOST, "--json"], {
      HOME: homeOverride,
      UNBROWSE_STATELESS: "1",
      UNBROWSE_API_URL: apiBase,
      UNBROWSE_TRACE_STORE_DIR: traceDir,
      // Keep wallet bootstrap deterministic + sandboxed under homeOverride —
      // on linux file-fallback this lands at <HOME>/.unbrowse/wallet.enc
      // (matches A1's `! -path '*wallet*'` exclusion). On macOS Keychain
      // already owns the wallet, also outside `.unbrowse/`.
      UNBROWSE_WALLET_PASSPHRASE: "w24-test-passphrase",
    });

    // The handler exits non-zero on bindingMissing (it's a failure to seal).
    expect(res.code).not.toBe(0);
    // It returns a structured envelope, NOT a crash.
    const body = JSON.parse(res.stdout);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("trace_state_binding_missing");
    expect(body.bindingMissing).toBe("TRACE_STATE");

    // A1 falsifier — ZERO files outside `wallet` + `tmp/`.
    const hits = a1Scan(homeOverride);
    if (hits.length > 0) {
      throw new Error(
        `A1 falsifier FAILED — residual files outside tmp/+wallet: ${JSON.stringify(hits)}`,
      );
    }
    expect(hits.length).toBe(0);
  }, 60_000);

  it("E2 — stateless mode + 503: pending rows recoverable from tmp/<sigHash>/trace-pending.jsonl", () => {
    // Deterministic path: sha256(normalized-domain).slice(0,16). Mirrors
    // the helper in src/cli-v7/eval/trace.ts:v7TmpPendingPath.
    const normalized = HOST.toLowerCase().replace(/^www\./, "");
    const sigHash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    const expected = join(homeOverride, ".unbrowse", "tmp", sigHash, "trace-pending.jsonl");

    expect(existsSync(expected)).toBe(true);

    const raw = readFileSync(expected, "utf-8");
    const lines = raw.trim().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const row = JSON.parse(line);
      // Each row carries `_v7_pending: true` so the next firing can
      // distinguish "already-tried" rows from fresh ones.
      expect(row._v7_pending).toBe(true);
      // The original v6 trace fields survive — pending rows are full v6
      // shape, NOT v7-projected. (Projection happens at post-time, not
      // at park-time.)
      expect(typeof row.trace_id).toBe("string");
      expect(row.domain).toBe(HOST);
    }
  });

  it("E3 — stateless mode + 200: no pending file is left behind", async () => {
    nextStatus = {
      code: 200,
      body: { ok: true, idempotent: false, receiptId: "rcpt_w24_ok" },
    };
    // Re-seed the trace store (the previous test consumed the read but did
    // NOT delete since the local rm path runs only on 200).
    const prevEnv = process.env.UNBROWSE_TRACE_STORE_DIR;
    process.env.UNBROWSE_TRACE_STORE_DIR = traceDir;
    try {
      const { storeExecutionTrace } = await import("../src/lib/graph-core/trace-store.js");
      storeExecutionTrace({
        trace_id: "t-w24-2",
        domain: HOST,
        intent: "w24 a1 falsifier — 200 path",
        endpoint_sequence: ["https://example.com/api"],
        selected_endpoint_id: "ep-A",
        params: {},
        success: true,
        timestamp: new Date().toISOString(),
      });
    } finally {
      if (prevEnv === undefined) {
        // Keep set — see E1 note.
      } else {
        process.env.UNBROWSE_TRACE_STORE_DIR = prevEnv;
      }
    }

    const apiBase = `http://127.0.0.1:${server!.port}`;
    const res = await runCli(["eval", "trace", HOST, "--json"], {
      HOME: homeOverride,
      UNBROWSE_STATELESS: "1",
      UNBROWSE_API_URL: apiBase,
      UNBROWSE_TRACE_STORE_DIR: traceDir,
      UNBROWSE_WALLET_PASSPHRASE: "w24-test-passphrase",
    });

    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout);
    expect(body.ok).toBe(true);

    // Pending file cleaned up by rmLocalTraceFile.
    const normalized = HOST.toLowerCase().replace(/^www\./, "");
    const sigHash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    const tmpPath = join(homeOverride, ".unbrowse", "tmp", sigHash, "trace-pending.jsonl");
    expect(existsSync(tmpPath)).toBe(false);

    // A1 falsifier still holds.
    const hits = a1Scan(homeOverride);
    expect(hits.length).toBe(0);
  }, 60_000);
});

// ─── E4 — DELETED (W24.6, 2026-05-28) ─────────────────────────────────────
//
// The previous E4 describe-block asserted "legacy mode (no
// UNBROWSE_STATELESS) reads from the v6 trace-store and emits redacted
// JSONL rows on stdout". That code path was purged with the env-gate:
// stateless is now the sole path; v7 `eval trace` is POST-only. The
// local-redacted-emit lost sheep (lost-sheep #2) is documented as a
// deferred read surface awaiting `GET /v1/trace/list` in v7.3.
