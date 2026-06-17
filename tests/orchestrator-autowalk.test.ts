import { describe, it, expect } from "bun:test";
import { registrableHost, shouldAutoWalk, pickWalkTarget } from "../src/orchestrator/index.js";

describe("registrableHost", () => {
  it("strips www + returns eTLD+1-ish (incl .sg)", () => {
    expect(registrableHost("https://www.carousell.sg/food/q/")).toBe("carousell.sg");
    expect(registrableHost("https://carousell.sg/")).toBe("carousell.sg");
    expect(registrableHost("https://sub.example.com/x")).toBe("example.com");
  });
  it("null on garbage / empty", () => {
    expect(registrableHost("not a url")).toBeNull();
    expect(registrableHost(null)).toBeNull();
    expect(registrableHost(undefined)).toBeNull();
  });
});

describe("shouldAutoWalk gate", () => {
  const req = "https://www.carousell.sg/categories/food-beverages-1011/";
  it("walks a same-registrable-domain candidate regardless of score", () => {
    expect(shouldAutoWalk(req, "https://www.carousell.sg/p/risoles-1/", 0.3)).toBe(true);
  });
  it("walks a high-score off-domain candidate (>= minScore)", () => {
    expect(shouldAutoWalk(req, "https://other.com/x", 0.85)).toBe(true);
  });
  it("does NOT walk a low-score off-domain candidate", () => {
    expect(shouldAutoWalk(req, "https://other.com/x", 0.5)).toBe(false);
  });
  it("no url → false", () => {
    expect(shouldAutoWalk(req, undefined, 1)).toBe(false);
  });
  it("no requested url → falls back to score gate only", () => {
    expect(shouldAutoWalk(undefined, "https://other.com/x", 0.9)).toBe(true);
    expect(shouldAutoWalk(undefined, "https://other.com/x", 0.5)).toBe(false);
  });
});

describe("pickWalkTarget — prefer a deep page over a bare homepage", () => {
  const req = "https://www.carousell.sg/categories/food-beverages-1011/";
  it("skips the same-domain homepage in favour of a deep same-domain page (the Carousell bug)", () => {
    const ranked = [
      { url: "https://www.carousell.sg/", score: 1.0 },          // homepage — should be skipped
      { url: "https://www.carousell.sg/p/risoles-1/", score: 0.9 }, // real listing — should win
      { url: "https://www.carousell.sg/p/tarts-2/", score: 0.8 },
    ];
    expect(pickWalkTarget(req, ranked)?.url).toBe("https://www.carousell.sg/p/risoles-1/");
  });
  it("falls back to the homepage when it is the only same-domain candidate", () => {
    const ranked = [{ url: "https://www.carousell.sg/", score: 1.0 }];
    expect(pickWalkTarget(req, ranked)?.url).toBe("https://www.carousell.sg/");
  });
  it("returns null when nothing passes the gate (low-score off-domain only)", () => {
    const ranked = [
      { url: "https://blog.example.com/how-to", score: 0.5 },
      { url: "https://other.net/post", score: 0.4 },
    ];
    expect(pickWalkTarget(req, ranked)).toBeNull();
  });
  it("picks a high-score off-domain deep page when no same-domain candidate exists", () => {
    const ranked = [
      { url: "https://authority.com/", score: 0.95 },     // off-domain homepage, high score
      { url: "https://authority.com/answer", score: 0.9 }, // off-domain deep, high score → preferred
    ];
    expect(pickWalkTarget(req, ranked)?.url).toBe("https://authority.com/answer");
  });
});
