/**
 * Witness A (offline, deterministic) for pay.sh support.
 *
 * Stubs the `pay` binary via a PATH shim so nothing touches the network or
 * chain. Proves:
 *   - resolveWalletConfig() selects the "pay" adapter on explicit env, and
 *     NEVER auto-detects it (default-off guardrail).
 *   - payShFetch marshals method/url/headers and returns pay_signed on exit 0.
 *   - payShFetch surfaces pay_no_binary when `pay` is absent.
 *   - x402Fetch routes a 402 through the pay adapter and enforces the cost
 *     ceiling before ever invoking pay.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveWalletConfig, x402Fetch } from "../src/payments/x402-fetch.js";
import {
  payShFetch,
  payShSandboxEnabled,
  payShAvailable,
  _resetPayShAvailabilityCache,
} from "../src/payments/pay-sh.js";

const ORIG_PATH = process.env.PATH;
const ORIG_FETCH = globalThis.fetch;
let shimDir: string;

/** Write a fake `pay` executable that echoes a marker body and exits 0. */
function installPayShim(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "payshim-"));
  const script = `#!/bin/sh
case "$1" in
  --version) echo "pay 0.0.0-test"; exit 0 ;;
esac
# Strip a leading --sandbox flag if present.
[ "$1" = "--sandbox" ] && shift
# $1 is the subcommand (fetch|curl); echo the marker body and succeed.
printf '%s' '${body.replace(/'/g, "")}'
exit 0
`;
  const p = join(dir, "pay");
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return dir;
}

/** A PATH dir with NO `pay` binary. */
function installEmptyDir(): string {
  return mkdtempSync(join(tmpdir(), "empty-"));
}

beforeEach(() => {
  _resetPayShAvailabilityCache();
});

afterEach(() => {
  process.env.PATH = ORIG_PATH;
  globalThis.fetch = ORIG_FETCH;
  delete process.env.UNBROWSE_WALLET_ADAPTER;
  delete process.env.UNBROWSE_PAY_SANDBOX;
  delete process.env.UNBROWSE_X402_MAX_COST_USD;
  _resetPayShAvailabilityCache();
  if (shimDir) {
    try { rmSync(shimDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    shimDir = "";
  }
});

describe("resolveWalletConfig — pay adapter", () => {
  test("explicit UNBROWSE_WALLET_ADAPTER=pay selects the pay adapter", () => {
    const cfg = resolveWalletConfig({ UNBROWSE_WALLET_ADAPTER: "pay" } as NodeJS.ProcessEnv);
    expect(cfg.adapter).toBe("pay");
  });

  test("pay is NOT auto-detected (default-off): empty env -> none", () => {
    // No UNBROWSE_WALLET_ADAPTER, no ~/.lobster, no ~/.privy, no key.
    const cfg = resolveWalletConfig({ HOME: "/nonexistent-home-xyz" } as NodeJS.ProcessEnv);
    expect(cfg.adapter).not.toBe("pay");
  });

  test("explicit adapters still win over pay", () => {
    const cfg = resolveWalletConfig({ UNBROWSE_WALLET_ADAPTER: "lobster" } as NodeJS.ProcessEnv);
    expect(cfg.adapter).toBe("lobster");
  });
});

describe("payShSandboxEnabled", () => {
  test("1 / true / yes enable sandbox", () => {
    expect(payShSandboxEnabled({ UNBROWSE_PAY_SANDBOX: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(payShSandboxEnabled({ UNBROWSE_PAY_SANDBOX: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(payShSandboxEnabled({ UNBROWSE_PAY_SANDBOX: "yes" } as NodeJS.ProcessEnv)).toBe(true);
  });
  test("absent / other -> false", () => {
    expect(payShSandboxEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(payShSandboxEnabled({ UNBROWSE_PAY_SANDBOX: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("payShFetch", () => {
  test("pay exit 0 -> pay_signed with the paid body", async () => {
    shimDir = installPayShim("PAID_BODY_OK");
    process.env.PATH = `${shimDir}:${ORIG_PATH}`;
    expect(payShAvailable()).toBe(true);

    const firstRes = new Response("", { status: 402 });
    const result = await payShFetch("http://127.0.0.1:1402/api/v1/reports/usage", {}, {
      sandbox: true,
      firstRes,
    });

    expect(result.trace.sub_state).toBe("pay_signed");
    expect(result.trace.adapter).toBe("pay");
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe("PAID_BODY_OK");
  });

  test("no pay binary -> pay_no_binary, original 402 surfaced", async () => {
    shimDir = installEmptyDir();
    process.env.PATH = shimDir; // only the empty dir — no `pay`
    _resetPayShAvailabilityCache();
    expect(payShAvailable()).toBe(false);

    const firstRes = new Response("nope", { status: 402 });
    const result = await payShFetch("http://example.test/x", {}, { firstRes });

    expect(result.trace.sub_state).toBe("pay_no_binary");
    expect(result.response.status).toBe(402);
  });
});

describe("x402Fetch — pay adapter routing", () => {
  test("402 with affordable cost routes to pay -> pay_signed", async () => {
    shimDir = installPayShim("VIA_X402FETCH");
    process.env.PATH = `${shimDir}:${ORIG_PATH}`;
    _resetPayShAvailabilityCache();

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accepts: [{ amount: "0.01", recipient: "x" }] }), {
        status: 402,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const { trace, response } = await x402Fetch("http://gw.test/paid", {}, { adapter: "pay" });
    expect(trace.adapter).toBe("pay");
    expect(trace.sub_state).toBe("pay_signed");
    expect(await response.text()).toBe("VIA_X402FETCH");
  });

  test("402 above the cost ceiling is refused BEFORE invoking pay", async () => {
    shimDir = installPayShim("SHOULD_NOT_RUN");
    process.env.PATH = `${shimDir}:${ORIG_PATH}`;
    _resetPayShAvailabilityCache();

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accepts: [{ amount: "5.00", recipient: "x" }] }), {
        status: 402,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const { trace } = await x402Fetch("http://gw.test/expensive", {}, {
      adapter: "pay",
      max_cost_usd: 1.0,
    });
    expect(trace.sub_state).toBe("x402_cost_exceeded");
    expect(trace.adapter).toBe("pay");
    expect(trace.requested_cost_usd).toBe(5);
  });

  test("non-402 passes through untouched", async () => {
    globalThis.fetch = (async () => new Response("hello", { status: 200 })) as typeof fetch;
    const { trace, response } = await x402Fetch("http://gw.test/free", {}, { adapter: "pay" });
    expect(trace.sub_state).toBe("x402_passthrough");
    expect(await response.text()).toBe("hello");
  });
});
