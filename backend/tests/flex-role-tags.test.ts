/**
 * Contract organ 98973c11 stage G3 — FlexSplit role tags + maintainer
 * + treasury lanes (paper §3.5 $F = C + M + I + T$).
 *
 * Asserts:
 *   1. Every existing split in the 3-role flow now carries a role tag.
 *   2. Backwards-compat: passing no roleConfig reproduces today's
 *      3-role byte-for-byte (modulo the new role field).
 *   3. With maintainer+treasury config supplied, the splits array
 *      includes those roles at the right bps, and the contributor pool
 *      shrinks accordingly to keep sum=10000.
 *   4. The Flex on-chain program only consumes `{ recipient, bps }`; the
 *      role tag is off-chain only. Strip-and-resum invariant verified.
 *
 * Per CLAUDE.md "Never mock in tests" — real computeFlexSplits.
 */
import { describe, it, expect } from "bun:test";
import {
  computeFlexSplits,
  PLATFORM_BPS,
  OWNER_BPS,
  type FlexSplit,
  type FlexSplitRole,
} from "../src/services/flex.js";

const PLATFORM = "platform-usdc-ata";
const OWNER = "owner-usdc-ata";
const MAINTAINER = "maintainer-usdc-ata";
const TREASURY = "treasury-usdc-ata";
const CONTRIB_A = "contributor-a-usdc-ata";
const CONTRIB_B = "contributor-b-usdc-ata";

function roleOf(splits: FlexSplit[], recipient: string): FlexSplitRole | undefined {
  return splits.find((s) => s.recipient === recipient)?.role;
}

function sumBps(splits: FlexSplit[]): number {
  return splits.reduce((s, x) => s + x.bps, 0);
}

describe("FlexSplit role tags (G3)", () => {
  it("tags platform-only split as 'infrastructure'", () => {
    const splits = computeFlexSplits(
      { contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }] } as any,
      PLATFORM,
    );
    expect(roleOf(splits, PLATFORM)).toBe("infrastructure");
  });

  it("tags contributor splits as 'contributor'", () => {
    const splits = computeFlexSplits(
      {
        contributors: [
          { wallet_address: CONTRIB_A, cumulative_delta: 2 },
          { wallet_address: CONTRIB_B, cumulative_delta: 1 },
        ],
      } as any,
      PLATFORM,
    );
    expect(roleOf(splits, CONTRIB_A)).toBe("contributor");
    expect(roleOf(splits, CONTRIB_B)).toBe("contributor");
  });

  it("tags owner split as 'site_owner' when opted in", () => {
    const splits = computeFlexSplits(
      {
        contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }],
        owner_compensation_opt_in: true,
        owner_wallet_usdc_ata: OWNER,
      } as any,
      PLATFORM,
    );
    expect(roleOf(splits, OWNER)).toBe("site_owner");
  });

  it("backwards-compat: no roleConfig produces same numerical splits as before", () => {
    const splits = computeFlexSplits(
      {
        contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }],
        owner_compensation_opt_in: true,
        owner_wallet_usdc_ata: OWNER,
      } as any,
      PLATFORM,
    );
    expect(splits.find((s) => s.recipient === PLATFORM)?.bps).toBe(PLATFORM_BPS);
    expect(splits.find((s) => s.recipient === OWNER)?.bps).toBe(OWNER_BPS);
    expect(splits.find((s) => s.recipient === CONTRIB_A)?.bps).toBe(10000 - PLATFORM_BPS - OWNER_BPS);
    expect(sumBps(splits)).toBe(10000);
    // No maintainer / treasury role appears
    expect(splits.find((s) => s.role === "maintainer")).toBeUndefined();
    expect(splits.find((s) => s.role === "treasury")).toBeUndefined();
  });

  it("emits maintainer + treasury lanes when roleConfig populated", () => {
    const splits = computeFlexSplits(
      {
        contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }],
      } as any,
      PLATFORM,
      {
        maintainer_bps: 500,
        maintainer_recipient: MAINTAINER,
        treasury_bps: 500,
        treasury_recipient: TREASURY,
      },
    );
    expect(roleOf(splits, MAINTAINER)).toBe("maintainer");
    expect(roleOf(splits, TREASURY)).toBe("treasury");
    expect(splits.find((s) => s.recipient === MAINTAINER)?.bps).toBe(500);
    expect(splits.find((s) => s.recipient === TREASURY)?.bps).toBe(500);
    // Contributor pool shrinks by 1000 bps (500 + 500)
    expect(splits.find((s) => s.recipient === CONTRIB_A)?.bps).toBe(10000 - PLATFORM_BPS - 500 - 500);
    expect(sumBps(splits)).toBe(10000);
  });

  it("paper-faithful 5-role partition sums to 10000 (I + S + M + T + C)", () => {
    const splits = computeFlexSplits(
      {
        contributors: [
          { wallet_address: CONTRIB_A, cumulative_delta: 2 },
          { wallet_address: CONTRIB_B, cumulative_delta: 1 },
        ],
        owner_compensation_opt_in: true,
        owner_wallet_usdc_ata: OWNER,
      } as any,
      PLATFORM,
      {
        maintainer_bps: 500,
        maintainer_recipient: MAINTAINER,
        treasury_bps: 500,
        treasury_recipient: TREASURY,
      },
    );
    const roles = new Set(splits.map((s) => s.role));
    expect(roles.has("infrastructure")).toBe(true);
    expect(roles.has("site_owner")).toBe(true);
    expect(roles.has("maintainer")).toBe(true);
    expect(roles.has("treasury")).toBe(true);
    expect(roles.has("contributor")).toBe(true);
    expect(sumBps(splits)).toBe(10000);
  });

  it("ignores maintainer lane when bps>0 but recipient unset (env half-configured)", () => {
    const splits = computeFlexSplits(
      { contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }] } as any,
      PLATFORM,
      { maintainer_bps: 500 }, // no recipient
    );
    expect(splits.find((s) => s.role === "maintainer")).toBeUndefined();
    // Contributor pool not docked
    expect(splits.find((s) => s.recipient === CONTRIB_A)?.bps).toBe(10000 - PLATFORM_BPS);
  });

  it("ignores treasury lane when recipient set but bps=0", () => {
    const splits = computeFlexSplits(
      { contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }] } as any,
      PLATFORM,
      { treasury_bps: 0, treasury_recipient: TREASURY },
    );
    expect(splits.find((s) => s.role === "treasury")).toBeUndefined();
  });

  it("clamps maintainer_bps > 10000 to 10000 (defensive)", () => {
    const splits = computeFlexSplits(
      {} as any,
      PLATFORM,
      { maintainer_bps: 50000, maintainer_recipient: MAINTAINER },
    );
    expect(splits.find((s) => s.role === "maintainer")?.bps).toBe(10000);
  });

  it("Flex on-chain compat: stripping role still leaves a valid 10000-bps array", () => {
    const splits = computeFlexSplits(
      {
        contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }],
      } as any,
      PLATFORM,
      {
        maintainer_bps: 500,
        maintainer_recipient: MAINTAINER,
        treasury_bps: 500,
        treasury_recipient: TREASURY,
      },
    );
    // Simulate the on-chain serializer dropping unknown fields
    const onChain = splits.map(({ recipient, bps }) => ({ recipient, bps }));
    expect(onChain.reduce((s, x) => s + x.bps, 0)).toBe(10000);
    // No on-chain entry carries the role field
    expect(onChain.every((s) => !("role" in s))).toBe(true);
  });
});
