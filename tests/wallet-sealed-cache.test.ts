/**
 * wallet-sealed-cache — "any key value bound to their wallet, only for them to
 * use." The commit-reveal sealed cache hides + binds but cannot give the value
 * back; this proves the wallet seal lets ONLY the holder retrieve the plaintext,
 * while the content-address stays host-independent (Paper 2 §5; the runtime twin
 * of paper/reference/ledger/sealed_cache.py).
 */
import { describe, it, expect } from "bun:test";
import {
	sealToWallet,
	revealForWallet,
	WalletSealedCache,
} from "../src/trust/sealed-cache.js";

// Holder wallet secrets (the holder's key material — never leaves them).
const WALLET = "ed25519-seed-8xKpQ2rZvN1mYwTcLdGhJ4sBnEfAuVoPxRgQ7WkMnHj";
const OTHER = "ed25519-seed-3aNbCdEfGhJkLmNpQrStUvWxYz123456789ABCDEFGH";

const SECRET_VALUE = { token: "sk-proj-AbCdEf0123456789", cookie: "sessionid=supersecret999", email: "alice@private.example.com" };

describe("sealToWallet / revealForWallet — only the holder opens it", () => {
	it("round-trips: the holder gets the exact plaintext back", async () => {
		const sealed = await sealToWallet(SECRET_VALUE, WALLET, "slot-1");
		expect(await revealForWallet(sealed, WALLET, "slot-1")).toEqual(SECRET_VALUE);
	});

	it("ONLY the holder: a different wallet cannot open it (AEAD fails closed)", async () => {
		const sealed = await sealToWallet(SECRET_VALUE, WALLET, "slot-1");
		await expect(revealForWallet(sealed, OTHER, "slot-1")).rejects.toThrow(/reveal failed/);
	});

	it("the sealed blob leaks NO plaintext", async () => {
		const sealed = await sealToWallet(SECRET_VALUE, WALLET, "slot-1");
		const blob = JSON.stringify(sealed);
		expect(blob).not.toContain("sk-proj-");
		expect(blob).not.toContain("supersecret999");
		expect(blob).not.toContain("alice@private");
		// only an opaque ciphertext + iv + a content-hash commitment
		expect(sealed.commitment).toStartWith("sha256:");
		expect(/^[0-9a-f]+$/.test(sealed.ct)).toBe(true);
	});

	it("content-address is host-independent: same value → same commitment regardless of wallet/iv", async () => {
		const a = await sealToWallet(SECRET_VALUE, WALLET, "slot-1");
		const b = await sealToWallet(SECRET_VALUE, OTHER, "slot-1");
		expect(a.commitment).toBe(b.commitment); // plaintext content-address, not wallet- or iv-dependent
		expect(a.ct).not.toBe(b.ct);              // but the sealed ciphertext differs per wallet + per iv
	});

	it("info-scoping: a blob sealed for one slot cannot be opened into another", async () => {
		const sealed = await sealToWallet(SECRET_VALUE, WALLET, "slot-1");
		await expect(revealForWallet(sealed, WALLET, "slot-2")).rejects.toThrow(/reveal failed/);
	});

	it("tamper-evident: flipping the ciphertext fails the open", async () => {
		const sealed = await sealToWallet(SECRET_VALUE, WALLET, "slot-1");
		const tampered = { ...sealed, ct: sealed.ct.slice(0, -2) + (sealed.ct.endsWith("00") ? "11" : "00") };
		await expect(revealForWallet(tampered, WALLET, "slot-1")).rejects.toThrow();
	});
});

describe("WalletSealedCache — store ciphertext, open only for the wallet", () => {
	it("puts a sealed blob and opens it only for the holder", async () => {
		const cache = new WalletSealedCache();
		expect(cache.has("route:abc")).toBe(false);
		await cache.put("route:abc", SECRET_VALUE, WALLET);
		expect(cache.has("route:abc")).toBe(true);
		expect(cache.size).toBe(1);
		// the cache never holds plaintext
		expect(JSON.stringify(cache)).not.toContain("supersecret999");
		expect(cache.commitmentOf("route:abc")).toStartWith("sha256:");
		// holder opens
		expect(await cache.open("route:abc", WALLET)).toEqual(SECRET_VALUE);
		// no one else
		await expect(cache.open("route:abc", OTHER)).rejects.toThrow(/reveal failed/);
		// unknown key → undefined (not a throw)
		expect(await cache.open("nope", WALLET)).toBeUndefined();
	});
});
