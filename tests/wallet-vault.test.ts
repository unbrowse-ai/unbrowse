/**
 * wallet-vault — "any key value ZK'ed to their wallet only for them to use."
 * Proves credentials are sealed to the wallet: only the holder opens them, the
 * stored blob leaks no plaintext, account-scoping holds, and the sealed blobs
 * export/import (backend KV round-trip) without ever exposing plaintext — the
 * last stateless gap closed (the client keeps only sealed blobs).
 */
import { describe, it, expect } from "bun:test";
import { WalletVault } from "../src/vault/wallet-vault.js";

const WALLET = "ed25519-seed-8xKpQ2rZvN1mYwTcLdGhJ4sBnEfAuVoPxRgQ7WkMnHj";
const OTHER = "ed25519-seed-3aNbCdEfGhJkLmNpQrStUvWxYz123456789ABCDEFGH";
const BEARER = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_secret_value_99";

describe("WalletVault — credentials sealed to the wallet", () => {
	it("round-trips for the holder: store then open returns the exact secret", async () => {
		const v = new WalletVault();
		await v.store("github.com", BEARER, WALLET);
		expect(await v.open("github.com", WALLET)).toBe(BEARER);
	});

	it("ONLY the holder opens it: a different wallet fails closed", async () => {
		const v = new WalletVault();
		await v.store("github.com", BEARER, WALLET);
		await expect(v.open("github.com", OTHER)).rejects.toThrow(/reveal failed/);
	});

	it("the stored blob leaks NO plaintext (opaque ciphertext + content-hash only)", async () => {
		const v = new WalletVault();
		await v.store("github.com", BEARER, WALLET);
		const blob = JSON.stringify(v.exportSealed());
		expect(blob).not.toContain("sig_secret_value_99");
		expect(blob).not.toContain("Bearer eyJ");
		expect(v.commitmentOf("github.com")).toStartWith("sha256:");
	});

	it("account-scoped: a blob sealed for one account cannot open as another", async () => {
		const v = new WalletVault();
		await v.store("github.com", BEARER, WALLET);
		// move the github blob under a different account key, then try to open
		const sealed = v.exportSealed()["github.com"]!;
		const v2 = new WalletVault();
		v2.importSealed({ "gitlab.com": sealed });
		await expect(v2.open("gitlab.com", WALLET)).rejects.toThrow(); // info mismatch → AEAD fails
	});

	it("export/import (backend KV round-trip) keeps holder-only access, no plaintext on the wire", async () => {
		const v = new WalletVault();
		await v.store("api.example.com", BEARER, WALLET);
		const exported = v.exportSealed(); // what ships to the backend KV
		expect(JSON.stringify(exported)).not.toContain("sig_secret_value_99");
		// a fresh client (other machine) rehydrates from the backend blobs
		const fresh = new WalletVault();
		fresh.importSealed(exported);
		expect(await fresh.open("api.example.com", WALLET)).toBe(BEARER); // holder opens
		await expect(fresh.open("api.example.com", OTHER)).rejects.toThrow(); // no one else
	});

	it("unknown account → undefined, not a throw", async () => {
		const v = new WalletVault();
		expect(await v.open("nope.com", WALLET)).toBeUndefined();
	});
});
