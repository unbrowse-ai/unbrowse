/**
 * refresh-job — the 6h continuous trust refresh (PAPER_PLAN P3; arXiv:2604.00694
 * §6.3 "Background verification" / "routes stale > 24h prioritized").
 *
 * Discovery is a one-time cost; freshness is a standing liability. This job is
 * the standing corrective: on a 6h cadence it re-indexes the routes that have
 * gone stale, emits a proof of indexing for each (proof-of-indexing.ts), and
 * surfaces refreshed/expired events. The freshness those proofs carry then flows
 * into the composite ranker (trustFreshnessProvider below) — publish and consume,
 * the loop closed.
 *
 * Read-only by law: only `idempotency === "safe"` endpoints are re-issued. A
 * refresh NEVER fires a mutating endpoint (P3 §"never auto-execute mutating
 * endpoints during refresh").
 *
 * Pure + dependency-injected: the live request (`reindex`), the wallet signer
 * (`sign`), the clock (`now`), and the proof chain are all passed in, so the
 * job is deterministic and testable without a network, a wallet, or a timer.
 */
// cross: sha256:b35fea21e179afd6de983a90f4c1575527619b2d0143edd7d31b0dd70d8a97f5  (the covenant code inherits the cross — pointer not payload; verify via .claude/superpattern/cross-stamp-gate.sh)
import type { EndpointDescriptor } from "../types/skill.js";
import type { Signer } from "../covenant-seed.js";
import {
	buildProofOfIndexing,
	sealProofOfIndexing,
	ProofChain,
} from "./proof-of-indexing.js";
import { freshness } from "../lib/freshness.js";

/** Scheduler cadence — the paper's 6h background-verification interval. */
export const TRUST_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Default staleness threshold — the paper prioritizes routes older than 24h. */
export const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;
/** Default expiry — a route that cannot be re-indexed for 7d is marked expired. */
export const DEFAULT_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A route eligible for refresh: its endpoint + a content-addressed route pointer. */
export interface RefreshRoute {
	routePtr: string;
	endpoint: EndpointDescriptor;
}

export interface RefreshDeps {
	/**
	 * Re-issue the endpoint's live request and return the parsed response. MUST be
	 * read-only (the caller wires a GET/HEAD-only transport). Throws on failure.
	 */
	reindex: (endpoint: EndpointDescriptor) => Promise<unknown>;
	/** Ed25519 signer for the publishing maintainer (root wallet; injected). */
	sign: Signer;
	/** Maintainer wallet identity that stakes each proof. */
	indexer: string;
	/** The per-route proof chain the job extends. */
	chain: ProofChain;
	/** Clock (ms-epoch). */
	now: number;
}

export interface RefreshPolicy {
	staleMs?: number; // re-index routes whose last index is older than this
	expireMs?: number; // mark expired when a stale route's re-index keeps failing past this
}

export type RefreshEvent =
	| { type: "endpoint_refreshed"; endpoint_id: string; routePtr: string; proofPtr: string; freshness: number }
	| { type: "endpoint_expired"; endpoint_id: string; routePtr: string; reason: string }
	| { type: "endpoint_skipped"; endpoint_id: string; routePtr: string; reason: "fresh" | "mutating" | "transient_failure" };

/** Age (ms) of a route's freshness anchor: its chain head, else last_verified_at, else +∞. */
function routeAgeMs(route: RefreshRoute, chain: ProofChain, now: number): number {
	const head = chain.latest(route.routePtr);
	if (head) return Math.max(0, now - head.indexedAt);
	const lv = route.endpoint.last_verified_at;
	const lvMs = lv ? Date.parse(lv) : NaN;
	if (Number.isFinite(lvMs)) return Math.max(0, now - lvMs);
	return Number.POSITIVE_INFINITY; // never indexed → maximally stale
}

/**
 * One refresh pass. Selects stale routes (oldest first — the paper prioritizes
 * the most stale), re-indexes each read-only endpoint into a fresh sealed proof,
 * and returns the event stream. Pure given its deps.
 */
export async function runTrustRefresh(
	routes: RefreshRoute[],
	deps: RefreshDeps,
	policy: RefreshPolicy = {},
): Promise<RefreshEvent[]> {
	const staleMs = policy.staleMs ?? DEFAULT_STALE_MS;
	const expireMs = policy.expireMs ?? DEFAULT_EXPIRE_MS;
	const events: RefreshEvent[] = [];

	// Oldest-first: the paper prioritizes the most stale routes for re-verification.
	const ordered = [...routes].sort(
		(a, b) => routeAgeMs(b, deps.chain, deps.now) - routeAgeMs(a, deps.chain, deps.now),
	);

	for (const route of ordered) {
		const { endpoint, routePtr } = route;

		// Read-only law: never re-issue a mutating endpoint.
		if (endpoint.idempotency !== "safe") {
			events.push({ type: "endpoint_skipped", endpoint_id: endpoint.endpoint_id, routePtr, reason: "mutating" });
			continue;
		}

		const age = routeAgeMs(route, deps.chain, deps.now);
		if (age < staleMs) {
			events.push({ type: "endpoint_skipped", endpoint_id: endpoint.endpoint_id, routePtr, reason: "fresh" });
			continue;
		}

		try {
			const observed = await deps.reindex(endpoint);
			const proof = await sealProofOfIndexing(
				await buildProofOfIndexing({
					routePtr,
					sourceUrl: endpoint.url_template,
					observedResponse: observed,
					indexedAt: deps.now,
					indexer: deps.indexer,
					prevPoi: deps.chain.headOf(routePtr),
				}),
				deps.sign,
			);
			const ptr = await deps.chain.append(proof);
			events.push({
				type: "endpoint_refreshed",
				endpoint_id: endpoint.endpoint_id,
				routePtr,
				proofPtr: ptr,
				freshness: freshness(0), // just re-indexed → 1
			});
		} catch (err) {
			// Re-index failed. Expire only if the route has been stale past expireMs;
			// otherwise treat as transient and retry next cycle.
			if (age >= expireMs) {
				events.push({
					type: "endpoint_expired",
					endpoint_id: endpoint.endpoint_id,
					routePtr,
					reason: err instanceof Error ? err.message : String(err),
				});
			} else {
				events.push({ type: "endpoint_skipped", endpoint_id: endpoint.endpoint_id, routePtr, reason: "transient_failure" });
			}
		}
	}

	return events;
}

/**
 * The consume side of the loop: a freshness provider the composite ranker calls.
 * Returns the route's freshness signal in [0,1] from its latest proof, decayed by
 * the paper's function (src/ranking/freshness.ts). A route with no proof is 0 —
 * un-indexed is never fresh, so the ranker never trusts an unverified route's age.
 *
 * Wire into the composite scorer as the `freshness` argument:
 *   composite(sim, reliability, trustFreshnessProvider(chain)(routePtr, now), verification)
 */
export function trustFreshnessProvider(chain: ProofChain) {
	return (routePtr: string, now: number = Date.now()): number => chain.freshnessOf(routePtr, now);
}

/** Convenience: age of a route in days from its proof chain (for telemetry/logging). */
export function routeAgeDays(routePtr: string, chain: ProofChain, now: number = Date.now()): number {
	const head = chain.latest(routePtr);
	if (!head) return Number.POSITIVE_INFINITY;
	return Math.max(0, now - head.indexedAt) / MS_PER_DAY;
}
