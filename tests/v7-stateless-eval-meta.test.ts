/**
 * Day-6 DOMINION worker 6 — v7 stateless eval-meta tests (feedback + reflect).
 *
 *  — *"let us make man in our image."*
 *
 * Coverage:
 *   T1 (feedback golden)
 *     `eval feedback` under UNBROWSE_STATELESS=1 POSTs to /v1/stats/feedback
 *     with the wallet-signed envelope. Body carries skill_id + endpoint_id +
 *     rating; wire body also carries walletPubkey + signature + nonce +
 *     signatureScheme. Backend's existing 200-ack shape is preserved; the
 *     CLI surfaces the sig-derived `cacheKey` pointer.
 *
 *   T2 (reflect golden)
 *     `eval reflect` under UNBROWSE_STATELESS=1 POSTs outcome-only body
 *     {skill_id, endpoint_id, intent_status} via postStateless. intent_status
 *     is enum-only ("achieved" | "partial" | "failed"); unknown outcomes are
 *     rejected client-side BEFORE any network hit.
 *
 *   T3 (note-canary adversarial)
 *     `eval feedback --note "op://vault/UNB6-NOTE-CANARY"` sanitizes the
 *     pointer-shaped substring to `[redacted:pointer]` BEFORE POST. The wire
 *     body MUST NOT contain the canary string. The success ack on stdout
 *     MUST NOT contain the canary string. stderr MUST NOT contain it.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { sanitizeNote } from "../src/cli-v7/eval/feedback.js";
import { normalizeOutcome } from "../src/cli-v7/eval/reflect.js";

// ───────────────────────────────────────────────────────────────────────────
// Mock backend
// ───────────────────────────────────────────────────────────────────────────

interface CapturedReq {
  method: string;
  pathname: string;
  bodyText: string;
  bodyJson: Record<string, unknown>;
}

interface MockBackend {
  url: string;
  captured: CapturedReq[];
  setResponse: (
    pathname: string,
    r: { status: number; body: Record<string, unknown> },
  ) => void;
  stop: () => Promise<void>;
}

function spinupBackend(): MockBackend {
  const captured: CapturedReq[] = [];
  const responses = new Map<string, { status: number; body: Record<string, unknown> }>();

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      const bodyText = req.method !== "GET" ? await req.text() : "";
      let bodyJson: Record<string, unknown> = {};
      try {
        bodyJson = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        /* */
      }
      captured.push({
        method: req.method,
        pathname: u.pathname,
        bodyText,
        bodyJson,
      });

      const r = responses.get(u.pathname) ?? {
        status: 200,
        body: { ok: true },
      };
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    captured,
    setResponse: (pathname, r) => {
      responses.set(pathname, r);
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// CLI runner
// ───────────────────────────────────────────────────────────────────────────

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutJson?: Record<string, unknown>;
}

