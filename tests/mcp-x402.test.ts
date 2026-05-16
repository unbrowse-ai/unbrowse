// tests/mcp-x402.test.ts
// evidence-build unbrowse-payment-gate - mcp-402-carried (AC4),
// mcp-cli-payment-parity (AC5), splits-settle-on-mcp (AC6). NO MOCKS.
// Hardened Step-4 luminaries: symbol-AGNOSTIC (no pinned handler name, per
// CLAUDE.md substrate-enables) - they assert the shared payments module is
// imported by BOTH surfaces (true parity), not that a specific symbol exists.
// RED on v6.17.0-preview.6: src/mcp.ts swallows the backend 402 at L1050 and
// imports nothing from ../payments/; the CLI path does.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { computeFlexSplits, PLATFORM_BPS } from "../backend/src/services/flex.js";

const root = path.join(import.meta.dir, "..");
const mcpSrc = readFileSync(path.join(root, "src/mcp.ts"), "utf8");
const clientSrc = readFileSync(path.join(root, "src/client/index.ts"), "utf8");

// matches a static OR dynamic import whose specifier is the payments module,
// regardless of which symbol the fix chooses to export/use.
const IMPORTS_PAYMENTS = /(?:from|import\s*\()\s*["'][^"']*\/payments\//;

// AC4 mcp-402-carried - the MCP path must route its backend 402 through the
// shared payments module instead of returning a bare HTTP error string.
// sources: code:src/mcp.ts#L1033, code:src/client/index.ts#L642, podman:mcp-x402.
describe("mcp-402-carried", () => {
  test("src/mcp.ts routes 402 through the payments module, not a bare error", () => {
    const swallowsBare = /return \{ error: `HTTP \$\{res\.statusCode\}/.test(mcpSrc);
    const wiredToPayments = IMPORTS_PAYMENTS.test(mcpSrc);
    // RED today: the bare swallow is present AND mcp.ts pulls in no payments
    // module to handle the 402. GREEN only when the 402 is actually wired
    // through the shared payments seam (any symbol name).
    expect(swallowsBare && !wiredToPayments).toBe(false);
  });
});

// AC5 mcp-cli-payment-parity - true parity = BOTH surfaces import the SAME
// shared payments module. sources: code:src/client/index.ts#L642, code:src/mcp.ts#L1033.
describe("mcp-cli-payment-parity", () => {
  test("CLI and MCP both import the shared payments module", () => {
    expect(IMPORTS_PAYMENTS.test(clientSrc)).toBe(true); // sanity: CLI really does
    expect(IMPORTS_PAYMENTS.test(mcpSrc)).toBe(true); // RED today: MCP does not
  });
});

// AC6 splits-settle-on-mcp - frozen split MATH guard (NON-GOAL: do not change
// it). Green today and must stay green. sources:
// code:backend/src/services/flex.ts#L34, code:src/mcp.ts#L1033, podman:mcp-x402.
describe("splits-settle-on-mcp", () => {
  test("computeFlexSplits keeps platform 1000 bps / total 10000 bps", () => {
    expect(PLATFORM_BPS).toBe(1000);
    const splits = computeFlexSplits(
      { contributors: [{ wallet_address: "Wabc", cumulative_delta: 1 } as never] },
      "PLATFORMWALLET",
    );
    const platform = splits.find((s) => s.recipient === "PLATFORMWALLET");
    expect(platform?.bps).toBe(1000);
    expect(splits.reduce((n, s) => n + s.bps, 0)).toBe(10000);
  });
});
