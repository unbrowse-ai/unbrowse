/**
 * zk-pipeline-composition — the whole ZK-obfuscation loop, end to end.
 *
 * Proves the session's primitives COMPOSE into the user's north star (not just
 * pass in isolation): a user browses with their credentials, EVERYTHING is
 * obfuscated, the backend reverse-engineers + sees only the HOLES (never a
 * secret), and the client fills those holes from a vault SEALED TO THEIR WALLET
 * — so the concrete request is reconstructed locally and the secrets never left
 * the wallet-holder.
 *
 *   capture(secrets) ─seal→ WalletVault(wallet)            (secrets bound to wallet)
 *                    ─obfuscate(wallet)→ obfuscated         (secrets → bound tags)
 *                    ─extractHoles→ {skeleton, holes}       (sent to backend — NO secret)
 *   client opens vault for each hole ─fillHoles→ concrete request   (real secrets, local only)
 */
import { describe, it, expect } from "bun:test";
import { obfuscateCaptureForReveng } from "../src/capture/obfuscate.js";
import { extractHoles, fillHoles } from "../src/capture/hole-template.js";
import { WalletVault } from "../src/vault/wallet-vault.js";
import type { RawRequest } from "../src/capture/index.js";

const WALLET = "ed25519-seed-8xKpQ2rZvN1mYwTcLdGhJ4sBnEfAuVoPxRgQ7WkMnHj";
const ATTACKER = "ed25519-seed-3aNbCdEfGhJkLmNpQrStUvWxYz123456789ABCDEFGH";

const SECRETS = {
	authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_secret_99",
	api_key: "sk-proj-AbCdEf0123456789AbCdEf0123456789",
	password: "hunter2-very-secret",
};

const RAW: RawRequest = {
	url: `https://api.example.com/v1/users/550e8400-e29b-41d4-a716-446655440000/orders?api_key=${SECRETS.api_key}&page=2`,
	method: "POST",
	request_headers: { authorization: SECRETS.authorization, "content-type": "application/json" },
	request_body: JSON.stringify({ password: SECRETS.password, item_id: 42 }),
	response_status: 200,
	response_headers: { "content-type": "application/json" },
	response_body: JSON.stringify({ order_id: 7788 }),
	timestamp: "2026-06-03T00:00:00Z",
};

describe("ZK-obfuscation pipeline composes end-to-end", () => {
	it("browse obfuscated → backend sees only holes (no secret) → client fills from wallet vault → real request", async () => {
		// 1. The user's secrets are sealed to THEIR wallet (vault keeps no plaintext).
		const vault = new WalletVault();
		for (const [name, secret] of Object.entries(SECRETS)) await vault.store(name, secret, WALLET);
		expect(JSON.stringify(vault.exportSealed())).not.toContain("hunter2");

		// 2. Browse fully obfuscated (secrets → wallet-bound tags) and reveng to holes.
		const [obfuscated] = obfuscateCaptureForReveng([RAW], { walletPubkey: WALLET });
		const template = extractHoles(obfuscated!);

		// 3. WITNESS A — what crosses the wire to the backend carries NO secret.
		const wire = JSON.stringify({ skeleton: template.skeleton, holes: template.holes });
		for (const secret of Object.values(SECRETS)) expect(wire).not.toContain(secret);
		expect(wire).not.toContain("hunter2");
		// the backend DID get the structure + the named holes it needs filled
		const holeNames = template.holes.map((h) => h.name);
		expect(holeNames).toContain("authorization");
		expect(holeNames).toContain("api_key");
		expect(holeNames).toContain("password");

		// 4. The CLIENT fills each vault-sourced hole by opening its wallet-sealed secret.
		const fills: Record<string, string> = {};
		for (const hole of template.holes) {
			if (hole.fill === "vault") {
				const secret = await vault.open(hole.name, WALLET);
				if (secret !== undefined) fills[hole.name] = secret;
			}
		}
		const concrete = fillHoles(template, fills);

		// 5. WITNESS B — the loop closes: the reconstructed request carries the REAL secrets.
		expect(concrete.request_headers.authorization).toBe(SECRETS.authorization);
		expect(concrete.url).toContain(`api_key=${encodeURIComponent(SECRETS.api_key)}`);
		expect(JSON.parse(concrete.request_body!).password).toBe(SECRETS.password);
		// and the non-secret structure survived intact
		expect(concrete.method).toBe("POST");
		expect(JSON.parse(concrete.request_body!).item_id).toBe(42);
		expect(concrete.url).toContain("page=2");
	});

	it("an attacker's wallet cannot reconstruct the request — the secrets stay bound to the holder", async () => {
		const vault = new WalletVault();
		for (const [name, secret] of Object.entries(SECRETS)) await vault.store(name, secret, WALLET);
		const [obfuscated] = obfuscateCaptureForReveng([RAW], { walletPubkey: WALLET });
		const template = extractHoles(obfuscated!);

		// the attacker holds the obfuscated capture + the sealed vault blobs, but
		// NOT the wallet — every open fails closed, so no hole can be filled.
		for (const hole of template.holes) {
			if (hole.fill === "vault") {
				await expect(vault.open(hole.name, ATTACKER)).rejects.toThrow();
			}
		}
	});
});
