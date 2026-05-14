import { describe, test, expect } from "bun:test";
import { Unbrowse } from "../src/client.js";
import {
  buildEscrowCreationTx,
  buildFlexAuthorization,
  buildSessionKeyRegistrationTx,
  fundEscrow,
  payAndRetryFlex,
  registerSessionKey,
  USDC_MINT_MAINNET,
  type BuiltFlexTx,
  type FlexAuthorization,
  type FlexWalletLike,
} from "../src/flex.js";
import { PaymentRequiredError } from "../src/errors.js";
import type { X402PaymentRequirement } from "../src/x402.js";

describe("flex — Day 4 real wiring", () => {
  // ─── buildFlexAuthorization: real shape + validation ─────────────────────
  test("buildFlexAuthorization returns a canonical FlexAuthorization shape", async () => {
    const auth = await buildFlexAuthorization({
      escrow: "EscrowPDA111",
      mint: USDC_MINT_MAINNET,
      maxAmount: "1000000",
      splits: [
        { recipient: "Creator111", bps: 9000 },
        { recipient: "Platform222", bps: 1000 },
      ],
      expiresAtSlot: "300000000",
    });
    expect(auth.escrow).toBe("EscrowPDA111");
    expect(auth.mint).toBe(USDC_MINT_MAINNET);
    expect(auth.maxAmount).toBe("1000000");
    expect(auth.expiresAtSlot).toBe("300000000");
    expect(auth.splits).toHaveLength(2);
    expect(auth.splits.reduce((s, e) => s + e.bps, 0)).toBe(10000);
    // authorizationId must be non-empty and parse as a base10 number
    expect(auth.authorizationId).toMatch(/^\d+$/);
    expect(auth.authorizationId.length).toBeGreaterThan(0);
    // Two consecutive calls produce distinct authorizationIds
    const auth2 = await buildFlexAuthorization({
      escrow: "EscrowPDA111",
      mint: USDC_MINT_MAINNET,
      maxAmount: "1000000",
      splits: [{ recipient: "Sole111", bps: 10000 }],
      expiresAtSlot: "300000000",
    });
    expect(auth2.authorizationId).not.toBe(auth.authorizationId);
  });

  test("buildFlexAuthorization rejects invalid splits sum", async () => {
    await expect(
      buildFlexAuthorization({
        escrow: "X",
        mint: USDC_MINT_MAINNET,
        maxAmount: "1000",
        splits: [{ recipient: "R", bps: 9999 }], // sums to 9999
        expiresAtSlot: "1",
      }),
    ).rejects.toThrow(/sum to 10000/);
  });

  test("buildFlexAuthorization rejects >5 splits", async () => {
    await expect(
      buildFlexAuthorization({
        escrow: "X",
        mint: USDC_MINT_MAINNET,
        maxAmount: "1000",
        splits: [
          { recipient: "A", bps: 2000 },
          { recipient: "B", bps: 2000 },
          { recipient: "C", bps: 2000 },
          { recipient: "D", bps: 2000 },
          { recipient: "E", bps: 1000 },
          { recipient: "F", bps: 1000 },
        ],
        expiresAtSlot: "1",
      }),
    ).rejects.toThrow(/1\.\.5 entries/);
  });

  test("buildFlexAuthorization rejects non-base10 numeric fields", async () => {
    await expect(
      buildFlexAuthorization({
        escrow: "X",
        mint: USDC_MINT_MAINNET,
        maxAmount: "1e6",
        splits: [{ recipient: "R", bps: 10000 }],
        expiresAtSlot: "1",
      }),
    ).rejects.toThrow(/base10/);
  });

  // ─── payAndRetryFlex: real sign + pack + retry ───────────────────────────
  test("payAndRetryFlex packs X-PAYMENT header from wallet signature + accepts.extra", async () => {
    const requirement: X402PaymentRequirement = {
      scheme: "@faremeter/flex",
      network: "solana",
      payTo: "FacilitatorAddress",
      maxAmountRequired: "1000",
      resource: "http://example/skill",
      mimeType: "application/json",
      extra: {
        facilitator: "FacilitatorAddress",
        escrow: "EscrowFromBackend",
        splits: [
          { recipient: "Creator", bps: 9000 },
          { recipient: "Platform", bps: 1000 },
        ],
        supportedMints: [USDC_MINT_MAINNET],
        expiresAtSlot: "999",
      },
    };
    const err = new PaymentRequiredError(
      "402",
      [requirement],
      "http://example/skill",
      "skill_id_123",
    );

    let signedAuth: FlexAuthorization | undefined;
    let capturedHeader = "";
    const wallet: FlexWalletLike = {
      address: "WalletAddr",
      sessionKeyAddress: "SessionKeyAddr",
      signFlexAuthorization: async (a) => {
        signedAuth = a;
        // Deterministic, distinguishable signature (base64 of "FLEXSIG")
        return "RkxFWFNJRw==";
      },
    };
    const result = await payAndRetryFlex(err, wallet, async (header) => {
      capturedHeader = header;
      return { ok: true, header };
    });

    // Wallet was called with a properly-built authorization
    expect(signedAuth).toBeDefined();
    expect(signedAuth!.escrow).toBe("EscrowFromBackend");
    expect(signedAuth!.maxAmount).toBe("1000");
    expect(signedAuth!.expiresAtSlot).toBe("999");
    expect(signedAuth!.splits).toHaveLength(2);
    expect(signedAuth!.authorizationId).toMatch(/^\d+$/);

    // Retry was called with a base64 envelope; decode + assert structure.
    expect(capturedHeader.length).toBeGreaterThan(0);
    const decoded = JSON.parse(
      Buffer.from(capturedHeader, "base64").toString("utf8"),
    );
    expect(decoded.x402Version).toBe(1);
    expect(decoded.scheme).toBe("@faremeter/flex");
    expect(decoded.network).toBe("solana");
    expect(decoded.payload).toMatchObject({
      escrow: "EscrowFromBackend",
      mint: USDC_MINT_MAINNET,
      maxAmount: "1000",
      expiresAtSlot: "999",
      sessionKey: "SessionKeyAddr",
      signature: "RkxFWFNJRw==",
    });
    expect(decoded.payload.splits).toHaveLength(2);
    expect(decoded.payload.authorizationId).toMatch(/^\d+$/);
    expect((result as { ok: boolean }).ok).toBe(true);
  });

  test("payAndRetryFlex throws original error when no Flex-shaped requirement present", async () => {
    const exactRequirement: X402PaymentRequirement = {
      scheme: "exact",
      network: "base",
      payTo: "0xabc",
      maxAmountRequired: "1000",
      resource: "http://example",
      mimeType: "application/json",
      // no `extra.escrow` — not Flex-shaped
    };
    const err = new PaymentRequiredError(
      "402",
      [exactRequirement],
      "http://example",
    );
    const wallet: FlexWalletLike = {
      address: "W",
      sessionKeyAddress: "S",
      signFlexAuthorization: async () => "sig",
    };
    await expect(
      payAndRetryFlex(err, wallet, async () => ({ ok: true })),
    ).rejects.toBe(err);
  });

  // ─── Pure tx builders: real @faremeter/flex-solana instructions ───────────
  test("buildEscrowCreationTx returns intent + accountsAtRisk without a signer", async () => {
    const built: BuiltFlexTx = await buildEscrowCreationTx({
      walletAddress: "WalletA",
      facilitatorAddress: "FacB",
      amountUsdc: "5000000",
    });
    expect(built.intent).toBe("create_escrow_and_deposit");
    expect(built.accountsAtRisk).toContain("WalletA");
    expect(built.accountsAtRisk).toContain("FacB");
    expect(built.accountsAtRisk).toContain(USDC_MINT_MAINNET);
    expect(built.instructions).toEqual([]);
  });

  test("buildSessionKeyRegistrationTx returns intent + accountsAtRisk without a signer", async () => {
    const built: BuiltFlexTx = await buildSessionKeyRegistrationTx({
      walletAddress: "WalletA",
      escrowAddress: "EscrowB",
      sessionKeyAddress: "SessionC",
    });
    expect(built.intent).toBe("register_session_key");
    expect(built.accountsAtRisk).toEqual(["WalletA", "EscrowB", "SessionC"]);
    expect(built.instructions).toEqual([]);
  });

  test("buildEscrowCreationTx rejects non-base10 amount", async () => {
    await expect(
      buildEscrowCreationTx({
        walletAddress: "W",
        facilitatorAddress: "F",
        amountUsdc: "5.0", // not base10 atomic
      }),
    ).rejects.toThrow(/base10/);
  });

  // ─── Sender wrappers: requires_signer contract ───────────────────────────
  test("fundEscrow without signer rejects with requires_signer + points at builder", async () => {
    await expect(
      fundEscrow({
        walletAddress: "W",
        facilitatorAddress: "F",
        amountUsdc: "1000000",
      }),
    ).rejects.toThrow(/requires_signer/);
  });

  test("registerSessionKey without signer rejects with requires_signer", async () => {
    await expect(
      registerSessionKey({
        walletAddress: "W",
        escrowAddress: "E",
        sessionKeyAddress: "S",
      }),
    ).rejects.toThrow(/requires_signer/);
  });

  test("Unbrowse#fundEscrow without signer surfaces requires_signer", async () => {
    const u = new Unbrowse({ baseUrl: "http://127.0.0.1:1" });
    await expect(u.fundEscrow({ amountUsdc: "1000000" })).rejects.toThrow(
      /requires_signer/,
    );
  });

  // ─── Type-shape parity from Day 3 (must still pass) ──────────────────────
  test("FlexAuthorization shape compiles with valid splits sum", () => {
    const auth: FlexAuthorization = {
      escrow: "X",
      mint: USDC_MINT_MAINNET,
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

    const _wallet: FlexWalletLike = {
      address: "W",
      sessionKeyAddress: "S",
      signFlexAuthorization: async () => "sig",
    };
    expect(_wallet.address).toBe("W");
  });
});