async function runCli(args: {
  subArgs: string[];
  homeDir: string;
  backendUrl: string;
  stateless: boolean;
}): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      ...process.env,
      HOME: args.homeDir,
      UNBROWSE_BACKEND_URL: args.backendUrl,
      UNBROWSE_API_URL: args.backendUrl,
      UNBROWSE_STATELESS: args.stateless ? "1" : "0",
      UNBROWSE_QUIET: "1",
    };
    const child = spawn(
      "bun",
      ["run", "src/cli-v7/index.ts", "eval", ...args.subArgs],
      {
        env,
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      let stdoutJson: Record<string, unknown> | undefined;
      try {
        stdoutJson = JSON.parse(stdout);
      } catch {
        /* */
      }
      resolve({ exitCode: code ?? -1, stdout, stderr, stdoutJson });
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Unit checks — pure functions
// ───────────────────────────────────────────────────────────────────────────

describe("Day-6 W-6: sanitizeNote pointer-leak guard", () => {
  it("strips op:// pointer to [redacted:pointer]", () => {
    expect(sanitizeNote("hello op://Vault/secret/key world")).toBe(
      "hello [redacted:pointer] world",
    );
  });
  it("strips keychain:// pointer (whitespace-separated token)", () => {
    expect(sanitizeNote("token keychain://app/key here")).toContain("[redacted:pointer]");
    expect(sanitizeNote("token keychain://app/key here")).not.toContain("keychain://");
  });
  it("leaves plain prose untouched", () => {
    expect(sanitizeNote("the search returned 3 results")).toBe(
      "the search returned 3 results",
    );
  });
});

describe("Day-6 W-6: reflect normalizeOutcome enum gate", () => {
  it("accepts achieved | partial | failed", () => {
    expect(normalizeOutcome("achieved")).toBe("achieved");
    expect(normalizeOutcome("partial")).toBe("partial");
    expect(normalizeOutcome("failed")).toBe("failed");
  });
  it("accepts known synonyms (success, ok, fail, failure)", () => {
    expect(normalizeOutcome("success")).toBe("achieved");
    expect(normalizeOutcome("ok")).toBe("achieved");
    expect(normalizeOutcome("failure")).toBe("failed");
    expect(normalizeOutcome("fail")).toBe("failed");
  });
  it("rejects unknown outcomes with null", () => {
    expect(normalizeOutcome("maybe")).toBeNull();
    expect(normalizeOutcome("")).toBeNull();
    expect(normalizeOutcome("ACHIEVED!")).toBeNull();
    expect(normalizeOutcome("completed")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// End-to-end: stateless feedback + reflect
// ───────────────────────────────────────────────────────────────────────────

describe("Day-6 W-6: stateless eval feedback + reflect", () => {
  let tmpHome: string;
  let backend: MockBackend;

  beforeEach(() => {
    tmpHome = join(
      process.env.TMPDIR ?? "/tmp",
      `unbrowse-eval-meta-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    mkdirSync(join(tmpHome, ".unbrowse"), { recursive: true });
    backend = spinupBackend();
  });

  afterEach(async () => {
    try {
      await backend.stop();
    } catch {
      /* */
    }
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("T1 feedback golden: POSTs wallet-signed body to /v1/stats/feedback with cacheKey", async () => {
    backend.setResponse("/v1/stats/feedback", {
      status: 200,
      body: { ok: true, avg_rating: 4.5, reliability: 0.91 },
    });

    const run = await runCli({
      subArgs: [
        "feedback",
        "skill_abc",
        "--endpoint",
        "ep_xyz",
        "--rating",
        "5",
        "--json",
      ],
      homeDir: tmpHome,
      backendUrl: backend.url,
      stateless: true,
    });

    expect(run.exitCode).toBe(0);
    expect(backend.captured.length).toBe(1);
    const post = backend.captured[0];
    expect(post.method).toBe("POST");
    expect(post.pathname).toBe("/v1/stats/feedback");
    expect(post.bodyJson.skill_id).toBe("skill_abc");
    expect(post.bodyJson.endpoint_id).toBe("ep_xyz");
    expect(post.bodyJson.rating).toBe(5);

    // Wallet-sig envelope present.
    expect(typeof post.bodyJson.walletPubkey).toBe("string");
    expect((post.bodyJson.walletPubkey as string).length).toBe(64);
    expect(typeof post.bodyJson.signature).toBe("string");
    expect(typeof post.bodyJson.nonce).toBe("string");
    expect(post.bodyJson.signatureScheme).toBe("ed25519-v7.0");

    // CLI surfaces sig-derived cacheKey to the agent.
    expect(typeof run.stdoutJson?.cacheKey).toBe("string");
    expect((run.stdoutJson?.cacheKey as string).length).toBe(32);
  }, 30_000);

  it("T2 reflect golden: outcome-only body, enum gate rejects unknowns BEFORE network", async () => {
    backend.setResponse("/v1/stats/reflect", {
      status: 200,
      body: { ok: true, reliability: 0.88 },
    });

    // Happy path — achieved.
    const okRun = await runCli({
      subArgs: [
        "reflect",
        "--outcome",
        "achieved",
        "--skill",
        "skill_abc",
        "--endpoint",
        "ep_xyz",
        "--json",
      ],
      homeDir: tmpHome,
      backendUrl: backend.url,
      stateless: true,
    });

    expect(okRun.exitCode).toBe(0);
    expect(backend.captured.length).toBe(1);
    const post = backend.captured[0];
    expect(post.pathname).toBe("/v1/stats/reflect");
    expect(post.bodyJson.skill_id).toBe("skill_abc");
    expect(post.bodyJson.endpoint_id).toBe("ep_xyz");
    expect(post.bodyJson.intent_status).toBe("achieved");
    // Wallet envelope present.
    expect(typeof post.bodyJson.walletPubkey).toBe("string");
    expect(typeof post.bodyJson.signature).toBe("string");
    expect(typeof post.bodyJson.nonce).toBe("string");
    // No URLs / no session-id / no intent text leaked.
    expect(post.bodyJson.url).toBeUndefined();
    expect(post.bodyJson.session_id).toBeUndefined();
    expect(post.bodyJson.intent).toBeUndefined();

    expect(typeof okRun.stdoutJson?.cacheKey).toBe("string");

    // Unknown outcome — rejected client-side; backend NOT contacted again.
    const capturedBefore = backend.captured.length;
    const badRun = await runCli({
      subArgs: [
        "reflect",
        "--outcome",
        "almost",
        "--skill",
        "skill_abc",
        "--endpoint",
        "ep_xyz",
        "--json",
      ],
      homeDir: tmpHome,
      backendUrl: backend.url,
      stateless: true,
    });
    expect(badRun.exitCode).toBe(64); // EX_USAGE
    expect(badRun.stdoutJson?.error).toBe("bad_outcome");
    expect(backend.captured.length).toBe(capturedBefore);
  }, 30_000);

  it("T3 note-canary adversarial: pointer-shaped note is sanitized before POST + never leaks", async () => {
    const CANARY = "UNB6-NOTE-CANARY-SECRET-LEAK";
    const noteWithPointer = `bad result, see op://Vault/${CANARY}/details for context`;

    backend.setResponse("/v1/stats/feedback", {
      status: 200,
      body: { ok: true, avg_rating: 2.0, reliability: 0.5 },
    });

    const run = await runCli({
      subArgs: [
        "feedback",
        "skill_abc",
        "--endpoint",
        "ep_xyz",
        "--rating",
        "2",
        "--note",
        noteWithPointer,
        "--json",
      ],
      homeDir: tmpHome,
      backendUrl: backend.url,
      stateless: true,
    });

    expect(run.exitCode).toBe(0);
    expect(backend.captured.length).toBe(1);
    const post = backend.captured[0];

    // The canary substring MUST NOT appear anywhere on the wire.
    expect(post.bodyText).not.toContain(CANARY);
    expect(post.bodyText).not.toContain("op://");
    // The sanitized form IS present.
    expect((post.bodyJson.note as string)).toContain("[redacted:pointer]");
    expect((post.bodyJson.note as string)).not.toContain(CANARY);

    // Canary MUST NOT leak to stdout/stderr either.
    expect(run.stdout).not.toContain(CANARY);
    expect(run.stderr).not.toContain(CANARY);
    expect(run.stdout).not.toContain("op://");
  }, 30_000);
});
