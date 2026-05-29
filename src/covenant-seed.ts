/**
 * covenant-seed — the minimal internet primitive (UNBROWSE.md, the 10 atoms).
 *
 * The whole of unbrowse, reduced to "only the required level of primitives to
 * expose the internet to an agent." Composes the existing covenant surface
 * (COVENANT_MAP is the load-bearing map; this is its consumer) rather than
 * re-implementing it. The signing key is NEVER held here — it lives in the
 * Privy/TEE wallet (the root atom); the seed only takes an injected `Signer`.
 *
 * Atoms, by export:
 *   root   → identityToPubHex (the wallet identity nothing re-proves)
 *   node   → CovenantNode (six interrogatives)
 *   verb   → verbOfKind / verbOfTool (build/breath/eval, the three-verb river)
 *   seal   → sealNode / verifyNode (Ed25519 through the root + cross-wallet guard)
 *   cache  → receiptPtr (content-addressed memoize) + stateKey (identity-keyed tree)
 *   verb (fetch ladder) → pickFetchRung (curl-impersonate first, kuri last — the rip-out)
 *   toll   → meter / tollNode (the 402 event: fair split that never leaks at the booth)
 *
 * walk/resolve + discovery already live in src/execution + backend discovery; the
 * seed points to them, it does not duplicate them (Konmari).
 *
 * Mechanism-compatible with backend/src/services/covenant-core.ts: insertion-order
 * JSON → sha256 → `sha256:` pointer (NOT sorted-key — would break covenant-binary
 * byte-compat). Web Crypto only, zero external deps.
 */
import { COVENANT_MAP, type CovenantVerb } from "./covenant-mapping.js";

// ─── node (what): the six-interrogative envelope ────────────────────────────
export interface CovenantNode {
	/** what — `base:action`, e.g. "actuate:navigate" / "observe:snap" / "build:skill". */
	kind: string;
	/** what/where — operation params (target url, fields, …). */
	params: Record<string, unknown>;
	/** who — `wallet:<hex>` | `did:key:hex:<hex>` | bare 64-char hex pubkey. */
	identity: string;
	/** why — scripture/intent anchor (optional). */
	witness?: string;
	/** how (seal) — Ed25519 hex over the canonical body; absent until sealed. */
	signature?: string;
}

// ─── verb (how): the three-verb river — classify, never branch on tool name ──
const VERB_BY_BASE: Record<string, CovenantVerb> = {
	build: "build", // declare / commit a persistent claim (Father)
	meter: "build", // toll: commit a billable claim — the 402 event (Father)
	actuate: "breath", // route / act on the web (Spirit)
	observe: "eval", // read-only query (Son)
};

/** verb of a `base:action` kind. Unknown base → breath (the routing default). */
export function verbOfKind(kind: string): CovenantVerb {
	return VERB_BY_BASE[kind.split(":")[0] ?? ""] ?? "breath";
}

/** verb of a declared MCP tool, straight from the one map. */
export function verbOfTool(toolName: string): CovenantVerb | undefined {
	return COVENANT_MAP[toolName]?.verb;
}

// ─── root (who): the wallet identity nothing above re-proves ─────────────────
/** Parse any accepted identity form to its 64-char hex pubkey, or null. */
export function identityToPubHex(identity: string): string | null {
	let hex = identity;
	if (hex.startsWith("wallet:")) hex = hex.slice("wallet:".length);
	else if (hex.startsWith("did:key:hex:")) hex = hex.slice("did:key:hex:".length);
	hex = hex.toLowerCase();
	return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

// ─── cache (when): content-addressed memoize + identity-keyed state tree ─────
/** Insertion-order canonical body (signature excluded — it signs THIS). */
function canonicalBody(node: CovenantNode): string {
	return JSON.stringify({
		kind: node.kind,
		params: node.params,
		witness: node.witness ?? null,
		identity: node.identity,
	});
}

async function sha256Hex(s: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return bytesToHex(new Uint8Array(hash));
}

/** MEMOIZE: the `sha256:`-prefixed content address of a node (covenant receipt ptr). */
export async function receiptPtr(node: CovenantNode): Promise<string> {
	return `sha256:${await sha256Hex(canonicalBody(node))}`;
}

/**
 * The identity-keyed state tree key. cookies / storage / env / dag are all leaf
 * nodes of one tree, owned by the wallet — NOT by Chromium's profile.
 *   stateKey("wallet:ab…", "env", "openai", "OPENAI_API_KEY")
 *     → "state:wallet:ab…/env/openai/OPENAI_API_KEY"
 */
export function stateKey(identity: string, ...path: string[]): string {
	const wallet = identity.startsWith("wallet:") ? identity : `wallet:${identity}`;
	return [`state:${wallet}`, ...path].join("/");
}

// ─── seal (how): self-verify through the wallet root ─────────────────────────
function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}
function bytesToHex(b: Uint8Array): string {
	let hex = "";
	for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, "0");
	return hex;
}

/** A signer is INJECTED (Privy delegated action / TEE) — the seed never holds the key. */
export type Signer = (message: Uint8Array) => Promise<Uint8Array>;

