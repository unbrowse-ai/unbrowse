/**
 * Witness for the native `unbrowse contract` CLI command
 * (src/cli-v7/eval/contract.ts).
 *
 * Drives the real handler with a hermetic wallet (temp UNBROWSE_WALLET_DIR,
 * encrypted-file backend — never the OS keychain) against a mocked backend
 * installed over globalThis.fetch (the thin client's default fetch impl).
 * Asserts the declare the handler POSTs is wallet-signed + well-formed, and
 * that the signature verifies with the backend's verifyDeclareSignature —
 * proving the CLI command produces the same byte-identical signed declare the
 * server accepts. Also covers `contract status`.
 *
 * process.exit is stubbed so the handler's exit(0)/exit(code) doesn't kill the
 * test runner; we capture the code and stdout/stderr instead.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  verifyDeclareSignature,
  type CanonicalDeclareBody,
} from "../backend/src/services/declare-signature";
import { handler as contractHandler } from "../src/cli-v7/eval/contract";
import type { ParsedV7Args } from "../src/cli-v7/args";

let walletDir: string;
let prevWalletDir: string | undefined;
let prevApiUrl: string | undefined;

beforeAll(() => {
  prevWalletDir = process.env.UNBROWSE_WALLET_DIR;
  prevApiUrl = process.env.UNBROWSE_API_URL;
  walletDir = mkdtempSync(join(tmpdir(), "ubrw-cli-contract-"));
  process.env.UNBROWSE_WALLET_DIR = walletDir;
  process.env.UNBROWSE_API_URL = "https://api.test.local";
});

afterAll(() => {
  if (prevWalletDir === undefined) delete process.env.UNBROWSE_WALLET_DIR;
  else process.env.UNBROWSE_WALLET_DIR = prevWalletDir;
  if (prevApiUrl === undefined) delete process.env.UNBROWSE_API_URL;
  else process.env.UNBROWSE_API_URL = prevApiUrl;
  try {
    rmSync(walletDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// Sentinel thrown by the stubbed process.exit to unwind the handler.
class __ExitSignal extends Error {
  constructor(public code: number) {
    super(`__exit__${code}`);
  }
}

// ---- harness: stub process.exit + capture stdout, mock fetch ----
const realExit = process.exit;
const realFetch = globalThis.fetch;
const realWrite = process.stdout.write.bind(process.stdout);

let exitCode: number | undefined;
let stdout = "";

function installHarness(fetchImpl: typeof fetch): void {
  exitCode = undefined;
  stdout = "";
  // @ts-expect-error — test stub; throw to unwind the handler after exit().
  // Record only the FIRST exit code: the handler's own try/catch would
  // otherwise re-invoke process.exit(1) on the thrown sentinel and clobber it.
  process.exit = (code?: number) => {
    if (exitCode === undefined) exitCode = code ?? 0;
    throw new __ExitSignal(exitCode);
  };
  // @ts-expect-error — capture stdout writes.
  process.stdout.write = (chunk: string) => {
    stdout += chunk;
    return true;
  };
  globalThis.fetch = fetchImpl;
}

afterEach(() => {
  process.exit = realExit;
  globalThis.fetch = realFetch;
  // @ts-expect-error — restore.
  process.stdout.write = realWrite;
});

async function runHandler(parsed: ParsedV7Args): Promise<void> {
  try {
    await contractHandler(parsed, { json: true });
  } catch (err) {
    if (!(err instanceof __ExitSignal)) throw err;
  }
}

function parsed(positional: string[], flags: Record<string, string | boolean> = {}): ParsedV7Args {
  return {
    verb: "eval",
    sub: "contract",
    positional,
    flags,
    wantsHelp: false,
    wantsJson: true,
  };
}

describe("unbrowse contract — native CLI command", () => {
  test("declare: handler POSTs a wallet-signed declare that the backend verifier accepts", async () => {
    let captured: Record<string, unknown> | undefined;
    installHarness((async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
      if (url.pathname === "/v1/contract/declare") {
        captured = init?.body ? JSON.parse(init.body as string) : {};
        return new Response(JSON.stringify({ id: "row-abc123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch);

    // Goal-only (/contract shape): a bare claim declares — no `declare` verb, no
    // --action flag; the verb rides in the leading token (none here → declare).
    await runHandler(parsed(["the route resolves clean — two witnesses"]));

    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.id).toBe("row-abc123");
    expect(out.verb).toBe("declare");
    expect(out.plan).toBe("the route resolves clean — two witnesses");

    // The wire body is wallet-signed + well-formed.
    expect(captured).toBeDefined();
    const body = captured as {
      plan: string;
      action: string;
      parent_id?: string;
      agent?: string;
      wallet_identity?: string;
      declare_signature?: string;
      ts?: string;
    };
    expect(body.plan).toBe("the route resolves clean — two witnesses");
    expect(body.action).toBe("declare"); // bare claim → declare (the build verb has no prefix)
    expect(typeof body.wallet_identity).toBe("string");
    expect(body.wallet_identity!.length).toBe(64); // 32-byte ed25519 pubkey, hex
    expect(typeof body.declare_signature).toBe("string");
    expect(body.declare_signature!.length).toBe(128); // 64-byte sig, hex
    expect(typeof body.ts).toBe("string");

    // The CLI's signature verifies against the backend's reconstruction.
    const canonical: CanonicalDeclareBody = {
      plan: body.plan,
      action: body.action,
      parent_id: body.parent_id ?? null,
      agent: body.agent ?? null,
      wallet_identity: body.wallet_identity!,
      ts: body.ts!,
    };
    const ok = await verifyDeclareSignature(canonical, body.declare_signature!);
    expect(ok).toBe(true);
  });

  test("goal-only verb: a leading token (satisfied:<id>) derives the action", async () => {
    let captured: Record<string, unknown> | undefined;
    installHarness((async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
      if (url.pathname === "/v1/contract/declare") {
        captured = init?.body ? JSON.parse(init.body as string) : {};
        return new Response(JSON.stringify({ id: "row-eval-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch);

    await runHandler(parsed(["satisfied:row-xyz — gate exit 0"]));

    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout.trim());
    expect(out.verb).toBe("declare");
    expect(out.action).toBe("satisfied"); // verb derived from the leading token, no --action flag
    expect(out.plan).toBe("satisfied:row-xyz — gate exit 0"); // the plan IS the whole goal (aiko grammar)
    const body = captured as { plan: string; action: string };
    expect(body.action).toBe("satisfied");
    expect(body.plan).toBe("satisfied:row-xyz — gate exit 0");
  });

  test("status: handler GETs the projection and prints it", async () => {
    installHarness((async (input: string | URL | Request) => {
      const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
      if (url.pathname === "/v1/contract/status" && url.searchParams.get("id") === "row-abc123") {
        return new Response(
          JSON.stringify({ id: "row-abc123", status: "active", rows: [{ wave: 0 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch);

    await runHandler(parsed(["status", "row-abc123"]));

    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.verb).toBe("status");
    expect(out.id).toBe("row-abc123");
    expect(out.status).toBe("active");
    expect(out.rows).toEqual([{ wave: 0 }]);
  });

  test("missing goal → usage error (EX_USAGE)", async () => {
    installHarness((async () => new Response("nope", { status: 500 })) as typeof fetch);
    let stderr = "";
    const realErr = process.stderr.write.bind(process.stderr);
    // @ts-expect-error — capture stderr.
    process.stderr.write = (c: string) => { stderr += c; return true; };
    try {
      await runHandler(parsed([]));
    } finally {
      // @ts-expect-error — restore.
      process.stderr.write = realErr;
    }
    expect(exitCode).toBe(64); // EX_USAGE
    expect(stderr).toContain("goal_required");
  });
});

// Registration witness: the eval table includes `contract`, so valid_subcommands does too.
describe("contract is registered in the eval subcommand table", () => {
  test("eval router TABLE exposes `contract`", async () => {
    const { router } = await import("../src/cli-v7/eval/index");
    // routeSub reads Object.keys(table) for valid_subcommands; assert via the
    // kind-map row that the subcommand exists 1:1.
    const { lookupKindMap } = await import("../src/cli-v7/kind-map");
    expect(lookupKindMap("eval", "contract")).toBeDefined();
    expect(router.verb).toBe("eval");
  });

  test("flatCommandVerb('contract') routes to eval", async () => {
    const { flatCommandVerb } = await import("../src/cli-v7/kind-map");
    expect(flatCommandVerb("contract")).toBe("eval");
  });
});

// Merge witness: `unbrowse contract` collapsed into the root `unbrowse "<goal>"`. A
// contract-grammar leading token routes to the contract handler; a plain task goal
// falls through to the resolve+execute front door (which auto-declares anyway).
describe("unbrowse contract merged into the root (looksLikeContractGoal)", () => {
  test("contract-grammar leading tokens are recognized as attestations", async () => {
    const { looksLikeContractGoal } = await import("../src/cli-v7/kind-map");
    expect(looksLikeContractGoal("satisfied:row-1 — gate exit 0")).toBe(true);
    expect(looksLikeContractGoal("died:row-2 — superseded")).toBe(true);
    expect(looksLikeContractGoal("status:row-3")).toBe(true);
    expect(looksLikeContractGoal("iterate:row-4 — wave 2")).toBe(true);
    expect(looksLikeContractGoal("declare:something")).toBe(true);
  });
  test("a plain task goal is NOT an attestation (falls through to resolve+execute)", async () => {
    const { looksLikeContractGoal } = await import("../src/cli-v7/kind-map");
    expect(looksLikeContractGoal("find the top posts on r/webscraping")).toBe(false);
    expect(looksLikeContractGoal("post a tweet about the launch")).toBe(false);
    expect(looksLikeContractGoal("status report for Q3")).toBe(false); // "status report" ≠ "status:"
    expect(looksLikeContractGoal("")).toBe(false);
  });
});
