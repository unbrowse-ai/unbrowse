// tests/mcp-x402.test.ts
// evidence-build unbrowse-payment-gate — lanes: mcp-402-carried (AC4),
// mcp-cli-payment-parity (AC5), splits-settle-on-mcp (AC6). NO MOCKS.
// Real source-integration falsifiers + a real split-math invariant guard.
// Failing-first on v6.17.0-preview.6: src/mcp.ts api() returns a backend
// 402 as the bare string `HTTP 402: ...` (src/mcp.ts:1050) and never routes
// it through the shared payment path the CLI uses (src/client/index.ts:642).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { computeFlexSplits, PLATFORM_BPS } from "../backend/src/services/flex.js";

const root = path.join(import.meta.dir, "..");
const mcpSrc = readFileSync(path.join(root, "src/mcp.ts"), "utf8");
const clientSrc = readFileSync(path.join(root, "src/client/index.ts"), "utf8");

// AC4 mcp-402-carried — the MCP execute path must, on a backend 402, pay and
// retry (or surface the structured gate), not return a bare HTTP error.
// sources: code:src/mcp.ts#L1033, code:src/client/index.ts#L642, podman:mcp-x402.
describe("mcp-402-carried", () => {
  test("src/mcp.ts non-2xx path is payment-aware, not a bare HTTP error", () => {
    // Today: `return { error: \`HTTP ${res.statusCode}: ${text}\` };`
    const swallows = /return \{ error: `HTTP \$\{res\.statusCode\}/.test(mcpSrc);
    const paymentAware = /payAndRetry|handlePaymentRequired|checkPaymentRequirement|isX402Error/.test(
      mcpSrc,
    );
    // Fails today: the bare-error swallow is present AND no payment handling
    // is wired into the MCP path.
    expect(swallows && !paymentAware).toBe(false);
  });
});

// AC5 mcp-cli-payment-parity — CLI and MCP must reach the SAME payment-on-402
// handler. sources: code:src/client/index.ts#L642, code:src/mcp.ts#L1033.
describe("mcp-cli-payment-parity", () => {
  test("both surfaces share one payment-on-402 path", () => {
    const cliPays = /payAndRetry/.test(clientSrc); // present today (client:642)
    const mcpPays = /payAndRetry|handlePaymentRequired/.test(mcpSrc); // absent today
    expect(cliPays).toBe(true); // sanity: the CLI path really does pay
    expect(mcpPays).toBe(true); // RED today: MCP has no equivalent
  });
});

// AC6 splits-settle-on-mcp — the split MATH must stay correct (NON-GOAL: do
// not change it); only the MCP-reaches-it wiring is the gap. This half is a
// green regression guard. sources: code:backend/src/services/flex.ts#L34,
// code:src/mcp.ts#L1033, podman:mcp-x402.
describe("splits-settle-on-mcp", () => {
  test("computeFlexSplits keeps platform 1000 bps / contributors 9000 bps", () => {
    expect(PLATFORM_BPS).toBe(1000);
    const splits = computeFlexSplits(
      { contributors: [{ wallet_address: "Wabc", cumulative_delta: 1 } as never] },
      "PLATFORMWALLET",
    );
    const platform = splits.find((s) => s.recipient === "PLATFORMWALLET");
    expect(platform?.bps).toBe(1000);
    const total = splits.reduce((n, s) => n + s.bps, 0);
    expect(total).toBe(10000);
  });
});
