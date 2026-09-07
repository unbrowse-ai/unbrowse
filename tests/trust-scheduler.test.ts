import { afterEach, describe, expect, it } from "bun:test";
import {
	createTrustRefreshScheduler,
	maybeStartTrustRefresh,
	type SchedulerDeps,
} from "../src/trust/scheduler.js";
import { ProofChain } from "../src/trust/proof-of-indexing.js";
import { TRUST_REFRESH_INTERVAL_MS, type RefreshRoute } from "../src/trust/refresh-job.js";
import type { EndpointDescriptor } from "../src/types/skill.js";

async function sign() {
	const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	return async (m: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, m));
}

const ep = (id: string): EndpointDescriptor =>
	({ endpoint_id: id, method: "GET", url_template: `https://e.com/${id}`, idempotency: "safe", verification_status: "verified", reliability_score: 1, last_verified_at: new Date(0).toISOString() }) as EndpointDescriptor;

/** A fake injected timer: captures the callback so the test fires it manually — no real time. */
function fakeTimer() {
	let cb: (() => void) | null = null;
	let cleared = false;
	let lastMs = 0;
	const handle = { id: "fake" };
	const setIntervalFn = (fn: () => void, ms: number) => { cb = fn; lastMs = ms; return handle; };
	const clearIntervalFn = (h: unknown) => { if (h === handle) cleared = true; };
	return {
		setIntervalFn,
		clearIntervalFn,
		// only the two fns belong in SchedulerDeps; introspection stays separate
		// (named to NOT collide with SchedulerDeps.intervalMs, the cadence number).
		fns: { setIntervalFn, clearIntervalFn },
		fire: () => cb?.(),
		isCleared: () => cleared,
		registeredMs: () => lastMs,
		registered: () => cb !== null,
	};
}

const ORIGINAL_FLAG = process.env.UNBROWSE_TRUST_REFRESH;
afterEach(() => {
	if (ORIGINAL_FLAG === undefined) delete process.env.UNBROWSE_TRUST_REFRESH;
	else process.env.UNBROWSE_TRUST_REFRESH = ORIGINAL_FLAG;
});

async function baseDeps(over?: Partial<SchedulerDeps>): Promise<SchedulerDeps> {
	const routes: RefreshRoute[] = [{ routePtr: "sha256:r", endpoint: ep("items") }];
	return {
		loadRoutes: async () => routes,
		refresh: { reindex: async () => ({ a: 1 }), sign: await sign(), indexer: "w", chain: new ProofChain() },
		now: () => 1_700_000_000_000,
		...over,
	};
}

describe("trust refresh scheduler", () => {
	it("tick() runs one pass and reports events to the observer", async () => {
		const seen: number[] = [];
		const s = createTrustRefreshScheduler(await baseDeps({ onEvents: (e) => seen.push(e.length) }));
		const events = await s.tick();
		expect(events.length).toBe(1);
		expect(events[0]!.type).toBe("endpoint_refreshed");
		expect(seen).toEqual([1]);
	});

	it("never overlaps: a tick while one is in flight returns [] without re-loading routes", async () => {
		let loadCalls = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const deps = await baseDeps({
			loadRoutes: async () => { loadCalls++; await gate; return [{ routePtr: "sha256:r", endpoint: ep("x") }]; },
		});
		const s = createTrustRefreshScheduler(deps);
		const first = s.tick(); // enters, blocks on gate
		const second = await s.tick(); // in-flight → skipped immediately
		expect(second).toEqual([]);
		expect(loadCalls).toBe(1); // second tick never re-loaded
		release();
		await first;
	});

	it("start/stop drive the injected timer and are idempotent", async () => {
		const timer = fakeTimer();
		const chain = new ProofChain();
		const s = createTrustRefreshScheduler(await baseDeps({ ...timer.fns, refresh: { reindex: async () => ({ a: 1 }), sign: await sign(), indexer: "w", chain } }));

		expect(s.running()).toBe(false);
		s.start();
		s.start(); // idempotent — second start must not re-register
		expect(s.running()).toBe(true);
		expect(timer.registered()).toBe(true);
		expect(timer.registeredMs()).toBe(TRUST_REFRESH_INTERVAL_MS);

		// firing the captured callback runs a real pass → a proof is published
		timer.fire();
		await new Promise((r) => setTimeout(r, 10)); // let the async tick settle
		expect(chain.latest("sha256:r")?.indexedAt).toBe(1_700_000_000_000);

		s.stop();
		s.stop(); // idempotent
		expect(timer.isCleared()).toBe(true);
		expect(s.running()).toBe(false);
	});

	it("maybeStartTrustRefresh is opt-in: null unless UNBROWSE_TRUST_REFRESH=1", async () => {
		const timer = fakeTimer();
		delete process.env.UNBROWSE_TRUST_REFRESH;
		expect(maybeStartTrustRefresh(await baseDeps(timer.fns))).toBeNull();

		process.env.UNBROWSE_TRUST_REFRESH = "1";
		const s = maybeStartTrustRefresh(await baseDeps(timer.fns));
		expect(s).not.toBeNull();
		expect(s!.running()).toBe(true);
		s!.stop();
	});
});
