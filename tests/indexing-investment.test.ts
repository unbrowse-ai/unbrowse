import { expect, test } from "bun:test";
import { planIndexingInvestmentTap, type IndexingContractProposal } from "../src/values/indexing-investment.js";

const proposals: IndexingContractProposal[] = [
  {
    contractId: "contract:route-auth",
    indexer: "alice",
    dimensions: ["route", "auth"],
    requestedAmount: 60,
    proofScore: 1,
    bondedAmount: 100,
  },
  {
    contractId: "contract:security",
    indexer: "bob",
    dimensions: ["security"],
    requestedAmount: 40,
    proofScore: 0.5,
    bondedAmount: 100,
  },
  {
    contractId: "contract:unbonded",
    indexer: "eve",
    dimensions: ["execution"],
    requestedAmount: 100,
    proofScore: 1,
    bondedAmount: 0,
  },
];

test("investment tap allocates only to proof-and-bond eligible indexing contracts", () => {
  const plan = planIndexingInvestmentTap("investor", 100, proposals, { minProofScore: 0.25, minBond: 10 });
  expect(plan.allocated).toBe(100);
  expect(plan.unallocated).toBe(0);
  expect(plan.allocations.map((a) => a.contractId).sort()).toEqual(["contract:route-auth", "contract:security"]);
  expect(plan.allocations.some((a) => a.contractId === "contract:unbonded")).toBe(false);
});

test("funding is conserved exactly and unfilled caps stay unallocated", () => {
  const plan = planIndexingInvestmentTap("investor", 150, proposals.slice(0, 2), { minProofScore: 0, minBond: 0 });
  expect(plan.allocated).toBe(100);
  expect(plan.unallocated).toBe(50);
  expect(plan.allocations.reduce((sum, a) => sum + a.amount, 0)).toBe(plan.allocated);
});

test("dimension weights seed under-covered dimensions without buying rank", () => {
  const plan = planIndexingInvestmentTap("investor", 50, proposals.slice(0, 2), {
    minProofScore: 0,
    minBond: 0,
    dimensionWeights: { security: 10 },
  });
  const security = plan.allocations.find((a) => a.contractId === "contract:security");
  const routeAuth = plan.allocations.find((a) => a.contractId === "contract:route-auth");
  expect(security?.amount).toBeGreaterThan(routeAuth?.amount ?? 0);
  expect(plan.allocations.every((a) => a.rankEffect === "none")).toBe(true);
});

test("empty eligible set leaves the tap untouched", () => {
  const plan = planIndexingInvestmentTap("investor", 25, proposals, { minProofScore: 2, minBond: 10_000 });
  expect(plan).toMatchObject({ allocated: 0, unallocated: 25, allocations: [] });
});
