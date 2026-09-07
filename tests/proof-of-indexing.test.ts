import { describe, expect, it } from "bun:test";
import {
	schemaDescriptor,
	schemaHash,
	buildProofOfIndexing,
	sealProofOfIndexing,
	proofPtr,
	verifyProofOfIndexing,
	proofDiverged,
	ProofChain,
} from "../src/trust/proof-of-indexing.js";

// A real Ed25519 keypair via Web Crypto — no mock signer; the proof is only
// trustworthy if it survives real signature verification (CLAUDE.md: build the
// real thing). Bun's crypto.subtle supports Ed25519.
async function ed25519Signer() {
	const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const sign = async (message: Uint8Array): Promise<Uint8Array> =>
		new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, message));
	const verify = async (
		message: Uint8Array,
		signatureHex: string,
		_indexer: string,
	): Promise<boolean> => {
		const sig = Uint8Array.from(signatureHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
		return crypto.subtle.verify({ name: "Ed25519" }, kp.publicKey, sig, message);
	};
	return { sign, verify };
}

describe("schema fingerprint", () => {
	it("is independent of key order", async () => {
		expect(schemaDescriptor({ a: 1, b: "x" })).toBe(schemaDescriptor({ b: "y", a: 99 }));
		expect(await schemaHash({ a: 1, b: "x" })).toBe(await schemaHash({ b: "y", a: 99 }));
	});

	it("is independent of values, sensitive to types and field sets", async () => {
		expect(await schemaHash({ id: 1 })).toBe(await schemaHash({ id: 9999 })); // value drift: same
		expect(await schemaHash({ id: 1 })).not.toBe(await schemaHash({ id: "1" })); // type drift: differs
		expect(await schemaHash({ id: 1 })).not.toBe(await schemaHash({ id: 1, extra: true })); // added field: differs
		expect(await schemaHash({ id: 1, name: "a" })).not.toBe(await schemaHash({ id: 1 })); // removed field: differs
	});

	it("treats arrays as a deduped union of element shapes (length-independent)", async () => {
		expect(await schemaHash([{ id: 1 }])).toBe(await schemaHash([{ id: 2 }, { id: 3 }, { id: 4 }]));
		expect(await schemaHash([{ id: 1 }])).not.toBe(await schemaHash([{ id: 1, gone: 1 }]));
	});
});

describe("proof build + seal + verify", () => {
	it("fingerprints the observed response and seals a verifiable proof", async () => {
		const { sign, verify } = await ed25519Signer();
		const poi = await buildProofOfIndexing({
			routePtr: "sha256:route-abc",
			sourceUrl: "https://example.com/api/items",
			observedResponse: { items: [{ id: 1, title: "x" }], total: 1 },
			indexedAt: 1_700_000_000_000,
			indexer: "wallet:deadbeef",
		});
		expect(poi.schemaHash).toBe(
			await schemaHash({ items: [{ id: 2, title: "y" }], total: 9 }),
		);
		expect(poi.prevPoi).toBeNull();
		expect(poi.signature).toBeUndefined();

		const sealed = await sealProofOfIndexing(poi, sign);
		expect(sealed.signature).toBeString();
		expect(await verifyProofOfIndexing(sealed, verify)).toBe(true);
	});

	it("rejects a tampered proof and an unsigned proof", async () => {
		const { sign, verify } = await ed25519Signer();
		const sealed = await sealProofOfIndexing(
			await buildProofOfIndexing({
				routePtr: "sha256:r",
				sourceUrl: "https://e.com",
				observedResponse: { ok: true },
				indexedAt: 1,
				indexer: "wallet:abc",
			}),
			sign,
		);
		expect(await verifyProofOfIndexing({ ...sealed, schemaHash: "sha256:forged" }, verify)).toBe(false);
		expect(await verifyProofOfIndexing({ ...sealed, signature: undefined }, verify)).toBe(false);
	});

	it("content-addresses the proof independent of the signature", async () => {
		const { sign } = await ed25519Signer();
		const poi = await buildProofOfIndexing({
			routePtr: "sha256:r",
			sourceUrl: "https://e.com",
			observedResponse: { ok: true },
			indexedAt: 7,
			indexer: "wallet:abc",
		});
		const a = await proofPtr(poi);
		const b = await proofPtr(await sealProofOfIndexing(poi, sign));
		expect(a).toBe(b); // signature is not part of the address
		expect(a).toStartWith("sha256:");
	});
});

