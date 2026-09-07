/**
 * prerequisite-chain-yield.test — the threading core of the runtime DAG-recompute (the
 * "do things in the right order" chain-walker in src/orchestrator/index.ts).
 *
 * When a target endpoint needs a binding it can't bind from the intent, the walker runs a
 * prerequisite endpoint that YIELDS that binding and threads the real value forward. The
 * load-bearing mechanism is extractBindingsFromJson: it must pull the yielded binding key's
 * value out of the prerequisite's result so the target gets a true value, not an LLM guess.
 */
import { describe, expect, it } from "bun:test";
import { extractBindingsFromJson } from "../src/lib/graph-core/session.js";
import { buildCompositeEdges, type ChainStepInfo } from "../src/orchestrator/index.js";
import type { OperationBinding } from "../src/types/index.js";

const b = (key: string): OperationBinding => ({ key }) as OperationBinding;

describe("prerequisite yield extraction (chain-walker threading)", () => {
  it("threads a scalar yield from a top-level key", () => {
    // prerequisite result: a story object that PROVIDES { id, title }
    const result = JSON.stringify({ id: 48517377, title: "Census Bureau", by: "nl" });
    const yielded = extractBindingsFromJson(result, [b("id"), b("title")]);
    expect(yielded.id).toBe(48517377);
    expect(yielded.title).toBe("Census Bureau");
  });

  it("threads a yield nested one level deep", () => {
    const result = JSON.stringify({ data: { session_token: "tok_abc", user_id: "u_42" } });
    const yielded = extractBindingsFromJson(result, [b("session_token"), b("user_id")]);
    expect(yielded.session_token).toBe("tok_abc");
    expect(yielded.user_id).toBe("u_42");
  });

  it("threads a yield key found in an array-of-objects result", () => {
    const result = JSON.stringify({ items: [{ id: "first", name: "a" }, { id: "second" }] });
    const yielded = extractBindingsFromJson(result, [b("id")]);
    // walker coerces an array/object yield to its first scalar at the call site; here we assert
    // the key is located in the array-item shape.
    expect(yielded.id).toBeDefined();
  });

  it("yields nothing when the prerequisite result lacks the required key (walker falls back)", () => {
    const result = JSON.stringify({ unrelated: "value" });
    const yielded = extractBindingsFromJson(result, [b("id")]);
    expect(yielded.id).toBeUndefined();
    expect(Object.keys(yielded)).toHaveLength(0);
  });

  it("is safe on a non-JSON / empty prerequisite result (no throw, no binding)", () => {
    expect(extractBindingsFromJson("not json", [b("id")])).toEqual({});
    expect(extractBindingsFromJson(undefined, [b("id")])).toEqual({});
  });
});

describe("composite edges (the walked contract sub-DAG)", () => {
  const steps: ChainStepInfo[] = [
    { endpoint_id: "search", ok: true, yielded: ["story_id"] },
    { endpoint_id: "get_item", ok: true, yielded: ["author"] },
  ];

  it("maps each resolved binding back to the prerequisite that yielded it", () => {
    const edges = buildCompositeEdges("get_comments", steps, ["story_id"]);
    expect(edges).toEqual([{ from: "search", binding: "story_id", to: "get_comments" }]);
  });

  it("builds one edge per bound key, each pointing at the target", () => {
    const edges = buildCompositeEdges("target", steps, ["story_id", "author"]);
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.to === "target")).toBe(true);
    expect(edges.map((e) => e.from).sort()).toEqual(["get_item", "search"]);
  });

  it("drops bindings no step yielded (the chain couldn't satisfy them)", () => {
    const edges = buildCompositeEdges("target", steps, ["story_id", "unyielded_key"]);
    expect(edges).toHaveLength(1);
    expect(edges[0].binding).toBe("story_id");
  });

  it("returns no edges for an empty chain", () => {
    expect(buildCompositeEdges("target", [], ["x"])).toEqual([]);
  });
});
