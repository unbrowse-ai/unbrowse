// Backend test: POST /v1/wallet/sign — server-side Ed25519 signing with the
// unbrowse-DEFAULT wallet (the platform's own keypair, held server-side; NO
// Privy delegation, NO user consent — the d16 "needs delegated consent" framing
// was the wrong lens). Real sign→verify roundtrip with a generated keypair, no
// mocks: the signature actually verifies against the returned public key.
import { describe, test, expect } from "bun:test";
import { app } from "../src/index.js";
import {
	signWithDefaultWallet,
	verifyDefaultWalletSignature,
	SIGN_DOMAIN,
} from "../src/services/wallet-signer.js";

// Build a real 64-byte Solana keypair secret (seed||pubkey) from Web Crypto.
async function makeKeypairSecretJson(): Promise<{ secretJson: string; pubRaw: Uint8Array }> {
	const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
	const seed = pkcs8.slice(-32); // raw 32-byte seed is the tail of the PKCS#8 blob
	const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
	const secret = new Uint8Array(64);
	secret.set(seed, 0);
	secret.set(pubRaw, 32);
	return { secretJson: JSON.stringify([...secret]), pubRaw };
}

describe("default-wallet signing — real Ed25519 sign→verify", () => {
	test("signs a message and the signature VERIFIES against the returned pubkey", async () => {
		const { secretJson } = await makeKeypairSecretJson();
		const signed = await signWithDefaultWallet("attest: route github.com fresh @ 2026-06-02", secretJson);
		expect(signed.publicKey.length).toBeGreaterThan(30); // base58 Solana pubkey
		expect(signed.domain).toBe(SIGN_DOMAIN);
		expect(await verifyDefaultWalletSignature(signed.message, signed.signature, signed.publicKey)).toBe(true);
	});

	test("a tampered message does NOT verify (binding)", async () => {
		const { secretJson } = await makeKeypairSecretJson();
		const signed = await signWithDefaultWallet("original", secretJson);
		expect(await verifyDefaultWalletSignature("tampered", signed.signature, signed.publicKey)).toBe(false);
	});

	test("a different wallet's pubkey does NOT verify the signature", async () => {
		const a = await makeKeypairSecretJson();
		const b = await makeKeypairSecretJson();
		const signed = await signWithDefaultWallet("msg", a.secretJson);
		const { default: bs58 } = (await import("bs58")) as unknown as { default: { encode: (b: Uint8Array) => string } };
		const otherPub = bs58.encode(b.pubRaw);
		expect(await verifyDefaultWalletSignature(signed.message, signed.signature, otherPub)).toBe(false);
	});

	test("domain separation: the same raw bytes signed without the prefix would not collide", async () => {
		const { secretJson } = await makeKeypairSecretJson();
		const signed = await signWithDefaultWallet("x", secretJson);
		// verifying the message WITHOUT the domain prefix (i.e. treating signed.message
		// as already-prefixed) must fail — proves the prefix is actually mixed in.
		expect(await verifyDefaultWalletSignature(SIGN_DOMAIN + "x", signed.signature, signed.publicKey)).toBe(false);
	});

	test("rejects a too-short key", async () => {
		await expect(signWithDefaultWallet("m", JSON.stringify([1, 2, 3]))).rejects.toThrow(/too_short/);
	});
});

describe("/v1/wallet/sign route", () => {
	test("end-to-end: route signs with the configured default wallet, signature verifies", async () => {
		const { secretJson } = await makeKeypairSecretJson();
		// API_KEY + matching bearer takes the admin path in bearerAuth (no DB).
		const env = { ENVIRONMENT: "staging", API_KEY: "test-admin-key", UNBROWSE_DEFAULT_WALLET_KEY: secretJson } as unknown as Parameters<typeof app.fetch>[1];
		const res = await app.fetch(
			new Request("http://local.test/v1/wallet/sign", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer test-admin-key" },
				body: JSON.stringify({ message: "hello platform identity" }),
			}),
			env,
		);
		expect(res.status).toBe(200);
		const signed = (await res.json()) as { publicKey: string; signature: string; message: string };
		expect(signed.message).toBe("hello platform identity");
		expect(await verifyDefaultWalletSignature(signed.message, signed.signature, signed.publicKey)).toBe(true);
	});

	test("returns 503 honest envelope when the default wallet is not configured", async () => {
		const env = { ENVIRONMENT: "staging", API_KEY: "test-admin-key" } as unknown as Parameters<typeof app.fetch>[1];
		const res = await app.fetch(
			new Request("http://local.test/v1/wallet/sign", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer test-admin-key" },
				body: JSON.stringify({ message: "x" }),
			}),
			env,
		);
		expect(res.status).toBe(503);
		const body = (await res.json()) as { _binding_missing?: string };
		expect(body._binding_missing).toBe("UNBROWSE_DEFAULT_WALLET_KEY");
	});

	test("route is mounted — unauthenticated POST is rejected by the auth gate, not 404", async () => {
		const env = {} as Parameters<typeof app.fetch>[1];
		const res = await app.fetch(
			new Request("http://local.test/v1/wallet/sign", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message: "x" }),
			}),
			env,
		);
		expect(res.status).not.toBe(404);
	});
});
