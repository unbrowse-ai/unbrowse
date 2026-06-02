/**
 * hole-template — "expose ONLY the holes to fill."
 *
 * The backend holds the reverse-engineering; the client should receive nothing
 * but the request SKELETON (structure, no secrets) plus a typed list of HOLES —
 * the exact slots it must fill locally from its own vault (auth/secrets) and its
 * own LLM (free params). The secret values never leave the client and the
 * skeleton never carries them: the wire exposes the shape and the names of what
 * to fill, and that is all.
 *
 *   obfuscated capture  ──reveng──▶  { skeleton, holes[] }   (sent to client)
 *   client fills holes from vault + LLM  ──▶  concrete request  (executed locally)
 *
 * This is the per-slot twin of the whole obfuscation story: obfuscate.ts turns
 * each secret into a placeholder; this names that placeholder as a hole with a
 * location + kind + fill-source, so the client knows precisely what to supply
 * and nothing more is asked of it. Composes with wallet-bind (a bound hole
 * carries its commitment) and the sealed cache (a filled value can be sealed).
 */
import type { RawRequest } from "./index.js";

const REDACTED_TOKEN = "[REDACTED]";
const BOUND_RE = /^\[bound:([0-9a-f]{16})\]$/;
const ID_TOKEN = "{id}";

export type HoleKind = "secret" | "id";
/** Where the client sources the fill: its local vault (auth/secret) or its LLM
 *  (a free identifier/parameter the agent decides). */
export type FillSource = "vault" | "llm";

export type HoleLocation =
	| { in: "header"; name: string }
	| { in: "query"; name: string }
	| { in: "path"; index: number }
	| { in: "body"; pointer: string[] };

export interface Hole {
	/** structured location of the slot in the request. */
	location: HoleLocation;
	/** the field name the client recognises (e.g. "authorization", "api_key"). */
	name: string;
	kind: HoleKind;
	/** vault for secrets/auth, llm for free ids/params. */
	fill: FillSource;
	/** when wallet-bound, the [bound:<hex>] commitment proving the slot is bound
	 *  to the owner's wallet (see wallet-bind.ts). */
	bound?: string;
}

export interface HoleTemplate {
	/** the obfuscated request: structure only, every secret already a placeholder. */
	skeleton: RawRequest;
	/** exactly the slots the client fills — nothing else is exposed or asked. */
	holes: Hole[];
}

function classifyToken(value: string): { kind: HoleKind; fill: FillSource; bound?: string } | null {
	if (value === REDACTED_TOKEN) return { kind: "secret", fill: "vault" };
	const m = BOUND_RE.exec(value);
	if (m) return { kind: "secret", fill: "vault", bound: value };
	if (value === ID_TOKEN) return { kind: "id", fill: "llm" };
	return null;
}

/**
 * Read the holes out of an ALREADY-OBFUSCATED request. Returns the skeleton
 * (unchanged structure) and the typed holes the client must fill. Only slots
 * that obfuscation marked as placeholders become holes; everything else is
 * inert structure the client does not touch.
 */
export function extractHoles(skeleton: RawRequest): HoleTemplate {
	const holes: Hole[] = [];

	// Headers.
	for (const [name, value] of Object.entries(skeleton.request_headers ?? {})) {
		const c = classifyToken(String(value));
		if (c) holes.push({ location: { in: "header", name }, name, ...c });
	}

	// URL query + path.
	try {
		const u = new URL(skeleton.url);
		for (const [name, value] of u.searchParams.entries()) {
			const c = classifyToken(value);
			if (c) holes.push({ location: { in: "query", name }, name, ...c });
		}
		// new URL() percent-encodes the {id} route placeholder in pathname
		// (%7Bid%7D); decode each segment for detection while keeping the split
		// index stable (fillHoles splits the same way, so indices align).
		const segs = u.pathname.split("/");
		segs.forEach((seg, index) => {
			let decoded = seg;
			try {
				decoded = decodeURIComponent(seg);
			} catch {
				/* keep raw */
			}
			const c = classifyToken(decoded);
			if (c) holes.push({ location: { in: "path", index }, name: `path[${index}]`, ...c });
		});
	} catch {
		/* non-URL — no url holes */
	}

	// JSON body (recurse, record the pointer path to each placeholder leaf).
	if (skeleton.request_body) {
		const trimmed = skeleton.request_body.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				walkBody(JSON.parse(trimmed), [], holes);
			} catch {
				/* not JSON — skip */
			}
		}
	}

	return { skeleton, holes };
}

function walkBody(node: unknown, pointer: string[], holes: Hole[]): void {
	if (typeof node === "string") {
		const c = classifyToken(node);
		if (c) holes.push({ location: { in: "body", pointer: [...pointer] }, name: pointer[pointer.length - 1] ?? "body", ...c });
		return;
	}
	if (Array.isArray(node)) {
		node.forEach((v, i) => walkBody(v, [...pointer, String(i)], holes));
		return;
	}
	if (node && typeof node === "object") {
		for (const [k, v] of Object.entries(node)) walkBody(v, [...pointer, k], holes);
	}
}

/**
 * Fill the holes locally into a concrete request. `fills` maps each hole's
 * `name` to the value the client sourced (auth from vault, params from its LLM).
 * A hole with no provided fill is left as its placeholder (honest: an unfilled
 * hole is visible, never silently blanked). Returns a NEW request; the template
 * is not mutated.
 */
export function fillHoles(template: HoleTemplate, fills: Record<string, string>): RawRequest {
	const out: RawRequest = { ...template.skeleton, request_headers: { ...template.skeleton.request_headers } };
	let urlObj: URL | null = null;
	try {
		urlObj = new URL(out.url);
	} catch {
		urlObj = null;
	}
	let pathSegs = urlObj ? urlObj.pathname.split("/") : null;
	let body: unknown = undefined;
	let bodyIsJson = false;
	if (out.request_body) {
		const trimmed = out.request_body.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				body = JSON.parse(trimmed);
				bodyIsJson = true;
			} catch {
				/* leave as-is */
			}
		}
	}

	for (const hole of template.holes) {
		if (!(hole.name in fills)) continue;
		const value = fills[hole.name];
		switch (hole.location.in) {
			case "header":
				out.request_headers[hole.location.name] = value;
				break;
			case "query":
				if (urlObj) urlObj.searchParams.set(hole.location.name, value);
				break;
			case "path":
				if (pathSegs && hole.location.index < pathSegs.length) pathSegs[hole.location.index] = value;
				break;
			case "body":
				if (bodyIsJson) setAtPointer(body, hole.location.pointer, value);
				break;
		}
	}

	if (urlObj) {
		if (pathSegs) urlObj.pathname = pathSegs.join("/");
		out.url = urlObj.toString();
	}
	if (bodyIsJson) out.request_body = JSON.stringify(body);
	return out;
}

function setAtPointer(root: unknown, pointer: string[], value: string): void {
	let node = root as Record<string, unknown> | unknown[];
	for (let i = 0; i < pointer.length - 1; i++) {
		const key = pointer[i];
		node = (Array.isArray(node) ? node[Number(key)] : (node as Record<string, unknown>)[key]) as Record<string, unknown> | unknown[];
		if (node == null || typeof node !== "object") return;
	}
	const last = pointer[pointer.length - 1];
	if (Array.isArray(node)) node[Number(last)] = value;
	else (node as Record<string, unknown>)[last] = value;
}
