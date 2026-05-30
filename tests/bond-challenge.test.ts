import { describe, expect, it } from "bun:test";
import { BondLedger, resolveChallenge, type BondPolicy } from "../src/trust/bond-challenge.js";
import { buildProofOfIndexing, sealProofOfIndexing } from "../src/trust/proof-of-indexing.js";

const POLICY: BondPolicy = { minBond: 1_000, penalty: 600, challengerRewardBps: 5_000 }; // 50% to challenger

async function sealedProof(observed: unknown, indexer: string) {
	const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const sign = async (m: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, m));
	return sealProofOfIndexing(
		await buildProofOfIndexing({
			routePtr: "sha256:r",
			sourceUrl: "https://example.com/api",
			observedResponse: observed,
			indexedAt: 1,
			indexer,
		}),
		sign,
	);
}

describe("bond ledger", () => {
	it("accumulates bond and gates eligibility by a threshold, not a score", () => {
		const l = new BondLedger();
		expect(l.isEligible("m", POLICY)).toBe(false);
		l.bond("m", 400, 1);
		l.bond("m", 700, 2); // total 1100 ≥ minBond 1000
		expect(l.bondedAmount("m")).toBe(1_100);
		expect(l.isEligible("m", POLICY)).toBe(true);
		// eligibility is boolean: a 10x bond is no more eligible than a just-over one
		l.bond("m", 100_000, 3);
		expect(l.isEligible("m", POLICY)).toBe(true); // still just `true` — no rank
	});

	it("rejects non-positive bonds and caps slash at the balance", () => {
		const l = new BondLedger();
		expect(() => l.bond("m", 0, 1)).toThrow(/positive/);
		l.bond("m", 500, 1);
		expect(l.slash("m", 600)).toEqual({ slashed: 500, remaining: 0 }); // capped at 500
		expect(l.bondedAmount("m")).toBe(0);
	});
});

describe("challenge resolution (composes real proofs)", () => {
	it("dismisses when the live schema still matches the proof", async () => {
		const l = new BondLedger();
		l.bond("maintainer", 2_000, 1);
		const proof = await sealedProof({ items: [{ id: 1 }], total: 1 }, "maintainer");
		// live values changed but the schema is identical → proof held
		const v = await resolveChallenge(proof, { items: [{ id: 7 }], total: 42 }, l, POLICY);
		expect(v.outcome).toBe("dismissed");
		expect(v.diverged).toBe(false);
		expect(l.bondedAmount("maintainer")).toBe(2_000); // untouched
	});

	it("upholds and slashes when the live schema has drifted", async () => {
		const l = new BondLedger();
		l.bond("maintainer", 2_000, 1);
		const proof = await sealedProof({ items: [{ id: 1, title: "x" }], total: 1 }, "maintainer");
		// `title` gone from the item shape → stale-but-confident → slash
		const v = await resolveChallenge(proof, { items: [{ id: 1 }], total: 1 }, l, POLICY);
		expect(v.outcome).toBe("upheld");
		if (v.outcome !== "upheld") throw new Error("unreachable");
		expect(v.slashed).toBe(600); // policy.penalty
		expect(v.challengerReward).toBe(300); // 50% of slashed
		expect(v.burned).toBe(300); // remainder burned
		expect(v.maintainerRemaining).toBe(1_400);
		expect(l.bondedAmount("maintainer")).toBe(1_400);
	});

	it("reward + burn always equal the slashed amount (no value leaks)", async () => {
		const l = new BondLedger();
		l.bond("m", 10_000, 1);
		const proof = await sealedProof({ a: 1, b: 2 }, "m");
		const v = await resolveChallenge(proof, { a: 1 }, l, { minBond: 1, penalty: 777, challengerRewardBps: 3_333 });
		if (v.outcome !== "upheld") throw new Error("expected upheld");
		expect(v.challengerReward + v.burned).toBe(v.slashed);
	});
});
