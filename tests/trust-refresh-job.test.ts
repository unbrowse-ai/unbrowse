import { describe, expect, it } from "bun:test";
import {
	runTrustRefresh,
	trustFreshnessProvider,
	TRUST_REFRESH_INTERVAL_MS,
	DEFAULT_STALE_MS,
	type RefreshRoute,
} from "../src/trust/refresh-job.js";
import { ProofChain } from "../src/trust/proof-of-indexing.js";
import { composite } from "../src/ranking/composite.js";
import type { EndpointDescriptor } from "../src/types/skill.js";

async function signer() {
	const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	return async (m: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, m));
}

function endpoint(over: Partial<EndpointDescriptor> & { endpoint_id: string }): EndpointDescriptor {
	return {
		method: "GET",
		url_template: `https://example.com/api/${over.endpoint_id}`,
		idempotency: "safe",
		verification_status: "verified",
		reliability_score: 1,
		...over,
	} as EndpointDescriptor;
}

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("trust refresh job", () => {
	it("exposes the paper's 6h cadence and 24h staleness threshold", () => {
		expect(TRUST_REFRESH_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
		expect(DEFAULT_STALE_MS).toBe(24 * 60 * 60 * 1000);
	});

	it("re-indexes a stale read-only route into a sealed proof and emits refreshed", async () => {
		const chain = new ProofChain();
		const sign = await signer();
		const routes: RefreshRoute[] = [
			{ routePtr: "sha256:r1", endpoint: endpoint({ endpoint_id: "items", last_verified_at: new Date(NOW - 3 * DAY).toISOString() }) },
		];
		let reindexCalls = 0;
		const events = await runTrustRefresh(routes, {
			reindex: async () => { reindexCalls++; return { items: [{ id: 1 }], total: 1 }; },
			sign,
			indexer: "wallet:m",
			chain,
			now: NOW,
		});
		expect(reindexCalls).toBe(1);
		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("endpoint_refreshed");
		expect(chain.latest("sha256:r1")?.indexedAt).toBe(NOW); // proof published
		expect(chain.freshnessOf("sha256:r1", NOW)).toBeCloseTo(1, 6);
	});

	it("NEVER re-issues a mutating endpoint (read-only law)", async () => {
		const chain = new ProofChain();
		const sign = await signer();
		let reindexCalls = 0;
		const events = await runTrustRefresh(
			[{ routePtr: "sha256:mut", endpoint: endpoint({ endpoint_id: "delete", idempotency: "unsafe", last_verified_at: new Date(NOW - 9 * DAY).toISOString() }) }],
			{ reindex: async () => { reindexCalls++; return {}; }, sign, indexer: "w", chain, now: NOW },
		);
		expect(reindexCalls).toBe(0); // the mutating endpoint was never called
		expect(events[0]).toMatchObject({ type: "endpoint_skipped", reason: "mutating" });
	});

	it("skips a still-fresh route without re-indexing", async () => {
		const chain = new ProofChain();
		const sign = await signer();
		let reindexCalls = 0;
		const events = await runTrustRefresh(
			[{ routePtr: "sha256:fresh", endpoint: endpoint({ endpoint_id: "x", last_verified_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() }) }],
			{ reindex: async () => { reindexCalls++; return {}; }, sign, indexer: "w", chain, now: NOW },
		);
		expect(reindexCalls).toBe(0);
		expect(events[0]).toMatchObject({ type: "endpoint_skipped", reason: "fresh" });
	});

	it("expires a long-stale route whose re-index fails, but retries a transient one", async () => {
		const chain = new ProofChain();
		const sign = await signer();
		const fail = async () => { throw new Error("502 from source"); };

		const expired = await runTrustRefresh(
			[{ routePtr: "sha256:dead", endpoint: endpoint({ endpoint_id: "dead", last_verified_at: new Date(NOW - 30 * DAY).toISOString() }) }],
			{ reindex: fail, sign, indexer: "w", chain, now: NOW },
			{ expireMs: 7 * DAY },
		);
		expect(expired[0]).toMatchObject({ type: "endpoint_expired" });

		const transient = await runTrustRefresh(
			[{ routePtr: "sha256:flaky", endpoint: endpoint({ endpoint_id: "flaky", last_verified_at: new Date(NOW - 2 * DAY).toISOString() }) }],
			{ reindex: fail, sign, indexer: "w", chain, now: NOW },
			{ expireMs: 7 * DAY },
		);
		expect(transient[0]).toMatchObject({ type: "endpoint_skipped", reason: "transient_failure" });
	});

	it("processes the most-stale route first", async () => {
		const chain = new ProofChain();
		const sign = await signer();
		const order: string[] = [];
		await runTrustRefresh(
			[
				{ routePtr: "sha256:newer", endpoint: endpoint({ endpoint_id: "newer", last_verified_at: new Date(NOW - 2 * DAY).toISOString() }) },
				{ routePtr: "sha256:older", endpoint: endpoint({ endpoint_id: "older", last_verified_at: new Date(NOW - 10 * DAY).toISOString() }) },
			],
			{ reindex: async (e) => { order.push(e.endpoint_id); return {}; }, sign, indexer: "w", chain, now: NOW },
		);
		expect(order).toEqual(["older", "newer"]);
	});
});

describe("consume side — freshness flows into the composite ranker", () => {
	it("a freshly-refreshed route outscores a stale one on the freshness dimension", async () => {
		const chain = new ProofChain();
		const sign = await signer();
		// refresh r_fresh now; r_stale's only proof is 60 days old
		await runTrustRefresh(
			[{ routePtr: "sha256:r_fresh", endpoint: endpoint({ endpoint_id: "f", last_verified_at: new Date(NOW - 5 * DAY).toISOString() }) }],
			{ reindex: async () => ({ a: 1 }), sign, indexer: "w", chain, now: NOW },
		);
		await runTrustRefresh(
			[{ routePtr: "sha256:r_stale", endpoint: endpoint({ endpoint_id: "s", last_verified_at: new Date(NOW - 90 * DAY).toISOString() }) }],
			{ reindex: async () => ({ a: 1 }), sign, indexer: "w", chain, now: NOW - 60 * DAY }, // proof published 60d ago
		);

		const fresh = trustFreshnessProvider(chain);
		const scoreFresh = composite(0.8, 0.9, fresh("sha256:r_fresh", NOW), 1);
		const scoreStale = composite(0.8, 0.9, fresh("sha256:r_stale", NOW), 1);
		const scoreUnknown = composite(0.8, 0.9, fresh("sha256:never", NOW), 1);

		expect(fresh("sha256:r_fresh", NOW)).toBeCloseTo(1, 6);
		expect(fresh("sha256:r_stale", NOW)).toBeLessThan(0.5); // 60d old → decayed
		expect(fresh("sha256:never", NOW)).toBe(0); // never indexed → never fresh
		expect(scoreFresh).toBeGreaterThan(scoreStale);
		expect(scoreStale).toBeGreaterThan(scoreUnknown);
	});
});
