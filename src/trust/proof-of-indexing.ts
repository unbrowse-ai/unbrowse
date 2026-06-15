/**
 * proof-of-indexing — the verifiable freshness primitive (Paper 3 §"the proof
 * of indexing is tagged \prop"; arXiv:2604.00694 companion, internal-apis-were-not-all-you-needed.tex).
 *
 * A shared route graph solves discovery once; freshness is a standing liability.
 * A route that is "wrong with confidence" is worse than no route at all. This
 * module makes a freshness *claim* into a checkable *artifact*: a maintainer
 * re-fetches a route's live source, fingerprints the observed response schema,
 * and emits a content-addressed, signed attestation chained to the route's prior
 * proof. The bond-and-slash corrective (next node) can then slash a PoI that
 * claimed fresh while the live schema had drifted — the proof is falsifiable, so
 * the lie is provable.
 *
 * Lineage (cited in the paper): The Graph's Proof of Indexing + Filecoin
 * PoRep/PoSt — a content-addressed attestation that work was done against a real
 * source, not asserted.
 *
 * Pure + signer-injected, exactly like covenant-seed: the signing key lives in
 * the Privy/TEE wallet (the root atom), never here. Web Crypto only, zero deps.
 * Mechanism-compatible with covenant-seed: insertion-order JSON → sha256 →
 * `sha256:` pointer (NOT sorted-key — byte-compat with covenant-binary).
 */
// cross: sha256:b35fea21e179afd6de983a90f4c1575527619b2d0143edd7d31b0dd70d8a97f5  (the covenant code inherits the cross — pointer not payload; verify via .claude/superpattern/cross-stamp-gate.sh)
import { freshnessFromDate } from "../lib/freshness.js";
import type { Signer } from "../covenant-seed.js";

// ─── schema fingerprint: the checkable "what was observed" ───────────────────
// A route's response, reduced to a structural descriptor: which keys exist and
// what shape each holds, order-independent and value-independent. Field renames,
// removals, and type changes (the ways a route silently drifts behind a cheerful
// 200) change the fingerprint; key reordering and value changes do not.

/** Recursive structural descriptor of an observed value. */
export function schemaDescriptor(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) {
		// Union of element descriptors, deduped + sorted → order/length-independent.
		const inner = Array.from(new Set(value.map(schemaDescriptor))).sort();
		return `[${inner.join("|")}]`;
	}
	const t = typeof value;
	if (t === "object") {
		const obj = value as Record<string, unknown>;
		const fields = Object.keys(obj)
			.sort()
			.map((k) => `${k}:${schemaDescriptor(obj[k])}`);
		return `{${fields.join(",")}}`;
	}
	// primitive: its type name (string/number/boolean/undefined/bigint/symbol/function)
	return t;
}

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

/**
 * `sha256:`-prefixed fingerprint of an observed response schema. Two responses
 * with the same structure (any field order, any values) hash identically; any
 * drift in the set of fields or their types changes the hash.
 */
export async function schemaHash(observedResponse: unknown): Promise<string> {
	return `sha256:${await sha256Hex(schemaDescriptor(observedResponse))}`;
}

// ─── the proof record ────────────────────────────────────────────────────────

/** A content-addressed attestation that a route was re-indexed against live source. */
export interface ProofOfIndexing {
	/** content-addressed pointer to the route this proof attests (sha256:…). */
	routePtr: string;
	/** the live source the maintainer re-indexed. */
	sourceUrl: string;
	/** sha256: fingerprint of the schema observed at the live source. */
	schemaHash: string;
	/** ms-epoch of the live re-index. */
	indexedAt: number;
	/** content-addressed pointer to the previous PoI for this route (hash-chain), or null at genesis. */
	prevPoi: string | null;
	/** wallet identity of the maintainer who indexed (who staked the claim). */
	indexer: string;
	/** Ed25519 hex over the canonical body; absent until sealed. */
	signature?: string;
}

/** Canonical signing/addressing body — insertion-order, signature excluded. */
function canonicalBody(poi: ProofOfIndexing): string {
	return JSON.stringify({
		routePtr: poi.routePtr,
		sourceUrl: poi.sourceUrl,
		schemaHash: poi.schemaHash,
		indexedAt: poi.indexedAt,
		prevPoi: poi.prevPoi,
		indexer: poi.indexer,
	});
}

