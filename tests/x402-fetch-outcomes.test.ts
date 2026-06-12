/**
 * x402-fetch outcome states — unit coverage for the client payment wrapper.
 *
 * Closes the TEST-SPECS §6 client-side gaps (docs/architecture/TEST-SPECS.md):
 *   - cost ceiling refusal      → x402_cost_exceeded   (AC-X402-3)
 *   - no wallet → honest fail   → x402_no_wallet       (AC-X402-4)
 *   - second 402 stops retries  → x402_retry_blocked   (AC-X402-5)
 *   - signed happy path         → x402_signed          (AC-X402-2)
 * plus passthrough, unparseable envelope, signer error, and
 * resolveWalletConfig precedence.
 *
 * The unit under test is exercised for real: fetch is a queue-backed stub
 * returning genuine Response objects, and the signed path uses a real temp
 * signer module loaded through the documented UNBROWSE_X402_SIGNER=node:
 * hook — no internals are mocked.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  x402Fetch,
  resolveWalletConfig,
  type WalletConfig,
} from "../src/payments/x402-fetch";

// ---------------------------------------------------------------------------
// fetch stub: queue of responses; records requests so retry headers can be
// asserted. Returns real Response objects (x402Fetch calls .clone()).
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let queue: Response[] = [];
let seen: Array<{ url: string; headers: Record<string, string> }> = [];

function enqueue(...responses: Response[]) {
  queue.push(...responses);
}

function envelope402(amount?: string): Response {
  const body = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "solana:mainnet",
        asset: "USDC",
        ...(amount !== undefined ? { maxAmountRequired: amount } : {}),
        payTo: "recipient-address",
      },
    ],
  };
  return new Response(JSON.stringify(body), { status: 402 });
}

beforeEach(() => {
  queue = [];
  seen = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h) {
      if (h instanceof Headers) h.forEach((v, k) => { headers[k] = v; });
      else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
      else Object.assign(headers, h as Record<string, string>);
    }
    seen.push({ url: String(url), headers });
    const next = queue.shift();
    if (!next) throw new Error("fetch stub: queue empty");
    return next;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const NO_WALLET: WalletConfig = { adapter: "none", max_cost_usd: 1.0 };
const GENERIC: WalletConfig = {
  adapter: "generic",
  key_ref: "test-key-ref",
  max_cost_usd: 1.0,
};

describe("x402Fetch outcome states", () => {
  test("x402_passthrough: non-402 responses pass through unchanged", async () => {
    enqueue(new Response("ok", { status: 200 }));
    const { response, trace } = await x402Fetch("https://api.test/route", {}, NO_WALLET);
    expect(trace.sub_state).toBe("x402_passthrough");
    expect(trace.first_status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(seen).toHaveLength(1);
  });

  test("x402_envelope_unparseable: 402 with non-JSON body is surfaced honestly", async () => {
    enqueue(new Response("<html>payment required</html>", { status: 402 }));
    const { trace } = await x402Fetch("https://api.test/route", {}, GENERIC);
    expect(trace.sub_state).toBe("x402_envelope_unparseable");
    expect(trace.first_status).toBe(402);
    expect(seen).toHaveLength(1); // no blind retry
  });

  test("x402_no_wallet (AC-X402-4): 402 with no adapter is an honest failure, no retry", async () => {
    enqueue(envelope402("0.01"));
    const { response, trace } = await x402Fetch("https://api.test/route", {}, NO_WALLET);
    expect(trace.sub_state).toBe("x402_no_wallet");
    expect(trace.requested_cost_usd).toBe(0.01);
    expect(response.status).toBe(402); // original 402 returned, not fabricated success
    expect(seen).toHaveLength(1);
  });

  test("x402_cost_exceeded (AC-X402-3): quoted amount above ceiling refuses to sign", async () => {
    enqueue(envelope402("5.00"));
    const { trace } = await x402Fetch("https://api.test/route", {}, GENERIC);
    expect(trace.sub_state).toBe("x402_cost_exceeded");
    expect(trace.requested_cost_usd).toBe(5.0);
    expect(trace.max_cost_usd).toBe(1.0);
    expect(seen).toHaveLength(1); // refused before any payment attempt
  });

  test("x402_signer_error: generic adapter without a signing primitive fails honestly", async () => {
    const prev = process.env.UNBROWSE_X402_SIGNER;
    delete process.env.UNBROWSE_X402_SIGNER;
    try {
      enqueue(envelope402("0.01"));
      const { trace } = await x402Fetch("https://api.test/route", {}, GENERIC);
      expect(trace.sub_state).toBe("x402_signer_error");
      expect(trace.error).toContain("UNBROWSE_X402_SIGNER");
      expect(seen).toHaveLength(1);
    } finally {
      if (prev !== undefined) process.env.UNBROWSE_X402_SIGNER = prev;
    }
  });
});

describe("x402Fetch signed retry (real signer module via node: hook)", () => {
  let dir: string;
  let prevSigner: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "x402-signer-"));
    writeFileSync(
      join(dir, "signer.mjs"),
      `export async function signX402(envelope, keyRef) {
         return "b64-payment-proof-" + keyRef;
       }`,
    );
    prevSigner = process.env.UNBROWSE_X402_SIGNER;
    process.env.UNBROWSE_X402_SIGNER = `node:${join(dir, "signer.mjs")}`;
  });

  afterEach(() => {
    if (prevSigner !== undefined) process.env.UNBROWSE_X402_SIGNER = prevSigner;
    else delete process.env.UNBROWSE_X402_SIGNER;
    rmSync(dir, { recursive: true, force: true });
  });

  test("x402_signed (AC-X402-2): signs, retries once with X-PAYMENT, succeeds on 2xx", async () => {
    enqueue(envelope402("0.05"), new Response(JSON.stringify({ data: 42 }), { status: 200 }));
    const { response, trace } = await x402Fetch("https://api.test/route", {}, GENERIC);
    expect(trace.sub_state).toBe("x402_signed");
    expect(trace.first_status).toBe(402);
    expect(trace.retry_status).toBe(200);
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[1].headers["X-PAYMENT"]).toBe("b64-payment-proof-test-key-ref");
  });

  test("x402_retry_blocked (AC-X402-5): second 402 stops — exactly one retry, never a loop", async () => {
    enqueue(envelope402("0.05"), envelope402("0.05"));
    const { response, trace } = await x402Fetch("https://api.test/route", {}, GENERIC);
    expect(trace.sub_state).toBe("x402_retry_blocked");
    expect(trace.retry_status).toBe(402);
    expect(response.status).toBe(402);
    expect(seen).toHaveLength(2); // first + one signed retry, nothing more
  });
});

describe("resolveWalletConfig precedence (AC-WAL-1 env lanes)", () => {
  // HOME is pointed at an empty temp dir so this machine's real wallet
  // files can never leak into the assertions (the non-hermetic-test lesson).
  let emptyHome: string;
  beforeEach(() => {
    emptyHome = mkdtempSync(join(tmpdir(), "x402-home-"));
  });
  afterEach(() => {
    rmSync(emptyHome, { recursive: true, force: true });
  });

  test("explicit UNBROWSE_WALLET_ADAPTER override wins", () => {
    const cfg = resolveWalletConfig({
      HOME: emptyHome,
      UNBROWSE_WALLET_ADAPTER: "generic",
      UNBROWSE_WALLET_KEY: "k1",
    } as NodeJS.ProcessEnv);
    expect(cfg.adapter).toBe("generic");
    expect(cfg.key_ref).toBe("k1");
  });

  test("explicit 'none' disables auto-detection", () => {
    const cfg = resolveWalletConfig({
      HOME: emptyHome,
      UNBROWSE_WALLET_ADAPTER: "none",
      UNBROWSE_WALLET_KEY: "k1",
    } as NodeJS.ProcessEnv);
    expect(cfg.adapter).toBe("none");
  });

  test("lobster auto-detected from agents.json presence", () => {
    mkdirSync(join(emptyHome, ".lobster"), { recursive: true });
    writeFileSync(join(emptyHome, ".lobster", "agents.json"), "{}");
    const cfg = resolveWalletConfig({ HOME: emptyHome } as NodeJS.ProcessEnv);
    expect(cfg.adapter).toBe("lobster");
  });

  test("UNBROWSE_WALLET_KEY alone selects generic", () => {
    const cfg = resolveWalletConfig({
      HOME: emptyHome,
      UNBROWSE_WALLET_KEY: "raw-key",
    } as NodeJS.ProcessEnv);
    expect(cfg.adapter).toBe("generic");
    expect(cfg.key_ref).toBe("raw-key");
  });

  test("nothing configured resolves to none with $1.00 default ceiling", () => {
    const cfg = resolveWalletConfig({ HOME: emptyHome } as NodeJS.ProcessEnv);
    expect(cfg.adapter).toBe("none");
    expect(cfg.max_cost_usd).toBe(1.0);
  });

  test("UNBROWSE_X402_MAX_COST_USD parses and clamps at zero", () => {
    const cfg = resolveWalletConfig({
      HOME: emptyHome,
      UNBROWSE_X402_MAX_COST_USD: "0.25",
    } as NodeJS.ProcessEnv);
    expect(cfg.max_cost_usd).toBe(0.25);
    const neg = resolveWalletConfig({
      HOME: emptyHome,
      UNBROWSE_X402_MAX_COST_USD: "-3",
    } as NodeJS.ProcessEnv);
    expect(neg.max_cost_usd).toBe(0);
  });
});
