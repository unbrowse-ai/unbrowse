/**
 * composite-dag-integration.test — the END-TO-END wiring witness for the composite ledger.
 *
 * The unit witnesses (composite-persist.test) prove the persist/replay decision logic in isolation.
 * This proves the wiring FIRES from real skill metadata: a skill whose endpoints carry semantic
 * requires/provides produces, through the REAL local DAG planner, a prerequisite order — which then
 * drives the composite emission and, on a second resolve, a composite_replay. No network, no mocks:
 * the planner is pure over the operation graph the capture layer populates.
 *
 *   search   --provides--> story_id
 *   get_item --requires--> story_id   (target; url needs {story_id})
 *
 * So to resolve get_item the chain MUST run search first — exactly the order a composite records.
 */
import { describe, expect, it } from "bun:test";
import { fetchDagAdvisoryPlan } from "../src/lib/graph-core/planner.js";
import {
  buildCompositeEdges,
  compositeAddress,
  planPrereqOrder,
  type ChainStepInfo,
} from "../src/orchestrator/index.js";
import type { SkillManifest } from "../src/types/index.js";

const skill = {
  skill_id: "sk_hn",
  version: "1.0.0",
  schema_version: "1",
  name: "news.ycombinator.com",
  intent_signature: "news.ycombinator.com",
  domain: "news.ycombinator.com",
  description: "HN",
  owner_type: "agent",
  execution_type: "http",
  lifecycle: "active",
  created_at: "2026-06-14T00:00:00.000Z",
  updated_at: "2026-06-14T00:00:00.000Z",
  endpoints: [
    {
      endpoint_id: "search",
      method: "GET",
      url_template: "https://news.ycombinator.com/topstories.json",
      semantic: { provides: [{ key: "story_id" }], requires: [] },
    },
    {
      endpoint_id: "get_item",
      method: "GET",
      url_template: "https://news.ycombinator.com/item/{story_id}.json",
      semantic: { requires: [{ key: "story_id" }], provides: [{ key: "title" }] },
    },
  ],
} as unknown as SkillManifest;

describe("composite ledger — end-to-end wiring from real semantic metadata", () => {
  it("the REAL local DAG planner derives the prerequisite order (search before get_item)", () => {
    // target get_item needs story_id, which it cannot bind from the intent (knownBindingKeys empty)
    const plan = fetchDagAdvisoryPlan(skill, "get_item", []);
    expect(plan.prerequisite_order).toContain("search");
    expect(plan.prerequisite_order).not.toContain("get_item");
  });

  it("run 1 (walk) → composite emits; run 2 (same skill) → composite_replay", () => {
    // RUN 1 — no composite yet: planner order drives the walk
    const plan = fetchDagAdvisoryPlan(skill, "get_item", []);
    const firstDecision = planPrereqOrder(plan.prerequisite_order, undefined, () => true);
    expect(firstDecision.replayedCompositeId).toBeUndefined(); // first run walks, doesn't replay
    expect(firstDecision.prereqOrder).toContain("search");

    // the walk yields story_id from search and threads it into get_item — record the composite
    const steps: ChainStepInfo[] = [{ endpoint_id: "search", ok: true, yielded: ["story_id"] }];
    const edges = buildCompositeEdges("get_item", steps, ["story_id"]);
    expect(edges).toEqual([{ from: "search", binding: "story_id", to: "get_item" }]);
    const composite = {
      composite_id: compositeAddress(skill.domain, "get_item", steps, edges),
      domain: skill.domain,
      target: "get_item",
      steps,
      edges,
    };

    // RUN 2 — the composite is present (attached to the skill / persisted): replay fires
    const secondDecision = planPrereqOrder(plan.prerequisite_order, composite, () => true);
    expect(secondDecision.replayedCompositeId).toBe(composite.composite_id);
    expect(secondDecision.prereqOrder).toEqual(["search"]);
  });

  it("a target with no unmet requires yields no prerequisite walk (no spurious composite)", () => {
    // resolving search itself needs nothing → empty prerequisite order → no composite
    const plan = fetchDagAdvisoryPlan(skill, "search", []);
    expect(plan.prerequisite_order).toEqual([]);
    const decision = planPrereqOrder(plan.prerequisite_order, undefined, () => true);
    expect(decision.prereqOrder).toEqual([]);
    expect(decision.replayedCompositeId).toBeUndefined();
  });
});
