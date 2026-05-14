import { describe, test, expect } from "bun:test";
import { Unbrowse } from "../src/client.js";
import {
  buildFlexAuthorization,
  payAndRetryFlex,
  fundEscrow,
  registerSessionKey,
  type FlexAuthorization,
  type FlexWalletLike,
} from "../src/flex.js";
import { PaymentRequiredError } from "../src/errors.js";

describe("flex — Day 3 seeds", () => {
  test("buildFlexAuthorization stub rejects with not-yet-implemented", async () => {
    await expect(
      buildFlexAuthorization({
        escrow: "X",
        mint: "USDC",
        maxAmount: "1000",
        splits: [{ recipient: "C", bps: 10000 }],
        expiresAtSlot: "12345",
      }),
    ).rejects.toThrow(/not yet implemented/);
  });

  test("fundEscrow stub rejects with not-yet-implemented", async () => {
    await expect(
      fundEscrow({
        walletAddress: "W",
        facilitatorAddress: "F",
        amountUsdc: "1000000",
      }),
    ).rejects.toThrow(/not yet implemented/);
  });

  test("registerSessionKey stub rejects with not-yet-implemented", async () => {
    await expect(
      registerSessionKey({
        walletAddress: "W",
        escrowAddress: "E",
        sessionKeyAddress: "S",
      }),
    ).rejects.toThrow(/not yet implemented/);
  });

  test("Unbrowse#fundEscrow stub rejects", async () => {
    const u = new Unbrowse({ baseUrl: "http://127.0.0.1:1" });
    await expect(u.fundEscrow({ amountUsdc: "1000000" })).rejects.toThrow(
      /not yet implemented/,
    );
  });

  test("FlexAuthorization shape compiles with valid splits sum", () => {
    const auth: FlexAuthorization = {
      escrow: "X",
      mint: "USDC",
      maxAmount: "1000",
      authorizationId: "1",
      expiresAtSlot: "12345",
      splits: [
        { recipient: "C", bps: 9000 },
        { recipient: "P", bps: 1000 },
      ],
    };
    const sum = auth.splits.reduce((s, e) => s + e.bps, 0);
    expect(sum).toBe(10000);

    // Compile-check the wallet contract too — Day-4 will exercise this.
    const _wallet: FlexWalletLike = {
      address: "W",
      sessionKeyAddress: "S",
      signFlexAuthorization: async () => "sig",
    };
    expect(_wallet.address).toBe("W");
  });

  test("payAndRetryFlex stub rejects with not-yet-implemented", async () => {
    const err = new PaymentRequiredError("402", [], "http://example", "skill");
    const wallet: FlexWalletLike = {
      address: "W",
      sessionKeyAddress: "S",
      signFlexAuthorization: async () => "sig",
    };
    await expect(
      payAndRetryFlex(err, wallet, async () => ({ ok: true })),
    ).rejects.toThrow(/not yet implemented/);
  });
});