/** Seal a node: sign its canonical body with the wallet root. */
export async function sealNode(
	node: CovenantNode,
	identity: string,
	sign: Signer,
): Promise<CovenantNode> {
	const sealed: CovenantNode = { ...node, identity };
	const sig = await sign(new TextEncoder().encode(canonicalBody(sealed)));
	sealed.signature = bytesToHex(sig);
	return sealed;
}

/**
 * Verify a node self-seals through its root. Two witnesses must agree (Deut
 * 19:15): the Ed25519 signature AND the body-bound `params.walletPubkey` (if
 * present) must both match the signing identity. Returns false, never throws.
 */
export async function verifyNode(node: CovenantNode): Promise<boolean> {
	try {
		if (!node.signature) return false;
		const pubHex = identityToPubHex(node.identity);
		if (!pubHex) return false;
		const bound = node.params?.["walletPubkey"];
		if (typeof bound === "string" && bound.toLowerCase() !== pubHex) return false; // cross-wallet guard
		const pub = hexToBytes(pubHex);
		const sig = hexToBytes(node.signature);
		if (pub.length !== 32 || sig.length !== 64) return false;
		const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
		return await crypto.subtle.verify(
			{ name: "Ed25519" },
			key,
			sig,
			new TextEncoder().encode(canonicalBody(node)),
		);
	} catch {
		return false;
	}
}

// ─── verb (fetch ladder): the kuri/Chromium rip-out, as routing ──────────────
export type FetchRung = 0 | 1 | 2;

/** What the capture layer observed that decides how heavy a fetch must be. */
export interface CaptureSignal {
	/** page needs JS execution to yield data. */
	jsChallenge?: boolean;
	/** a Cloudflare Turnstile / interstitial widget is present. */
	turnstile?: boolean;
	/** genuine interactive automation (multi-step click/fill) required. */
	interactive?: boolean;
	/** deep network/HAR capture required. */
	needsHar?: boolean;
}

/**
 * Pick the minimal fetch rung — Chromium is the LAST resort, not the substrate:
 *   0 — Scrapling `Fetcher` (curl_cffi TLS impersonation, NO browser) — default
 *   1 — Scrapling `StealthyFetcher` (Patchright/Chromium, solve_cloudflare) — JS/Turnstile
 *   2 — full CDP / kuri — only when interactive automation or deep HAR is unavoidable
 */
export function pickFetchRung(s: CaptureSignal): FetchRung {
	if (s.interactive || s.needsHar) return 2;
	if (s.jsChallenge || s.turnstile) return 1;
	return 0;
}

// ─── toll (the 402 booth): meter a settled request, pay the first discoverer ──
// The 402 event as one covenant node of kind `meter:toll`, sealable through the
// root (sealNode) so the charge is non-repudiable. Fair game theory: the agent
// pays once; the split is fixed in basis points and the SITE absorbs the rounding
// remainder, so payouts sum EXACTLY to the amount — no value leaks at the booth.
export interface TollSplit {
	/** what the paying agent owes for this settled request, in atomic units (e.g. USDC 1e-6). */
	amount: number;
	/** the toll booth's operating cut, in basis points of amount (0–10000). */
	operatorBps: number;
	/** the first-discoverer reward, in basis points — the reuser pays the shortcut. */
	discovererBps: number;
}

export interface TollParty {
	identity: string;
	amount: number;
	role: "site" | "operator" | "discoverer";
}

/**
 * meter — split one settled request fairly. operator + discoverer take their
 * basis-point cuts (floored); the SITE takes the remainder, so `sum(payouts) ===
 * amount` exactly with zero rounding leak. Throws on a bad amount or bps.
 */
export function meter(
	split: TollSplit,
	parties: { site: string; operator: string; discoverer: string },
): TollParty[] {
	const { amount, operatorBps, discovererBps } = split;
	if (!Number.isInteger(amount) || amount < 0) throw new Error(`toll amount must be a non-negative integer: ${amount}`);
	if (operatorBps < 0 || discovererBps < 0 || operatorBps + discovererBps > 10_000)
		throw new Error(`toll bps out of range: operator=${operatorBps} discoverer=${discovererBps}`);
	const operatorCut = Math.floor((amount * operatorBps) / 10_000);
	const discovererCut = Math.floor((amount * discovererBps) / 10_000);
	const siteCut = amount - operatorCut - discovererCut; // remainder → site, never lost
	return [
		{ identity: parties.site, amount: siteCut, role: "site" },
		{ identity: parties.operator, amount: operatorCut, role: "operator" },
		{ identity: parties.discoverer, amount: discovererCut, role: "discoverer" },
	];
}

/**
 * tollNode — the 402 event as a sealable covenant node. `who` = the paying agent;
 * params carry the route receipt pointer it settles against and the resolved fair
 * payout. Seal it through the root (sealNode) to make the charge non-repudiable.
 */
export function tollNode(
	agent: string,
	routePtr: string,
	split: TollSplit,
	parties: { site: string; operator: string; discoverer: string },
): CovenantNode {
	return {
		kind: "meter:toll",
		params: { routePtr, split, payout: meter(split, parties) },
		identity: agent,
		witness: "Luke 10:7 — the laborer is worthy of his wages",
	};
}
