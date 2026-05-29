/**
 * covenant-toll-emit — the "settlement ÷ trace" firmament: emit a toll where a
 * charge clears, isolated so it can NEVER break the request path.
 *
 * `settleToll` (covenant-toll-ledger) is the load-bearing settlement: it binds
 * the first discoverer, meters the fair split, and seals the non-repudiable 402
 * event. But settlement is a SIDE-EFFECT of a request — a metering guard, a bad
 * amount, or a signer fault must never propagate up and kill the caller's path.
 * This module is the divide between the firmaments (Gen 1:6-7): the request flows
 * on one side, the toll emission on the other, and the gap between them is sealed.
 *
 * Mirrors `emitExecuteReplayTrace`'s never-throws contract (src/cli-v7/breath/
 * execute.ts): the function surfaces failure through its result shape, never by
 * throwing. A caller wires this in fire-and-observe; a `{ ok: false }` is a noted
 * miss, not an exception to handle. Pure + signer-injected, exactly like the
 * ledger it wraps — the signing key lives in the Privy/TEE wallet, never here.
 */
import { DiscoveryLedger, settleToll, type TollRequest } from "./covenant-toll-ledger.js";
import type { Signer } from "./covenant-seed.js";

/**
 * emitTollEvent — settle one cleared charge against the discovery ledger, NEVER
 * throwing. On success returns the sealed receipt pointer and whether the payer
 * was the route's own first discoverer. On ANY error (metering guard, signer
 * fault, bad input) it returns `{ ok: false, skipped: <short reason> }` so the
 * request path that triggered the charge is never broken by the emission.
 */
export async function emitTollEvent(
	args: {
		agent: string;
		routePtr: string;
		amount: number;
		site: string;
		operator: string;
		operatorBps: number;
		discovererBps: number;
		at: number;
	},
	ledger: DiscoveryLedger,
	sign: Signer,
): Promise<{ ok: true; receipt: string; selfDiscovery: boolean } | { ok: false; skipped: string }> {
	try {
		const req: TollRequest = {
			agent: args.agent,
			routePtr: args.routePtr,
			site: args.site,
			operator: args.operator,
			amount: args.amount,
			operatorBps: args.operatorBps,
			discovererBps: args.discovererBps,
			at: args.at,
		};
		const settlement = await settleToll(ledger, req, sign);
		return { ok: true, receipt: settlement.receipt, selfDiscovery: settlement.selfDiscovery };
	} catch (err) {
		// Absorb every fault — a toll miss is noted, never thrown at the caller.
		const reason = err instanceof Error ? err.message : String(err);
		return { ok: false, skipped: reason };
	}
}
