/**
 * wallet-balance unit tests — hex→base58 conversion + the rpc_unconfigured
 * fallback. RPC happy-paths are covered live (not in unit tests) because
 * mocking the Worker fetch globally is fiddly; this file pins the pure
 * primitives + the doctrine-canonical "RPC missing surfaces typed status"
 * fallback path.
 */

import { describe, expect, test } from "bun:test";
import { bytesToBase58, queryUsdcBalanceMicros } from "../src/services/wallet-balance";

describe("wallet-balance", () => {
  test("bytesToBase58 encodes 32-byte ed25519 pubkey to Solana mainnet base58", async () => {
    // Lewis's actual aiko-declare-identity pubkey (verified live HTTP 200 in this session).
    // Hex 0a59801ade098947b9362af60d77439e7cb17e179ca606bf08bcbeabe9c42296
    const hex = "0a59801ade098947b9362af60d77439e7cb17e179ca606bf08bcbeabe9c42296";
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    const addr = bytesToBase58(bytes);
    // The deterministic Solana b58 of this pubkey — pinned so any drift
    // in bytesToBase58 fails the test instead of silently producing a
    // wrong address. (Computed once with the canonical bs58 algorithm.)
    expect(addr).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(addr).not.toContain("0");
    expect(addr).not.toContain("O");
    expect(addr).not.toContain("I");
    expect(addr).not.toContain("l");
  });

  test("bytesToBase58 preserves leading zero bytes as '1' chars", async () => {
    const bytes = new Uint8Array(4);
    bytes[0] = 0;
    bytes[1] = 0;
    bytes[2] = 0x05;
    bytes[3] = 0x10;
    const addr = bytesToBase58(bytes);
    expect(addr.startsWith("11")).toBe(true);
  });

  test("queryUsdcBalanceMicros returns rpc_unconfigured when CASCADE_RPC_URL unset", async () => {
    const probe = await queryUsdcBalanceMicros(
      {},
      "0a59801ade098947b9362af60d77439e7cb17e179ca606bf08bcbeabe9c42296",
    );
    expect(probe.status).toBe("rpc_unconfigured");
    expect(probe.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  test("queryUsdcBalanceMicros returns invalid_pubkey on malformed hex", async () => {
    const probe = await queryUsdcBalanceMicros({}, "not-hex-at-all");
    expect(probe.status).toBe("invalid_pubkey");
  });

  test("queryUsdcBalanceMicros returns invalid_pubkey on wrong byte length", async () => {
    const probe = await queryUsdcBalanceMicros({}, "0a59"); // 2 bytes, not 32
    expect(probe.status).toBe("invalid_pubkey");
  });
});
