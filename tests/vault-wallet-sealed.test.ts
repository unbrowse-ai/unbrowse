/**
 * vault-wallet-sealed — the REAL vault path (src/vault/index.ts) seals
 * credential VALUES to the wallet when UNBROWSE_WALLET_SECRET is set: the holder
 * opens them, a wrong/absent wallet cannot, and the default (no wallet) path is
 * unchanged. Wires the d60 WalletVault primitive into the actual auth store.
 *
 * Hermetic: keytar is mocked unavailable (so the file backend in a temp HOME is
 * used — never the real OS keychain), and HOME is redirected before the vault
 * module loads.
 */
import { describe, it, expect, afterAll, mock } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = join(tmpdir(), `unbrowse-vault-test-${process.pid}`);
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = HOME;
// Force the encrypted-file backend (no real keychain writes).
mock.module("keytar", () => ({ default: {} }));

const WALLET = "ed25519-seed-8xKpQ2rZvN1mYwTcLdGhJ4sBnEfAuVoPxRgQ7WkMnHj";
const OTHER = "ed25519-seed-3aNbCdEfGhJkLmNpQrStUvWxYz123456789ABCDEFGH";
const SECRET = "Bearer test-token-redacted";

const vault = await import("../src/vault/index.js");

afterAll(() => {
	delete process.env.UNBROWSE_WALLET_SECRET;
	if (ORIGINAL_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = ORIGINAL_HOME;
	rmSync(HOME, { recursive: true, force: true });
});

describe("vault wallet-sealing (UNBROWSE_WALLET_SECRET set)", () => {
	it("the holder round-trips the exact secret", async () => {
		process.env.UNBROWSE_WALLET_SECRET = WALLET;
		await vault.storeCredential("github.com", SECRET);
		expect(await vault.getCredential("github.com")).toBe(SECRET);
	});

	it("a DIFFERENT wallet at read time cannot open it (null)", async () => {
		process.env.UNBROWSE_WALLET_SECRET = WALLET;
		await vault.storeCredential("gitlab.com", SECRET);
		process.env.UNBROWSE_WALLET_SECRET = OTHER;
		expect(await vault.getCredential("gitlab.com")).toBeNull();
	});

	it("NO wallet at read time cannot open the sealed credential (null) — no plaintext recoverable", async () => {
		process.env.UNBROWSE_WALLET_SECRET = WALLET;
		await vault.storeCredential("api.example.com", SECRET);
		delete process.env.UNBROWSE_WALLET_SECRET;
		expect(await vault.getCredential("api.example.com")).toBeNull();
	});
});

describe("default path unchanged (no wallet secret)", () => {
	it("stores + retrieves a plain credential when no wallet secret is set", async () => {
		delete process.env.UNBROWSE_WALLET_SECRET;
		await vault.storeCredential("plain.com", SECRET);
		expect(await vault.getCredential("plain.com")).toBe(SECRET);
	});
});
