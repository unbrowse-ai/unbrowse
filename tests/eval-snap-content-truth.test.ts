import { describe, expect, it } from "bun:test";
import type { AXNode } from "../src/cdp/types.js";
import { adjudicateSnapContent, assessAxTree } from "../src/cli-v7/eval/snap.js";

const node = (nodeId: string, role: string, name = ""): AXNode => ({
  nodeId,
  ignored: false,
  role: { type: "role", value: role },
  name: { type: "computedString", value: name },
});

describe("eval snap accessibility truth", () => {
  it("rejects an Apify-shaped root title plus anonymous generic wrappers", () => {
    const result = assessAxTree([
      node("root", "RootWebArea", "Apify Console"),
      node("g1", "generic"),
      node("g2", "generic"),
    ]);
    expect(result).toEqual({ usable: false, actionableCount: 0, meaningfulNameCount: 0 });
  });

  it("accepts an actionable control even if generic wrappers surround it", () => {
    const result = assessAxTree([
      node("root", "RootWebArea", "Apify Console"),
      node("g1", "generic"),
      node("publish", "button", "Publish on Store"),
    ]);
    expect(result.usable).toBe(true);
    expect(result.actionableCount).toBe(1);
  });

  it("accepts meaningful static page content without requiring a control", () => {
    const result = assessAxTree([
      node("root", "RootWebArea", "Article"),
      node("heading", "heading", "A useful heading"),
    ]);
    expect(result.usable).toBe(true);
    expect(result.meaningfulNameCount).toBe(1);
  });

  it("uses DOM or pixels as a second witness for a generic AX tree", () => {
    expect(adjudicateSnapContent({ axUsable: false, domText: "Publish on Store", screenshot: null }))
      .toEqual({ taskOk: true, source: "dom_text" });
    expect(adjudicateSnapContent({ axUsable: false, domText: "", screenshot: "cG5n" }))
      .toEqual({ taskOk: true, source: "screenshot" });
  });

  it("fails closed when AX, DOM, and pixels provide no content", () => {
    expect(adjudicateSnapContent({ axUsable: false, domText: "", screenshot: null }))
      .toEqual({ taskOk: false, source: "none" });
  });
});
