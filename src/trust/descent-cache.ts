/**
 * descent-cache — the KV-cached fallback pipe (Paper 2 §2 end-to-end descent +
 * §5 content-addressed cache).
 *
 * The whole stack is self-similar: at every layer the move is the same — try the
 * highest layer that can answer completely, fall back to the next only when it
 * cannot, and cache what you settled so the next call short-circuits. "A cached
 * signed plan beats a CLI call beats a browser action beats moving a mouse."
 * This is that shape as ONE reusable primitive, so a single content-addressed
 * cache can serve the entire tree instead of bespoke caching at each caller.
 *
 *   request → [content-cache hit? return instantly]
 *           → layer 1 (cheapest/highest) → … → layer N (packet) → first win
 *           → cache the win by content-address → return
 *
 * Speed is the cache: a hit costs one hash + a map lookup and never descends.
 * The win is keyed by the content-address of the request, so the same request
 * resolves the same slot on any host (host-independent, like the rest of §5).
 *
 * Pure + Web-Crypto only; no I/O. Composes with the sealed cache for sensitive
 * wins (seal the value, cache the sealed blob) — see sealed-cache.ts.
 */
const PTR_PREFIX = "sha256:";

async function sha256Hex(s: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	const b = new Uint8Array(hash);
	let hex = "";
	for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, "0");
	return hex;
}

/** Canonical, insertion-order serialization (matches the covenant surface). */
function canonical(value: unknown): string {
	return JSON.stringify(value ?? null);
}

/** The content-address of a request key — the host-independent cache slot. */
export async function contentAddress(key: unknown): Promise<string> {
	return `${PTR_PREFIX}${await sha256Hex(canonical(key))}`;
}

/**
 * A content-addressed KV store: a value is filed under the hash of the request
 * that produced it, so the same request resolves the same slot on any host. The
 * durable copy lives wherever the caller persists it; this is the in-memory
 * working set (mirrors the other trust ledgers).
 */
export class ContentAddressedCache<T = unknown> {
	private readonly entries = new Map<string, { value: T; storedAt: number }>();

	async get(key: unknown): Promise<T | undefined> {
		return this.entries.get(await contentAddress(key))?.value;
	}

	async put(key: unknown, value: T, at = 0): Promise<string> {
		const addr = await contentAddress(key);
		this.entries.set(addr, { value, storedAt: at });
		return addr;
	}

	async has(key: unknown): Promise<boolean> {
		return this.entries.has(await contentAddress(key));
	}

	get size(): number {
		return this.entries.size;
	}
}

/** One rung of the descent: a thunk that either answers (non-null) or declines
 *  (null/undefined → fall through to the next, lower layer). */
export type DescentLayer<T> = {
	/** A short, stable name for the layer (for the verdict + tracing). */
	name: string;
	/** Try this layer. Return the value if it can answer completely, else null. */
	try: () => Promise<T | null | undefined>;
};

export interface DescentResult<T> {
	/** The settled value, or null if every layer declined. */
	value: T | null;
	/** Where it came from: "cache" on a hit, the layer name on a fresh win, or
	 *  null when nothing answered. */
	layer: string | null;
	/** True iff served from the content cache without descending. */
	cached: boolean;
}

/**
 * Walk the cached fallback pipe for a request `key`:
 *   1. content-cache hit → return it instantly (no layer runs);
 *   2. else try each layer top-to-bottom; the FIRST non-null wins and lower
 *      layers never run (the end-to-end rule: highest layer that can act);
 *   3. cache the win by content-address so the next identical call is a hit.
 * A request nothing can answer returns {value:null, layer:null} and is NOT
 * cached (a miss is not a settled result).
 */
export async function descentResolve<T>(args: {
	key: unknown;
	layers: DescentLayer<T>[];
	cache: ContentAddressedCache<T>;
	at?: number;
}): Promise<DescentResult<T>> {
	const { key, layers, cache, at = 0 } = args;
	const hit = await cache.get(key);
	if (hit !== undefined) return { value: hit, layer: "cache", cached: true };
	for (const layer of layers) {
		const out = await layer.try();
		if (out !== null && out !== undefined) {
			await cache.put(key, out, at);
			return { value: out, layer: layer.name, cached: false };
		}
	}
	return { value: null, layer: null, cached: false };
}
