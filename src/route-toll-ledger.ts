/**
 * route-toll-ledger — the first-discoverer ledger for the 402 booth.
 *
 * `meter()` / `tollNode()` (route-seed) split ONE settled request fairly.
 * This module adds the missing half of the `verb` node: WHO is owed the
 * discoverer cut. A route's FIRST discoverer is bound immutably; every later
 * reuser pays the shortcut and that original discoverer is paid — ,
 * "the laborer is worthy of his wages." The booth never re-picks a winner.
 *
 * Fair game theory (no rent-seeking, no double-charge):
 *   - first writer wins the route binding, FOREVER — a later agent cannot
 *     steal the shortcut reward by re-discovering an already-known route;
 *   - when the payer IS the first discoverer, the discoverer cut returns to
 *     the payer (no shortcut is owed to anyone else — `selfDiscovery`);
 *   - when a reuser pays, the discoverer cut routes to the ORIGINAL discoverer;
 *   - the split always sums EXACTLY to `amount` (meter's site-absorbs-remainder
 *     invariant) — no value leaks at the booth.
 *
 * Pure + signer-injected, exactly like route-seed: the signing key lives in
 * the Privy/TEE wallet (the root atom), never here. Web Crypto only.
 */
// cross: sha256:b35fea21e179afd6de983a90f4c1575527619b2d0143edd7d31b0dd70d8a97f5  (the route code inherits the root signature — pointer not payload; verify via (internal))
import {
	meter,
	tollNode,
	sealNode,
	receiptPtr,
	type TollSplit,
	type TollParty,
	type RouteNode,
	type Signer,
} from "./route-seed.js";

/** Immutable route→first-discoverer binding. First writer wins, forever. */
export interface RouteDiscovery {
	/** content-addressed pointer to the route the toll settles against. */
	routePtr: string;
	/** wallet identity of the FIRST agent to discover this route. */
	discoverer: string;
	/** ms-epoch of first discovery — provenance only, never used in payout math. */
	discoveredAt: number;
}

/**
 * DiscoveryLedger — routePtr → first discoverer. `recordDiscovery` is
 * idempotent on the route: the first discoverer is bound and NEVER overwritten,
 * so a later agent cannot steal the shortcut reward (the core fairness
 * invariant). In-memory by design; the durable copy is the sealed receipt
 * stream (each `settleToll` returns a content-addressed, signed event).
 */
export class DiscoveryLedger {
	private readonly byRoute = new Map<string, RouteDiscovery>();

	/**
	 * Bind the first discoverer of a route. First writer wins — a route already
	 * bound returns its existing binding unchanged. Returns the effective binding.
	 */
	recordDiscovery(routePtr: string, discoverer: string, at: number): RouteDiscovery {
		const existing = this.byRoute.get(routePtr);
		if (existing) return existing; // immutable: the first discoverer is paid forever
		const binding: RouteDiscovery = { routePtr, discoverer, discoveredAt: at };
		this.byRoute.set(routePtr, binding);
		return binding;
	}

	/** The first discoverer of a route, or undefined if never discovered. */
	discovererOf(routePtr: string): string | undefined {
		return this.byRoute.get(routePtr)?.discoverer;
	}

	/** Number of distinct routes bound — the ledger's discovered surface. */
	get size(): number {
		return this.byRoute.size;
	}
}

/** One settled 402 charge: the sealed event plus the resolved fair split. */
export interface TollSettlement {
	/** the sealed, non-repudiable 402 event for this settled request. */
	event: RouteNode;
	/** content address of the sealed event — the durable ledger row id. */
	receipt: string;
	/** the fair payout split (sums EXACTLY to `amount`). */
	payout: TollParty[];
	/** true when the paying agent IS the route's first discoverer (no shortcut owed). */
	selfDiscovery: boolean;
}

/** A billable request arriving at the booth, before the discoverer is resolved. */
export interface TollRequest {
	/** the paying agent's wallet identity. */
	agent: string;
	/** content-addressed pointer to the route being settled. */
	routePtr: string;
	/** the site that owns the resource (takes the remainder). */
	site: string;
	/** the toll booth operator. */
	operator: string;
	/** what the agent owes, in atomic units (integer, e.g. USDC 1e-6). */
	amount: number;
	/** operator cut, basis points of amount. */
	operatorBps: number;
	/** first-discoverer reward, basis points of amount. */
	discovererBps: number;
	/** ms-epoch of this settlement (provenance for a first-touch binding). */
	at: number;
}

/**
 * settleToll — settle one paid request against the discovery ledger.
 *
 *   1. resolve the route's FIRST discoverer (binding the paying agent now if
 *      this is the first touch);
 *   2. meter the fair split through `tollNode` (operator + discoverer bps;
 *      site absorbs the rounding remainder so payouts sum exactly to `amount`);
 *   3. seal the 402 event through the wallet root so the charge — and the
 *      payout bound into its body — is non-repudiable.
 *
 * Throws only via `meter`'s guards (bad amount / bps out of range).
 */
export async function settleToll(
	ledger: DiscoveryLedger,
	req: TollRequest,
	sign: Signer,
): Promise<TollSettlement> {
	const binding = ledger.recordDiscovery(req.routePtr, req.agent, req.at);
	const discoverer = binding.discoverer;
	const selfDiscovery = discoverer === req.agent;
	const split: TollSplit = {
		amount: req.amount,
		operatorBps: req.operatorBps,
		discovererBps: req.discovererBps,
	};
	const node = tollNode(req.agent, req.routePtr, split, {
		site: req.site,
		operator: req.operator,
		discoverer,
	});
	const event = await sealNode(node, req.agent, sign);
	const receipt = await receiptPtr(event);
	return { event, receipt, payout: meter(split, { site: req.site, operator: req.operator, discoverer }), selfDiscovery };
}
