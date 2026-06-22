// lineage-split.test.ts — the agent-economy clearing keystone: splitLineage weighs
// one settled 402 out to the route's MAINTENANCE LINEAGE (compensate up the chain —
// 2 Kings 12:11 "paid it out to those who did the work"; Job 34:11 "render to a man
// according to his work"), while preserving meter's zero-leak invariant (sum === amount,
// site absorbs the remainder). Pure functions — hermetic, no network, no Signer, no funds.

import { test, expect } from "bun:test";
import { splitLineage, meter, type LineageHop, type TollSplit } from "../src/covenant-seed.js";

const parties = { site: "SITE", operator: "OP", discoverer: "DISC" };

test("splitLineage weighs out to the lineage maintainers + sum === amount (zero leak)", () => {
	const split: TollSplit = { amount: 1_000_000, operatorBps: 1000, discovererBps: 500 }; // 10% op, 5% disc
	const lineage: LineageHop[] = [
		{ routePtr: "routeB", maintainer: "MAINT_B" },
		{ routePtr: "routeC", maintainer: "MAINT_C" },
	];
	const payout = splitLineage(split, parties, lineage, 2000); // 20% maintainer pool, shared B+C
	expect(payout.reduce((s, p) => s + p.amount, 0)).toBe(1_000_000); // EXACT — site absorbs remainder
	const b = payout.find((p) => p.identity === "MAINT_B")!;
	const c = payout.find((p) => p.identity === "MAINT_C")!;
	expect(b.role).toBe("maintainer");
	expect(b.amount).toBe(100_000); // 20% / 2 hops = 10% each
	expect(c.amount).toBe(100_000);
	expect(payout.find((p) => p.role === "operator")!.amount).toBe(100_000); // 10%
	expect(payout.find((p) => p.role === "discoverer")!.amount).toBe(50_000); // 5%
	expect(payout.find((p) => p.role === "site")!.amount).toBe(650_000); // the remainder
});

test("splitLineage with empty lineage reduces EXACTLY to meter (backwards-compatible)", () => {
	const split: TollSplit = { amount: 777_777, operatorBps: 1234, discovererBps: 567 };
	const viaLineage = splitLineage(split, parties, [], 0).filter((p) => p.role !== "maintainer");
	const viaMeter = meter(split, parties);
	expect(viaLineage).toEqual(viaMeter); // same three parties, same amounts
});

test("splitLineage dedupes a maintainer (one wallet → one share) + skips the discoverer; odd amount never leaks", () => {
	const split: TollSplit = { amount: 1_000_003, operatorBps: 333, discovererBps: 333 };
	const lineage: LineageHop[] = [
		{ routePtr: "r1", maintainer: "M" },
		{ routePtr: "r2", maintainer: "M" }, // same wallet twice → ONE share
		{ routePtr: "r3", maintainer: "DISC" }, // the discoverer → already paid, skipped
		{ routePtr: "r4", maintainer: "M2" },
	];
	const payout = splitLineage(split, parties, lineage, 3000);
	const maint = payout.filter((p) => p.role === "maintainer").map((p) => p.identity).sort();
	expect(maint).toEqual(["M", "M2"]); // deduped + discoverer skipped
	expect(payout.reduce((s, p) => s + p.amount, 0)).toBe(1_000_003); // odd amount → site absorbs, still EXACT
});

test("splitLineage rejects bps that overflow 10000 (the booth never over-allocates)", () => {
	const split: TollSplit = { amount: 100, operatorBps: 6000, discovererBps: 3000 };
	expect(() => splitLineage(split, parties, [{ routePtr: "x", maintainer: "Z" }], 2000)).toThrow(); // 60+30+20 > 100%
});

test("splitLineage with lineage but a maintainerBps of 0 pays the maintainers nothing (no pool, no leak)", () => {
	const split: TollSplit = { amount: 500_000, operatorBps: 1000, discovererBps: 0 };
	const payout = splitLineage(split, parties, [{ routePtr: "rB", maintainer: "MAINT_B" }], 0);
	expect(payout.find((p) => p.identity === "MAINT_B")!.amount).toBe(0); // no pool → 0
	expect(payout.reduce((s, p) => s + p.amount, 0)).toBe(500_000); // still EXACT
});
