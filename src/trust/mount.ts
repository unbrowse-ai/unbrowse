/**
 * mount — wire the trust-refresh scheduler to REAL deps and start it on opt-in.
 *
 * scheduler.ts is dep-injected and pure; this is the one place that binds it to
 * the live system: routes from the marketplace catalog (listSkills), the wallet
 * Ed25519 signer (src/values/signer), and a read-only re-index transport. Called
 * from server boot. Gated by UNBROWSE_TRUST_REFRESH=1 — when off, nothing here
 * touches the wallet or the network.
 *
 * Read-only law (refresh-job §): only `idempotency === "safe"` endpoints reach
 * the job, and the transport here additionally issues ONLY GET/HEAD — a refresh
 * never mutates.
 */
// cross: sha256:b35fea21e179afd6de983a90f4c1575527619b2d0143edd7d31b0dd70d8a97f5  (the route code inherits the root signature — pointer not payload; verify via (internal))
import type { SkillManifest, EndpointDescriptor } from "../types/skill.js";
import type { Signer } from "../route-seed.js";
import { ProofChain } from "./proof-of-indexing.js";
import {
	maybeStartTrustRefresh,
	type SchedulerDeps,
	type TrustRefreshScheduler,
} from "./scheduler.js";
import type { RefreshRoute } from "./refresh-job.js";

/** The runtime proof chain — head cache for freshness; durable copy is the proof stream. */
export const trustProofChain = new ProofChain();

async function sha256Hex(s: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	const b = new Uint8Array(hash);
	let hex = "";
	for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, "0");
	return hex;
}

function bytesToHex(b: Uint8Array): string {
	let hex = "";
	for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, "0");
	return hex;
}

/** Stable content-addressed pointer for a route (skill+endpoint identity). */
export async function routePtrOf(skill: SkillManifest, endpoint: EndpointDescriptor): Promise<string> {
	const body = JSON.stringify({
		skill_id: skill.skill_id,
		endpoint_id: endpoint.endpoint_id,
		method: endpoint.method,
		url_template: endpoint.url_template,
	});
	return `sha256:${await sha256Hex(body)}`;
}

/** Flatten the catalog to refresh routes. Pure given the skills. */
export async function routesFromSkills(skills: SkillManifest[]): Promise<RefreshRoute[]> {
	const routes: RefreshRoute[] = [];
	for (const skill of skills) {
		for (const endpoint of skill.endpoints ?? []) {
			routes.push({ routePtr: await routePtrOf(skill, endpoint), endpoint });
		}
	}
	return routes;
}

/**
 * A read-only re-index transport: issue the endpoint's GET/HEAD against its live
 * source and return the parsed JSON. Throws on a non-safe method or a non-2xx —
 * the job turns a throw into expire/transient. `fetchFn` is injected for testing.
 */
export function makeReadOnlyReindex(fetchFn: typeof fetch = fetch) {
	return async (endpoint: EndpointDescriptor): Promise<unknown> => {
		if (endpoint.method !== "GET" && endpoint.method !== "HEAD") {
			throw new Error(`reindex refuses non-safe method ${endpoint.method}`);
		}
		const res = await fetchFn(endpoint.url_template, {
			method: endpoint.method,
			headers: { Accept: "application/json", ...(endpoint.headers_template ?? {}) },
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) throw new Error(`reindex HTTP ${res.status} for ${endpoint.endpoint_id}`);
		return res.json();
	};
}

/** Build the route Signer from the wallet's Ed25519 key (server-side). */
async function walletSigner(): Promise<{ sign: Signer; indexer: string }> {
	const { signBytes, getWalletPubkey } = await import("../values/signer.js");
	const pub = await getWalletPubkey();
	const sign: Signer = async (message: Uint8Array) => (await signBytes(message)).signature;
	return { sign, indexer: `wallet:${bytesToHex(pub)}` };
}

/** Assemble the live scheduler deps (catalog + wallet + transport + chain). */
export async function buildTrustRefreshDeps(): Promise<SchedulerDeps> {
	const { listSkills } = await import("../marketplace/index.js");
	const { sign, indexer } = await walletSigner();
	const reindex = makeReadOnlyReindex();
	return {
		loadRoutes: async () => routesFromSkills(await listSkills()),
		refresh: { reindex, sign, indexer, chain: trustProofChain },
		onEvents: (events) => {
			const refreshed = events.filter((e) => e.type === "endpoint_refreshed").length;
			const expired = events.filter((e) => e.type === "endpoint_expired").length;
			if (refreshed || expired) console.log(`[trust-refresh] refreshed=${refreshed} expired=${expired} of ${events.length}`);
		},
	};
}

/**
 * Start the 6h trust-refresh loop iff UNBROWSE_TRUST_REFRESH=1. Returns the
 * scheduler, or null when the flag is off (wallet + network untouched). Safe to
 * call unconditionally from boot.
 */
export async function startTrustRefreshIfEnabled(): Promise<TrustRefreshScheduler | null> {
	if (process.env.UNBROWSE_TRUST_REFRESH !== "1") return null;
	try {
		return maybeStartTrustRefresh(await buildTrustRefreshDeps());
	} catch (err) {
		console.warn(`[trust-refresh] not started: ${(err as Error).message}`);
		return null;
	}
}
