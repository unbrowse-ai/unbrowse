/**
 * chain/reader seed test — offline (mocked fetch), proves the chain-read skin is viable:
 * parses a Solana getAccountInfo response, returns null for a missing account, and the
 * moat-no-leak guard recognizes sealed (base64) payloads. No live RPC (would flake).
 */
import { describe, expect, it } from "bun:test";
import { getAccountInfo, isSealedPayload } from "./reader.ts";

function mockFetch(value: unknown, ok = true, status = 200) {
  return () =>
    Promise.resolve({
      ok,
      status,
      json: () => Promise.resolve({ jsonrpc: "2.0", id: 1, result: { value } }),
    }) as unknown as Promise<Response>;
}

describe("chain/reader — the website-as-wrapper skin", () => {
  it("getAccountInfo: parses an on-chain account from JSON-RPC (no backend)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = mockFetch({ lamports: 42, owner: "Sysvar111", data: ["AAAA", "base64"], executable: false }) as typeof fetch;
    try {
      const a = await getAccountInfo("SomePubkey1111");
      expect(a?.lamports).toBe(42);
      expect(a?.data[1]).toBe("base64"); // sealed bytes, not decrypted here
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("getAccountInfo: returns null for a missing account", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = mockFetch(null) as typeof fetch;
    try {
      expect(await getAccountInfo("Nope")).toBeNull();
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("moat-no-leak: the guard recognizes sealed base64 payloads (never plaintext)", () => {
    expect(isSealedPayload(["AAAA", "base64"])).toBe(true);
    expect(isSealedPayload(["plaintext", "utf8"] as [string, string])).toBe(false);
  });
});