/** Assemble an unsigned proof from a live re-index observation. */
export async function buildProofOfIndexing(params: {
	routePtr: string;
	sourceUrl: string;
	observedResponse: unknown;
	indexedAt: number;
	indexer: string;
	prevPoi?: string | null;
}): Promise<ProofOfIndexing> {
	return {
		routePtr: params.routePtr,
		sourceUrl: params.sourceUrl,
		schemaHash: await schemaHash(params.observedResponse),
		indexedAt: params.indexedAt,
		prevPoi: params.prevPoi ?? null,
		indexer: params.indexer,
	};
}

/** Seal the proof with the root wallet's Ed25519 key (signer injected). */
export async function sealProofOfIndexing(
	poi: ProofOfIndexing,
	sign: Signer,
): Promise<ProofOfIndexing> {
	const sig = await sign(new TextEncoder().encode(canonicalBody(poi)));
	return { ...poi, signature: bytesToHex(sig) };
}

/** Content-addressed pointer to a proof (its place in the next proof's chain). */
export async function proofPtr(poi: ProofOfIndexing): Promise<string> {
	return `sha256:${await sha256Hex(canonicalBody(poi))}`;
}

/** Verify a proof's signature against the indexer's public key (verifier injected). */
export async function verifyProofOfIndexing(
	poi: ProofOfIndexing,
	verify: (message: Uint8Array, signatureHex: string, indexer: string) => Promise<boolean>,
): Promise<boolean> {
	if (!poi.signature) return false;
	return verify(new TextEncoder().encode(canonicalBody(poi)), poi.signature, poi.indexer);
}

/**
 * The falsifiable fact a challenge proves: a sealed PoI claimed a schema that
 * the live source no longer serves. Re-index now, fingerprint, compare. A `true`
 * result is grounds for slashing the indexer's bond (next node) — the route was
 * stale-but-confident, the worst failure mode.
 */
export async function proofDiverged(
	poi: ProofOfIndexing,
	liveResponse: unknown,
): Promise<boolean> {
	return poi.schemaHash !== (await schemaHash(liveResponse));
}

// ─── the chain: per-route freshness history, tamper-evident ─────────────────

/**
 * ProofChain — append-only, per-route hash-chained proof history. Each appended
 * proof must link to the route's current head (prevPoi === head ptr), so the
 * freshness record cannot be silently re-written; a maintainer extends it, never
 * forks it. In-memory by design (mirrors DiscoveryLedger); the durable copy is
 * the sealed proof stream itself.
 */
export class ProofChain {
	private readonly headPtr = new Map<string, string>(); // routePtr → latest proofPtr
	private readonly headPoi = new Map<string, ProofOfIndexing>(); // routePtr → latest proof

	/** The current head proof for a route, or undefined if never indexed. */
	latest(routePtr: string): ProofOfIndexing | undefined {
		return this.headPoi.get(routePtr);
	}

	/** The content-addressed head pointer to chain the next proof onto. */
	headOf(routePtr: string): string | null {
		return this.headPtr.get(routePtr) ?? null;
	}

	/**
	 * Append a sealed proof, enforcing the chain link. Throws if the proof does
	 * not link to the route's current head (a fork attempt) or is unsigned.
	 */
	async append(poi: ProofOfIndexing): Promise<string> {
		if (!poi.signature) throw new Error("proof-of-indexing: cannot append an unsealed proof");
		const expectedPrev = this.headPtr.get(poi.routePtr) ?? null;
		if (poi.prevPoi !== expectedPrev) {
			throw new Error(
				`proof-of-indexing: chain fork — prevPoi ${poi.prevPoi ?? "null"} != head ${expectedPrev ?? "null"}`,
			);
		}
		const ptr = await proofPtr(poi);
		this.headPtr.set(poi.routePtr, ptr);
		this.headPoi.set(poi.routePtr, poi);
		return ptr;
	}

	/**
	 * Freshness of a route from its latest proof, via the paper's decay function
	 * (arXiv:2604.00694 §6.3, src/ranking/freshness.ts). An un-indexed route is 0
	 * — never indexed is never fresh.
	 */
	freshnessOf(routePtr: string, now: number = Date.now()): number {
		const head = this.headPoi.get(routePtr);
		if (!head) return 0;
		return freshnessFromDate(head.indexedAt, now);
	}
}
