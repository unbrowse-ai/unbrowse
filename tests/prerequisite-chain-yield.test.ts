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
