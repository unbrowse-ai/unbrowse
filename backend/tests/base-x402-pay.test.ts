/**
 * base-x402-pay.test — the Worker-side Base x402 PAY client. Proves the EIP-3009 signature built
 * in-Worker (viem, key from env secret, no fs) is VALID — recovers to the signer address — so a
 * live upstream settle would be accepted. Plus the availability guard + EVM-accept detection.
 * Uses a public Hardhat test key (never a real secret).
 */
import { describe, expect, it } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import {
  baseX402SignerAvailable, buildBaseX402Header, evmChainId, isEvmExact, type EvmAccept,
} from "../src/services/base-x402-pay.js";

// Public Hardhat account #0 — a well-known TEST key, never a real secret.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ACCEPT: EvmAccept = {
  scheme: "exact", network: "eip155:8453", amount: "10000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x21C12b9c0C2DA649e72f19F250B70903784bd0b4",
  maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" },
};

describe("guards", () => {
  it("baseX402SignerAvailable only for a valid 0x key", () => {
    expect(baseX402SignerAvailable({})).toBe(false);
    expect(baseX402SignerAvailable({ BASE_X402_SIGNER_KEY: "nope" })).toBe(false);
    expect(baseX402SignerAvailable({ BASE_X402_SIGNER_KEY: TEST_KEY })).toBe(true);
  });
  it("evmChainId + isEvmExact", () => {
    expect(evmChainId("eip155:8453")).toBe(8453);
    expect(evmChainId("base")).toBe(8453);
    expect(evmChainId("solana:5eykt")).toBeUndefined();
    expect(isEvmExact(ACCEPT)).toBe(true);
    expect(isEvmExact({ ...ACCEPT, network: "solana:5eykt" })).toBe(false);
  });
});

describe("EIP-3009 signing in-Worker (the real proof)", () => {
  it("builds a signed payload that recovers to the signer address", async () => {
    const env = { BASE_X402_SIGNER_KEY: TEST_KEY };
    const from = privateKeyToAccount(TEST_KEY).address;
    const header = await buildBaseX402Header(ACCEPT, env, 1_700_000_000);
    const decoded = JSON.parse(atob(header));
    expect(decoded.scheme).toBe("exact");
    const auth = decoded.payload.authorization;
    expect(auth.from.toLowerCase()).toBe(from.toLowerCase());
    expect(auth.to).toBe(ACCEPT.payTo);
    expect(auth.value).toBe("10000");
    expect(auth.validBefore).toBe(String(1_700_000_000 + 300));

    const recovered = await recoverTypedDataAddress({
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: ACCEPT.asset as `0x${string}` },
      types: { TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ] },
      primaryType: "TransferWithAuthorization",
      message: { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
      signature: decoded.payload.signature,
    });
    expect(recovered.toLowerCase()).toBe(from.toLowerCase());
  });
});