describe("divergence (the slashable fact)", () => {
	it("is false when the live schema matches, true when it drifts", async () => {
		const poi = await buildProofOfIndexing({
			routePtr: "sha256:r",
			sourceUrl: "https://e.com",
			observedResponse: { user: { id: 1, name: "a" } },
			indexedAt: 1,
			indexer: "wallet:abc",
		});
		expect(await proofDiverged(poi, { user: { id: 2, name: "b" } })).toBe(false); // values changed only
		expect(await proofDiverged(poi, { user: { id: 2 } })).toBe(true); // field removed → stale-but-confident
	});
});

describe("ProofChain — tamper-evident freshness history", () => {
	it("enforces the chain link and rejects forks", async () => {
		const { sign } = await ed25519Signer();
		const chain = new ProofChain();
		const r = "sha256:route-1";
		expect(chain.headOf(r)).toBeNull();

		const p1 = await sealProofOfIndexing(
			await buildProofOfIndexing({ routePtr: r, sourceUrl: "https://e.com", observedResponse: { a: 1 }, indexedAt: 1, indexer: "w", prevPoi: null }),
			sign,
		);
		const ptr1 = await chain.append(p1);
		expect(chain.headOf(r)).toBe(ptr1);
		expect(chain.latest(r)?.indexedAt).toBe(1);

		// next proof must link to ptr1
		const p2 = await sealProofOfIndexing(
			await buildProofOfIndexing({ routePtr: r, sourceUrl: "https://e.com", observedResponse: { a: 1, b: 2 }, indexedAt: 2, indexer: "w", prevPoi: ptr1 }),
			sign,
		);
		await chain.append(p2);
		expect(chain.latest(r)?.indexedAt).toBe(2);

		// a fork (wrong prevPoi) is rejected
		const fork = await sealProofOfIndexing(
			await buildProofOfIndexing({ routePtr: r, sourceUrl: "https://e.com", observedResponse: { a: 9 }, indexedAt: 3, indexer: "w", prevPoi: ptr1 }),
			sign,
		);
		await expect(chain.append(fork)).rejects.toThrow(/chain fork/);
	});

	it("refuses to append an unsealed proof", async () => {
		const chain = new ProofChain();
		const unsigned = await buildProofOfIndexing({ routePtr: "sha256:r", sourceUrl: "https://e.com", observedResponse: {}, indexedAt: 1, indexer: "w" });
		await expect(chain.append(unsigned)).rejects.toThrow(/unsealed/);
	});

	it("derives freshness from the latest proof via the paper's decay function", async () => {
		const { sign } = await ed25519Signer();
		const chain = new ProofChain();
		const r = "sha256:route-fresh";
		const now = 1_700_000_000_000;
		const day = 24 * 60 * 60 * 1000;

		expect(chain.freshnessOf(r, now)).toBe(0); // never indexed → never fresh

		await chain.append(
			await sealProofOfIndexing(
				await buildProofOfIndexing({ routePtr: r, sourceUrl: "https://e.com", observedResponse: { a: 1 }, indexedAt: now, indexer: "w", prevPoi: null }),
				sign,
			),
		);
		expect(chain.freshnessOf(r, now)).toBeCloseTo(1, 6); // just indexed → 1
		expect(chain.freshnessOf(r, now + 30 * day)).toBeCloseTo(0.5, 6); // half-life 30d → 0.5
	});
});
