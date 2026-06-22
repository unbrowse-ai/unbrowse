// lineage-manifest.test.ts — the foundation stone toward live settlement (mainnet or dev):
// a SkillManifest's DECLARED lineage (source_routes) is exactly the shape splitLineage consumes,
// and it flows through to PAY the upstream maintainers (2 Kings 12:11 / Job 34:11). Pure +
// hermetic — no funds, no network. This proves the lineage DATA the payout needs exists on the
// manifest and feeds the split; wiring it into the live custodial disburse plan (disburse.ts,
// DRY-RUN, gated behind DISBURSE_ENABLED) is the next stone, and the live mainnet payout itself
// awaits a funded wallet + that gate (it is not, and must not be, asserted green here).

import { test, expect } from "bun:test";
import { splitLineage, type TollSplit } from "../src/covenant-seed.js";
import type { SkillManifest } from "../backend/src/types.js";

// Compile-time witness: the manifest's lineage type IS what splitLineage takes. If source_routes
// drifts from { routePtr, maintainer }, this annotation fails to typecheck (bun build / tsc).
const sourceRoutes: NonNullable<SkillManifest["source_routes"]> = [
	{ routePtr: "routeB", maintainer: "MAINT_B" },
	{ routePtr: "routeC", maintainer: "MAINT_C" },
];

const parties = { site: "SITE", operator: "OP", discoverer: "DISC" };

test("a manifest's source_routes lineage flows through splitLineage to pay the maintainers (sum exact)", () => {
	const split: TollSplit = { amount: 1_000_000, operatorBps: 1000, discovererBps: 500 };
	const payout = splitLineage(split, parties, sourceRoutes, 2000); // 20% maintainer pool, shared B+C
	expect(payout.reduce((s, p) => s + p.amount, 0)).toBe(1_000_000); // zero leak — site absorbs remainder
	const paid = payout.filter((p) => p.role === "maintainer").map((p) => p.identity).sort();
	expect(paid).toEqual(["MAINT_B", "MAINT_C"]); // BOTH upstream maintainers are paid up the chain
	expect(payout.find((p) => p.identity === "MAINT_B")!.amount).toBe(100_000); // 20% / 2 hops
});

test("a manifest with no source_routes pays no lineage (reduces to the base split — backwards-compatible)", () => {
	const empty: NonNullable<SkillManifest["source_routes"]> = [];
	const split: TollSplit = { amount: 500_000, operatorBps: 1000, discovererBps: 0 };
	const payout = splitLineage(split, parties, empty, 0);
	expect(payout.some((p) => p.role === "maintainer")).toBe(false);
	expect(payout.reduce((s, p) => s + p.amount, 0)).toBe(500_000);
});
