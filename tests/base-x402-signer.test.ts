/**
 * base-x402-signer.test — proves the EVM "exact" (EIP-3009 TransferWithAuthorization) signature is
 * VALID offline (recovers to the funded address), so a live Base settle would be accepted by the
 * facilitator. No funds, no network: pure signature correctness + the chain-id / scheme guards.
 */
import { describe, expect, it } from "bun:test";
import { recoverTypedDataAddress } from "viem";
import {
  baseX402Available, baseX402Address, buildBaseX402Header, evmChainId, isEvmExact, type EvmAccept,
} from "../src/payments/base-x402-signer.js";

const ACCEPT_200OK: EvmAccept = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "10000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x21C12b9c0C2DA649e72f19F250B70903784bd0b4",
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
};

describe("chain-id + scheme guards", () => {
  it("parses eip155 + known aliases", () => {
    expect(evmChainId("eip155:8453")).toBe(8453);
    expect(evmChainId("base")).toBe(8453);
    expect(evmChainId("solana:5eykt")).toBeUndefined();
  });
  it("isEvmExact only for an EVM exact entry with asset+payTo", () => {
    expect(isEvmExact(ACCEPT_200OK)).toBe(true);
    expect(isEvmExact({ ...ACCEPT_200OK, network: "solana:5eykt" })).toBe(false);
    expect(isEvmExact({ ...ACCEPT_200OK, scheme: "upto" })).toBe(false);
  });
});

describe("EIP-3009 signature validity (the real proof)", () => {
  it("signs a TransferWithAuthorization that recovers to the funded address", async () => {
    if (!baseX402Available()) return; // no key on this machine → skip (CI without the wallet)
    const from = baseX402Address()!;
    const header = await buildBaseX402Header(ACCEPT_200OK, 1_700_000_000);
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    expect(decoded.scheme).toBe("exact");
    expect(decoded.network).toBe("eip155:8453");
    const auth = decoded.payload.authorization;
    expect(auth.from.toLowerCase()).toBe(from.toLowerCase());
    expect(auth.to).toBe(ACCEPT_200OK.payTo);
    expect(auth.value).toBe("10000");
    expect(auth.validBefore).toBe(String(1_700_000_000 + 300));

    // The decisive check: does the signature recover to OUR address over the exact typed data?
    const recovered = await recoverTypedDataAddress({
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: ACCEPT_200OK.asset as `0x${string}` },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from, to: auth.to, value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce,
      },
      signature: decoded.payload.signature,
    });
    expect(recovered.toLowerCase()).toBe(from.toLowerCase());
  });
});
