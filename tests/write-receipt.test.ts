/**
 * write-receipt.test — a write declares its DAG edges (requires/provides) with
 * privacy-preserving commitments. Pure-function tests.
 */
import { describe, expect, it } from "bun:test";
import {
  buildWriteReceipt,
  bindingsFromBody,
  yieldsFromResponse,
} from "../src/lib/write-receipt.js";
import { commitValue } from "../src/proof/input-censor.js";

describe("bindingsFromBody (requires)", () => {
  it("one required binding per field; secrets carry a commitment, not the value", () => {
    const reqs = bindingsFromBody({ title: "hi", password: "pistol" });
    const byKey = Object.fromEntries(reqs.map((r) => [r.key, r]));
    expect(byKey.title.required).toBe(true);
    expect(byKey.title.source).toBe("body");
    expect(byKey.title.example_value).toBe("hi");
    expect(byKey.password.semantic_type).toBe("secret");
    expect(byKey.password.example_value).toBe(commitValue("pistol")); // committed, not "pistol"
    expect(byKey.password.example_value).not.toContain("pistol");
  });
});

describe("yieldsFromResponse (provides)", () => {
  it("extracts created-resource ids, unwrapping data/json envelopes", () => {
    expect(yieldsFromResponse({ id: 101, title: "x" }).map((b) => b.key)).toContain("id");
    expect(yieldsFromResponse({ data: { post_id: "p_9" } })[0]).toMatchObject({
      key: "post_id",
      source: "response",
      semantic_type: "resource_id",
      example_value: "p_9",
    });
    expect(yieldsFromResponse("not json")).toEqual([]);
    expect(yieldsFromResponse({ nothing: "here" })).toEqual([]);
  });
});

describe("buildWriteReceipt", () => {
  it("produces a contract-shaped receipt: claim + commitments + requires + provides", () => {
    const r = buildWriteReceipt({
      intent: "create a post",
      method: "POST",
      url: "https://api.example.com/posts",
      body: { title: "hi", token: "sk-1" },
      responseBody: { id: 55, title: "hi" },
    });
    expect(r.claim).toBe("create a post");
    expect(r.input_commitments.token).toBe(commitValue("sk-1"));
    expect(r.response_commitment).toMatch(/^sha256:/);
    expect(r.requires.map((b) => b.key).sort()).toEqual(["title", "token"]);
    expect(r.provides.map((b) => b.key)).toContain("id");
  });
  it("falls back to method+url as the claim when no intent", () => {
    const r = buildWriteReceipt({ method: "put", url: "https://x/y", body: {}, responseBody: "" });
    expect(r.claim).toBe("PUT https://x/y");
  });
});
