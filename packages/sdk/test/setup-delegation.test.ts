import { describe, test, expect, mock } from "bun:test";

// ── Mock the chain (design WITNESS: "mock the chain + the HTTP calls") ───────
// `setupDelegation` composes the REAL `fundEscrow` + `registerSessionKey`, which
// lazy-import @faremeter/flex-solana (instruction builders) and @solana/kit
// (the send/confirm pipeline). We mock both so the helper runs its real
// composition logic against a fake chain — no network, no RPC.

const SIGNER = { __kind: "TransactionSigner", id: "user-wallet-signer" };
const RPC = { __kind: "rpc" };

// Capture what the flex instruction builders were called with, so we can prove
// the user's `signer` flows into fundEscrow/registerSessionKey and nowhere else.
const createEscrowCalls: unknown[] = [];
const depositCalls: unknown[] = [];
const registerCalls: unknown[] = [];

mock.module("@faremeter/flex-solana", () => ({
  getCreateEscrowInstructionAsync: async (args: any) => {
    createEscrowCalls.push(args);
    // accounts[1].address is the escrow PDA in the real builder.
    return { accounts: [{ address: "OwnerAcct" }, { address: "UserEscrowPDA" }] };
  },
  getDepositInstructionAsync: async (args: any) => {
    depositCalls.push(args);
    return { __ix: "deposit" };
  },
  getRegisterSessionKeyInstructionAsync: async (args: any) => {
    registerCalls.push(args);
    return { __ix: "register" };
  },
}));

// Minimal @solana/kit so sendFlexTx confirms instantly with a fake signature.
let fakeSigCounter = 0;
mock.module("@solana/kit", () => ({
  pipe: (v: unknown, ...fns: Array<(x: unknown) => unknown>) =>
    fns.reduce((acc, fn) => fn(acc), v),
  createTransactionMessage: () => ({}),
  setTransactionMessageFeePayerSigner: (_s: unknown, m: unknown) => m,
  setTransactionMessageLifetimeUsingBlockhash: (_b: unknown, m: unknown) => m,
  appendTransactionMessageInstructions: (_i: unknown, m: unknown) => m,
  signTransactionMessageWithSigners: async (m: unknown) => m,
  getSignatureFromTransaction: () => `SIG${++fakeSigCounter}`,
  getBase64EncodedWireTransaction: () => "WIRE",
}));

const { setupDelegation } = await import("../src/flex.js");

// A fake @solana/kit RPC client matching sendFlexTx's structural shape: every
// call confirms immediately.
function makeRpc() {
  return {
    ...RPC,
    getLatestBlockhash: () => ({
      send: async () => ({
        value: { blockhash: "bh", lastValidBlockHeight: 100n },
      }),
    }),
    sendTransaction: (_wire: string, _opts: unknown) => ({
      send: async () => "submitted",
    }),
    getSignatureStatuses: (_sigs: string[]) => ({
      send: async () => ({ value: [{ confirmationStatus: "confirmed" }] }),
    }),
  };
}

// A client recorder: captures every backend request in order. Crucially, the
// body is captured so we can assert the wallet signer NEVER appears in it.
function makeClient(sessionReady = true) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const client = {
    calls,
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      if (path === "/v1/account/delegation/session-key") {
        return { session_key_address: "PlatformSessionKey", ready: sessionReady } as T;
      }
      return { ok: true } as T;
    },
  };
  return client;
}

const baseParams = {
  keyId: "key_abc",
  amountToFund: "5000000",
  cap: "10000000",
  expiresAtSlot: "300000123",
  walletAddress: "UserWallet",
  facilitatorAddress: "FacilitatorAddr",
  signer: SIGNER,
  rpc: makeRpc(),
};

describe("setupDelegation — non-custodial delegation lane (design §3 a→c)", () => {
  test("runs the 4 steps in order with the right params", async () => {
    createEscrowCalls.length = 0;
    depositCalls.length = 0;
    registerCalls.length = 0;
    const client = makeClient(true);

    const result = await setupDelegation(client, { ...baseParams, rpc: makeRpc() });

    // ── Step order: GET session-key first, POST delegation last ──────────────
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]).toMatchObject({
      method: "GET",
      path: "/v1/account/delegation/session-key",
    });
    expect(client.calls[1]).toMatchObject({
      method: "POST",
      path: "/v1/account/keys/key_abc/delegation",
    });

    // ── Step 2 (fundEscrow) ran: create-escrow + deposit on the USER's wallet ─
    expect(createEscrowCalls).toHaveLength(1);
    expect(depositCalls).toHaveLength(1);
    expect((depositCalls[0] as any).amount).toBe(5000000n);
    expect((depositCalls[0] as any).escrow).toBe("UserEscrowPDA");

    // ── Step 3 (registerSessionKey) ran with the PLATFORM session key + expiry ─
    expect(registerCalls).toHaveLength(1);
    expect((registerCalls[0] as any).escrow).toBe("UserEscrowPDA");
    expect((registerCalls[0] as any).sessionKey).toBe("PlatformSessionKey");
    expect((registerCalls[0] as any).expiresAtSlot).toBe(300000123n);

    // ── Step 4 bind body carries escrow/pubkey/cap/expiry — bound to the key ──
    const bindBody = client.calls[1].body as Record<string, unknown>;
    expect(bindBody).toEqual({
      wallet: "UserWallet",
      escrow: "UserEscrowPDA",
      session_key_address: "PlatformSessionKey",
      cap_uc: "10000000",
      expires_at_slot: "300000123",
    });

    // ── Structured result ────────────────────────────────────────────────────
    expect(result).toMatchObject({
      escrowAddress: "UserEscrowPDA",
      sessionKeyAddress: "PlatformSessionKey",
      cap: "10000000",
      expiresAtSlot: "300000123",
    });
    expect(result.fundTxSignature).toMatch(/^SIG\d+$/);
    expect(result.registerTxSignature).toMatch(/^SIG\d+$/);
  });

  test("the wallet signer is used ONLY for fundEscrow + registerSessionKey, never sent to the backend", async () => {
    createEscrowCalls.length = 0;
    depositCalls.length = 0;
    registerCalls.length = 0;
    const client = makeClient(true);

    await setupDelegation(client, { ...baseParams, rpc: makeRpc() });

    // The signer object reaches the on-chain builders (owner/depositor)...
    expect((createEscrowCalls[0] as any).owner).toBe(SIGNER);
    expect((depositCalls[0] as any).depositor).toBe(SIGNER);
    expect((registerCalls[0] as any).owner).toBe(SIGNER);

    // ...and NEVER appears in ANY backend request body.
    for (const call of client.calls) {
      const serialized = JSON.stringify(call.body ?? {});
      expect(serialized).not.toContain("user-wallet-signer");
      expect(serialized).not.toContain("TransactionSigner");
      // No `signer`/`rpc`/`private` key crosses the HTTP boundary.
      const body = (call.body ?? {}) as Record<string, unknown>;
      expect(body).not.toHaveProperty("signer");
      expect(body).not.toHaveProperty("rpc");
    }
  });

  test("throws a clear error when the platform session key is not ready", async () => {
    const client = makeClient(false);
    await expect(
      setupDelegation(client, { ...baseParams, rpc: makeRpc() }),
    ).rejects.toThrow(/not ready/);
    // Only the GET ran; no escrow funded, no bind.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].path).toBe("/v1/account/delegation/session-key");
  });

  test("throws requires_signer without a signer/rpc", async () => {
    const client = makeClient(true);
    await expect(
      setupDelegation(client, { ...baseParams, signer: undefined as never }),
    ).rejects.toThrow(/requires_signer/);
  });
});
