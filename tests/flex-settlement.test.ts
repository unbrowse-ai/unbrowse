// tests/flex-settlement.test.ts
// evidence-build unbrowse-flex-settlement — Step-4 hardened luminaries.
// Every assertion is a TRUE falsifier (RED today for the genuine reason,
// GREEN only iff the lane is really met). NO MOCKS: real seam, real
// X402_CONFIG, real source files, real git. Mirrors tests/payment-wiring.
import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { settleViaFlex, flexFacilitatorUrl } from "../src/payments/flex-pay.js";

const origEnv = { ...process.env };
afterEach(() => { process.env = { ...origEnv }; });

const FLEX_402 = {
  x402Version: 2,
  error: "Payment Required",
  resource: { url: "https://beta-api.unbrowse.ai/v1/skills/x/execute", description: "x", mimeType: "application/json" },
  accepts: [{
    scheme: "@faremeter/flex", network: "solana-mainnet", amount: "1000",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "EscRoWpubkey", maxTimeoutSeconds: 60,
    extra: {
      flexAuthorizationDraft: { escrow: "EscRoWpubkey", mint: "EPjF", maxAmount: "1000", authorizationId: "42", expiresAtSlot: "9999", splits: [{ recipient: "PLAT", bps: 1000 }, { recipient: "CONTRIB", bps: 9000 }] },
      splits: [{ recipient: "PLAT", bps: 1000 }, { recipient: "CONTRIB", bps: 9000 }],
      programId: "FLeXprogram",
    },
  }],
} as const;
const FLEX_PAY_SRC = readFileSync(new URL("../src/payments/flex-pay.ts", import.meta.url), "utf8");

// LANE payai-facilitator-submit / escrow-session-key — no hardcoded host.
// Step-4 fix of the FALSE_GREEN: value-equality alone passes a hardcoded
// literal (X402_CONFIG default IS that literal). Pin it STRUCTURALLY.
describe("flex facilitator config (no hardcode)", () => {
  test("flexFacilitatorUrl tracks the declared env config (sentinel subprocess)", () => {
    // True falsifier, not a tautology (CLAUDE.md case-study #6): a real child
    // process with a unique test-CHOSEN sentinel UNBROWSE_X402_FACILITATOR.
    // The expected value is never re-derived from the production expression.
    // If flex-pay ever returns a hardcoded literal instead of reading the
    // declared X402_CONFIG, the sentinel is absent and this goes RED.
    const sentinel = `https://sentinel-${Date.now()}.facilitator.test`;
    const fp = new URL("../src/payments/flex-pay.ts", import.meta.url).pathname;
    const out = execSync(
      "bun -e 'import(process.env.__FP).then(m=>process.stdout.write(m.flexFacilitatorUrl()))'",
      {
        env: { ...process.env, __FP: fp, UNBROWSE_X402_FACILITATOR: sentinel },
        encoding: "utf8",
      },
    ).trim();
    expect(out).toBe(sentinel);
    expect(flexFacilitatorUrl()).toMatch(/^https:\/\//);
  });
  test("flex-pay.ts source contains NO hardcoded facilitator host literal", () => {
    // declared-config-only: the only allowed source of the URL is X402_CONFIG.
    expect(FLEX_PAY_SRC).not.toMatch(/https:\/\/facilitator\.|payai\.network|facilitator\.corbits/);
  });
});

// LANE splits-from-frozen-computeFlexSplits — behavioral, not shape.
// Step-4 fix of the FALSE_GREEN: pin the signed authorization splits to the
// EXACT 402 terms splits. A recompute/drop/renormalize makes this RED.
describe("settleViaFlex authorize+submit+retry", () => {
  test("settles a Flex 402 and signs the FROZEN 402-terms splits verbatim", async () => {
    const r = await settleViaFlex("https://beta-api.unbrowse.ai/v1/skills/x/execute", FLEX_402);
    expect(r).not.toBeNull();
    expect((r as { settled?: true })?.settled).toBe(true);
    // behavioral pin: the splits actually signed === the 402 terms splits,
    // never a client recompute (AC4 by behavior, not just topology).
    expect((r as { authorization?: { splits?: unknown } })?.authorization?.splits)
      .toEqual(FLEX_402.accepts[0].extra.splits);
  });
  test("returns null (caller falls back) when the 402 is not a Flex scheme", async () => {
    const nonFlex = { x402Version: 2, error: "Payment Required", resource: { url: "u", description: "d", mimeType: "m" }, accepts: [{ scheme: "exact", network: "solana-mainnet", amount: "1", asset: "x", payTo: "p", maxTimeoutSeconds: 60 }] };
    expect(await settleViaFlex("https://x", nonFlex as never)).toBeNull();
  });
  test("never returns an {error} object (would break MCP resolveNestedError)", async () => {
    try {
      const r = await settleViaFlex("https://x", FLEX_402);
      expect((r as Record<string, unknown> | null)?.error).toBeUndefined();
    } catch (e) { expect(e).toBeInstanceOf(Error); }
  });
});

// LANE mcp-cli-settle-parity — both surfaces reach the shared seam.
// Symbol-agnostic: assert each 402-handling file references the flex-pay
// module (or settleViaFlex) before its fallback. RED now (neither does).
describe("mcp-cli-settle-parity", () => {
  test("both src/client/index.ts and src/mcp.ts reach the shared Flex seam", () => {
    const client = readFileSync(new URL("../src/client/index.ts", import.meta.url), "utf8");
    const mcp = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
    const REFS = /flex-pay|settleViaFlex/;
    expect(REFS.test(client)).toBe(true);
    expect(REFS.test(mcp)).toBe(true);
  });
});

// LANE deps-present — flex-pay can resolve a real Flex signing primitive.
// RED now: the seed imports only TYPES; GREEN when it imports the runtime
// signer from @unbrowse/sdk (packages/sdk) or @faremeter in deps.
describe("deps-present", () => {
  test("flex-pay.ts imports a runtime Flex signing primitive (sdk or @faremeter)", () => {
    const importsSdkSigner = /(payAndRetryFlex|buildFlexAuthorization)[\s\S]*from\s+['"](@unbrowse\/sdk|(\.\.\/)+packages\/sdk)/.test(FLEX_PAY_SRC)
      || /from\s+['"]@faremeter\//.test(FLEX_PAY_SRC);
    expect(importsSdkSigner).toBe(true);
  });
});

// LANE splits-from-frozen — flex.ts zero-diff guard. GREEN now, MUST stay.
describe("computeFlexSplits frozen (zero-diff guard)", () => {
  test("backend/src/services/flex.ts has zero diff vs evidence baseline 959ec8cb", () => {
    const out = execSync("git diff --stat 959ec8cb -- backend/src/services/flex.ts", { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname }).trim();
    expect(out).toBe("");
  });
});
