// Wallet Standard (OWS) payment bridge — consume any standard wallet → x402
// PayHandler, and the optional unbrowse-default wallet. Zero-dep, structural.
import { test, expect } from "bun:test";
import {
  walletStandardPay,
  makeUnbrowseWallet,
  pickSolanaWallets,
  paymentMessage,
  type WsWallet,
  type WsAccount,
} from "../src/sdk/wallet-standard.js";
import type { PaymentRequired } from "../src/sdk/fetch.js";

const account: WsAccount = {
  address: "So1anaAddr1111111111111111111111111111111",
  publicKey: new Uint8Array([1, 2, 3]),
  chains: ["solana:mainnet"],
  features: ["solana:signMessage"],
};

function mockWallet(onSign: (msg: Uint8Array) => Uint8Array): WsWallet {
  return {
    version: "1.0.0",
    name: "Mock",
    chains: ["solana:mainnet"],
    accounts: [account],
    features: {
      "standard:connect": { connect: async () => ({ accounts: [account] }) },
      "solana:signMessage": {
        signMessage: async ({ message }) => [{ signedMessage: message, signature: onSign(message) }],
      },
    },
  };
}

function ctx(terms: Record<string, unknown> | null): PaymentRequired {
  return {
    response: new Response("", { status: 402 }),
    request: { input: "https://api.unbrowse.ai/v1/search" },
    terms,
  };
}

test("walletStandardPay signs the 402 challenge and returns an X-PAYMENT header", async () => {
  let signedMsg: Uint8Array | null = null;
  const wallet = mockWallet((msg) => {
    signedMsg = msg;
    return new Uint8Array([9, 9, 9, 9]);
  });
  const pay = walletStandardPay(wallet);
  const headers = (await pay(ctx({ accepts: [{ challenge: "pay-7000-usdc" }] }))) as Record<string, string>;
  expect(headers).not.toBeNull();
  expect(headers["X-PAYMENT"]).toBe(Buffer.from([9, 9, 9, 9]).toString("base64"));
  expect(new TextDecoder().decode(signedMsg!)).toBe("pay-7000-usdc");
});

test("walletStandardPay declines (null) when the wallet cannot sign", async () => {
  const wallet: WsWallet = { version: "1.0.0", name: "NoSign", chains: ["solana:mainnet"], accounts: [account], features: {} };
  const pay = walletStandardPay(wallet);
  expect(await pay(ctx({ challenge: "x" }))).toBeNull();
});

test("pickSolanaWallets keeps only connect+sign-capable Solana wallets", () => {
  const ok = mockWallet(() => new Uint8Array([1]));
  const evm: WsWallet = { version: "1.0.0", name: "Evm", chains: ["eip155:1"], accounts: [], features: {} };
  expect(pickSolanaWallets([ok, evm])).toEqual([ok]);
});

test("paymentMessage falls back to the accepts envelope when no challenge string", () => {
  const msg = new TextDecoder().decode(paymentMessage({ accepts: [{ amount: "7000" }] }));
  expect(msg).toContain("7000");
});

test("makeUnbrowseWallet is opt-in (throws without an API key)", () => {
  // @ts-expect-error intentionally missing apiKey
  expect(() => makeUnbrowseWallet({ address: "a", publicKey: new Uint8Array() })).toThrow(/opt-in/);
});

test("makeUnbrowseWallet delegates signing to the Unbrowse server", async () => {
  let calledUrl = "";
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calledUrl = String(url);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer KEY");
    return new Response(JSON.stringify({ signature: Buffer.from([5, 5]).toString("base64") }), { status: 200 });
  }) as unknown as typeof fetch;
  const w = makeUnbrowseWallet({ apiKey: "KEY", address: "addr", publicKey: new Uint8Array([1]), fetch: fakeFetch });
  expect(w.name).toBe("Unbrowse");
  const [res] = await w.features["solana:signMessage"]!.signMessage({ account: w.accounts[0]!, message: new Uint8Array([1]) });
  expect(calledUrl).toContain("/v1/wallet/sign");
  expect(Array.from(res!.signature)).toEqual([5, 5]);
});
