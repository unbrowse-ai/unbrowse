/**
 * The `verb` node, settled in code: every settled request emits a signed,
 * non-repudiable 402 event, and the FIRST discoverer of a route is paid the
 * shortcut forever (reusers pay it). Real Ed25519, real ledger, no mocks.
 */
import { test, expect, describe } from "bun:test";
import { verifyNode } from "../src/covenant-seed.js";
import { DiscoveryLedger, settleToll, type TollRequest } from "../src/covenant-toll-ledger.js";

async function freshWallet() {
	const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
	const pubHex = [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
	const sign = async (m: Uint8Array) =>
		new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, m));
	return { identity: `wallet:${pubHex}`, sign };
}

function reqOf(over: Partial<TollRequest> & Pick<TollRequest, "agent" | "site" | "operator">): TollRequest {
	return {
		routePtr: "sha256:" + "a".repeat(64),
		amount: 1_000_000,
		operatorBps: 1000, // 10%
		discovererBps: 2000, // 20%
		at: 1_700_000_000_000,
		...over,
	};
}

describe("DiscoveryLedger — first writer wins, forever", () => {
	test("a route's first discoverer is bound immutably; a later agent cannot steal it", () => {
		const ledger = new DiscoveryLedger();
		const route = "sha256:" + "c".repeat(64);
		const first = ledger.recordDiscovery(route, "wallet:" + "1".repeat(64), 100);
		const second = ledger.recordDiscovery(route, "wallet:" + "2".repeat(64), 200);
		expect(first.discoverer).toBe("wallet:" + "1".repeat(64));
		expect(second.discoverer).toBe("wallet:" + "1".repeat(64)); // unchanged — first writer wins
		expect(second.discoveredAt).toBe(100); // provenance preserved
		expect(ledger.discovererOf(route)).toBe("wallet:" + "1".repeat(64));
		expect(ledger.size).toBe(1);
	});
});

describe("settleToll — the signed billable event", () => {
	test("self-discovery: the first toucher is the discoverer; its cut returns to it", async () => {
		const a = await freshWallet();
		const site = "wallet:" + "5".repeat(64);
		const op = "wallet:" + "6".repeat(64);
		const ledger = new DiscoveryLedger();
		const s = await settleToll(ledger, reqOf({ agent: a.identity, site, operator: op }), a.sign);
		expect(s.selfDiscovery).toBe(true);
		const discovererCut = s.payout.find((p) => p.role === "discoverer")!;
		expect(discovererCut.identity).toBe(a.identity); // paid to the payer-as-discoverer
		expect(discovererCut.amount).toBe(200_000); // 20% of 1e6
	});

	test("reuser pays the shortcut: the discoverer cut routes to the ORIGINAL discoverer", async () => {
		const a = await freshWallet(); // first discoverer
		const b = await freshWallet(); // reuser
		const site = "wallet:" + "5".repeat(64);
		const op = "wallet:" + "6".repeat(64);
		const ledger = new DiscoveryLedger();
		const route = "sha256:" + "d".repeat(64);
		await settleToll(ledger, reqOf({ agent: a.identity, site, operator: op, routePtr: route }), a.sign);
		const reuse = await settleToll(ledger, reqOf({ agent: b.identity, site, operator: op, routePtr: route }), b.sign);
		expect(reuse.selfDiscovery).toBe(false); // b is not the discoverer
		const discovererCut = reuse.payout.find((p) => p.role === "discoverer")!;
		expect(discovererCut.identity).toBe(a.identity); // a (original) is paid, not b
		expect(discovererCut.amount).toBe(200_000);
	});

	test("the split sums EXACTLY to amount — no value leaks at the booth", async () => {
		const a = await freshWallet();
		const ledger = new DiscoveryLedger();
		// an amount that does not divide evenly by the bps, to exercise the remainder
		const s = await settleToll(
			ledger,
			reqOf({ agent: a.identity, site: "wallet:" + "5".repeat(64), operator: "wallet:" + "6".repeat(64), amount: 999_999 }),
			a.sign,
		);
		const sum = s.payout.reduce((t, p) => t + p.amount, 0);
		expect(sum).toBe(999_999); // site absorbs the rounding remainder
	});

	test("the sealed event is non-repudiable — verifies through the wallet root", async () => {
		const a = await freshWallet();
		const ledger = new DiscoveryLedger();
		const s = await settleToll(
			ledger,
			reqOf({ agent: a.identity, site: "wallet:" + "5".repeat(64), operator: "wallet:" + "6".repeat(64) }),
			a.sign,
		);
		expect(s.event.kind).toBe("meter:toll");
		expect(s.event.signature).toBeDefined();
		expect(s.receipt).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(await verifyNode(s.event)).toBe(true);
	});

	test("tampering with the payout invalidates the seal", async () => {
		const a = await freshWallet();
		const ledger = new DiscoveryLedger();
		const s = await settleToll(
			ledger,
			reqOf({ agent: a.identity, site: "wallet:" + "5".repeat(64), operator: "wallet:" + "6".repeat(64) }),
			a.sign,
		);
		const tampered = { ...s.event, params: { ...s.event.params, payout: [] } };
		expect(await verifyNode(tampered)).toBe(false);
	});
});
