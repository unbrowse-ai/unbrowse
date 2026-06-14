/**
 * cross-skill-producer-index.test — the global provides→requires join across skills.
 *
 * A consumer's hole that NO endpoint in its own skill provides resolves to a producer
 * endpoint in ANOTHER skill, matched by semantic identity (post::id), with no
 * cross-resource bleed (a comment hole never matches a post producer).
 */
import { describe, expect, it } from "bun:test";
import {
  buildGlobalProducerIndex,
  resolveProducersForHole,
  bindingIdentityKey,
} from "../src/lib/graph-core/cross-skill-index.js";
import type { SkillManifest } from "../src/types/skill.js";

function skill(skill_id: string, endpoints: any[]): SkillManifest {
  return { skill_id, endpoints } as unknown as SkillManifest;
}
const produces = (key: string, resource_kind: string) => ({
  endpoint_id: `ep_${resource_kind}_create`,
  method: "POST",
  url_template: `https://x/${resource_kind}s`,
  semantic: { action_kind: "write", resource_kind, provides: [{ key, source: "response", semantic_type: "resource_id" }] },
});

const blog = skill("blog", [produces("id", "post")]); // a post write yields {id}
const comments = skill("comments", [
  { endpoint_id: "add_comment", method: "POST", url_template: "https://x/comments", semantic: { action_kind: "write", resource_kind: "comment", requires: [{ key: "postId", required: true, source: "body" }] } },
]);
const orders = skill("orders", [produces("id", "order")]);

describe("bindingIdentityKey", () => {
  it("normalizes entity-prefixed ids and resource-scoped bare ids", () => {
    expect(bindingIdentityKey("postId")).toBe("post::id");
    expect(bindingIdentityKey("post_id")).toBe("post::id");
    expect(bindingIdentityKey("id", "post")).toBe("post::id");
    expect(bindingIdentityKey("commentId")).toBe("comment::id");
    expect(bindingIdentityKey("slug", "post")).toBe("post::slug");
    expect(bindingIdentityKey("repoId")).toBe("repository::id"); // alias
    expect(bindingIdentityKey("email")).toBe("::email"); // no entity
  });
});

describe("buildGlobalProducerIndex + resolveProducersForHole", () => {
  const index = buildGlobalProducerIndex([blog, comments, orders]);

  it("resolves a hole to a producer in a DIFFERENT skill (post::id)", () => {
    const hole = { key: "postId", required: true, source: "body" };
    const producers = resolveProducersForHole(index, hole, "comment", { excludeSkillId: "comments" });
    expect(producers.length).toBe(1);
    expect(producers[0].skill_id).toBe("blog");
    expect(producers[0].endpoint_id).toBe("ep_post_create");
    expect(producers[0].identity).toBe("post::id");
  });

  it("no cross-resource bleed: a comment hole does NOT match a post producer", () => {
    const hole = { key: "commentId", required: true, source: "body" };
    expect(resolveProducersForHole(index, hole, "x", { excludeSkillId: "z" })).toEqual([]);
  });

  it("a hole with no producer anywhere returns nothing", () => {
    const hole = { key: "invoiceId", required: true, source: "body" };
    expect(resolveProducersForHole(index, hole)).toEqual([]);
  });

  it("excludes the consumer's own skill (cross-skill discovery)", () => {
    // a skill that BOTH provides and consumes post::id
    const both = skill("both", [
      produces("id", "post"),
      { endpoint_id: "needs_post", method: "POST", url_template: "https://x/y", semantic: { action_kind: "write", resource_kind: "thing", requires: [{ key: "postId", source: "body" }] } },
    ]);
    const idx = buildGlobalProducerIndex([both]);
    const hole = { key: "postId", source: "body" };
    expect(resolveProducersForHole(idx, hole, "thing", { excludeSkillId: "both" })).toEqual([]);
    expect(resolveProducersForHole(idx, hole, "thing", { includeSameSkill: true }).length).toBe(1);
  });

  it("a resource-scoped bare id resolves cross-skill (order::id)", () => {
    const hole = { key: "orderId", source: "body" };
    const producers = resolveProducersForHole(index, hole, "lineitem", { excludeSkillId: "lineitem" });
    expect(producers.map((p) => p.skill_id)).toEqual(["orders"]);
  });
});
