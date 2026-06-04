/**
 * The "settlement ÷ trace" boundary, settled in code: emitting a toll where a
 * charge clears NEVER breaks the request path. The happy path returns a sealed
 * receipt and binds the first discoverer; every guard fault is absorbed into a
 * `{ ok: false }` and never thrown. Real Ed25519, real ledger, no mocks.
 */
import { test, expect, describe } from "bun:test";
import { DiscoveryLedger } from "../src/route-toll-ledger.js";
import { emitTollEvent } from "../src/route-toll-emit.js";

async function freshWallet() {
	const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
	const pubHex = [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
	const sign = async (m: Uint8Array) =>
		new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, m));
	return { identity: `wallet:${pubHex}`, sign };
}

const SITE = "wallet:" + "5".repeat(64);
const OP = "wallet:" + "6".repeat(64);

function argsOf(over: {
	agent: string;
	routePtr?: string;
	amount?: number;
	operatorBps?: number;
	discovererBps?: number;
}) {
	return {
		agent: over.agent,
		routePtr: over.routePtr ?? "sha256:" + "a".repeat(64),
		amount: over.amount ?? 1_000_000,
		site: SITE,
		operator: OP,
		operatorBps: over.operatorBps ?? 1000, // 10%
		discovererBps: over.discovererBps ?? 2000, // 20%
		at: 1_700_000_000_000,
	};
}

describe("emitTollEvent — never-throws toll emission", () => {
	test("happy path → ok, sha256 receipt, and the bound discoverer wins on reuse", async () => {
		const a = await freshWallet(); // first discoverer
		const b = await freshWallet(); // reuser
		const ledger = new DiscoveryLedger();
		const route = "sha256:" + "d".repeat(64);

		const first = await emitTollEvent(argsOf({ agent: a.identity, routePtr: route }), ledger, a.sign);
		expect(first.ok).toBe(true);
		if (first.ok) {
			expect(first.receipt).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(first.selfDiscovery).toBe(true); // a touched first
		}

		const reuse = await emitTollEvent(argsOf({ agent: b.identity, routePtr: route }), ledger, b.sign);
		expect(reuse.ok).toBe(true);
		if (reuse.ok) {
			expect(reuse.selfDiscovery).toBe(false); // b is not the discoverer
		}
		// the binding is immutable — a (original) still owns the route
		expect(ledger.discovererOf(route)).toBe(a.identity);
	});

	test("a negative amount → ok:false skipped, and DID NOT THROW", async () => {
		const a = await freshWallet();
		const ledger = new DiscoveryLedger();
		let result: Awaited<ReturnType<typeof emitTollEvent>> | undefined;
		const call = async () => {
			result = await emitTollEvent(argsOf({ agent: a.identity, amount: -1 }), ledger, a.sign);
		};
		await expect(call()).resolves.toBeUndefined(); // never throws
		expect(result?.ok).toBe(false);
		if (result && !result.ok) expect(result.skipped).toContain("amount");
	});

	test("operatorBps + discovererBps > 10000 → ok:false (meter guard absorbed, never thrown)", async () => {
		const a = await freshWallet();
		const ledger = new DiscoveryLedger();
		let result: Awaited<ReturnType<typeof emitTollEvent>> | undefined;
		const call = async () => {
			result = await emitTollEvent(
				argsOf({ agent: a.identity, operatorBps: 6000, discovererBps: 5000 }), // sums to 11000
				ledger,
				a.sign,
			);
		};
		await expect(call()).resolves.toBeUndefined(); // never throws
		expect(result?.ok).toBe(false);
		if (result && !result.ok) expect(result.skipped).toContain("bps");
	});
});
