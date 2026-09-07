/**
 * Witness for semantic-layer-walk: cheapest-first settle (not classic TSP),
 * semantic KV hit, warm-on-act, and multi-hop tour order.
 */
import { describe, expect, it } from "bun:test";
import {
  cosineSimilarity,
  memorySemanticLayer,
  orderTour,
  walkLayers,
  DEFAULT_LAYER_COSTS,
} from "../src/values/semantic-layer-walk.js";

describe("walkLayers — Dijkstra over semantic KV layers", () => {
  it("prefers a cheaper layer hit over an expensive act", async () => {
    const cheap = memorySemanticLayer<string>({ id: "memory", cost: DEFAULT_LAYER_COSTS.memory });
    cheap.put({ intent: "get weather", key: "weather" }, "cached-ok");
    let expensiveActs = 0;
    const expensive = memorySemanticLayer<string>({
      id: "browser",
      cost: DEFAULT_LAYER_COSTS.browser,
      act: async () => {
        expensiveActs += 1;
        return "browser-ok";
      },
    });

    const r = await walkLayers([expensive, cheap], { intent: "get weather", key: "weather" });
    expect(r.ok).toBe(true);
    expect(r.layer).toBe("memory");
    expect(r.via).toBe("hit");
    expect(r.value).toBe("cached-ok");
    expect(expensiveActs).toBe(0);
    expect(r.costPaid).toBe(DEFAULT_LAYER_COSTS.memory);
  });

  it("falls through miss to act, then warms for the next walk", async () => {
    let acts = 0;
    const layer = memorySemanticLayer<string>({
      id: "execute",
      cost: DEFAULT_LAYER_COSTS.execute,
      act: async () => {
        acts += 1;
        return "live-result";
      },
    });

    const first = await walkLayers([layer], { intent: "list launches", key: "spacex" });
    expect(first.ok).toBe(true);
    expect(first.via).toBe("act");
    expect(acts).toBe(1);

    const second = await walkLayers([layer], { intent: "list launches", key: "spacex" });
    expect(second.ok).toBe(true);
    expect(second.via).toBe("hit");
    expect(second.value).toBe("live-result");
    expect(acts).toBe(1); // no second live act
  });

  it("semantic layer hits paraphrases above cosine threshold", async () => {
    const embA = [1, 0, 0];
    const embB = [0.95, 0.1, 0]; // same-ish direction
    const embOther = [0, 1, 0]; // orthogonal

    const sem = memorySemanticLayer<string>({
      id: "semantic",
      cost: DEFAULT_LAYER_COSTS.semantic,
      threshold: 0.8,
    });
    sem.put({ intent: "CEO of OpenAI", key: "q1", embedding: embA }, "sam");

    const hit = await walkLayers([sem], {
      intent: "who leads OpenAI as chief executive",
      key: "q2",
      embedding: embB,
    });
    expect(hit.ok).toBe(true);
    expect(hit.value).toBe("sam");
    expect((hit.path[0]?.score ?? 0) >= 0.8).toBe(true);

    const miss = await walkLayers([sem], {
      intent: "how many Switch games sold",
      key: "q3",
      embedding: embOther,
    });
    expect(miss.ok).toBe(false);
  });

  it("does not tour every layer after a settle (anti-TSP for single intent)", async () => {
    const probed: string[] = [];
    const l0 = memorySemanticLayer<string>({
      id: "l0",
      cost: 0,
      act: async () => {
        probed.push("l0");
        return "done";
      },
    });
    const l1 = memorySemanticLayer<string>({
      id: "l1",
      cost: 10,
      act: async () => {
        probed.push("l1");
        return "late";
      },
    });
    const r = await walkLayers([l1, l0], { intent: "x", key: "x" });
    expect(r.ok).toBe(true);
    expect(r.layer).toBe("l0");
    expect(probed).toEqual(["l0"]); // l1 never probed after settle
  });
});

describe("orderTour — multi-hop residual TSP", () => {
  it("orders nodes by cheapest open path", () => {
    // A--1--B--1--C
    // A-----5-----C
    const cost = (from: string, to: string): number => {
      const e: Record<string, number> = {
        "A>B": 1,
        "B>A": 1,
        "B>C": 1,
        "C>B": 1,
        "A>C": 5,
        "C>A": 5,
      };
      return e[`${from}>${to}`] ?? 99;
    };
    const { order, cost: total } = orderTour(
      [{ id: "A" }, { id: "B" }, { id: "C" }],
      cost,
      { start: "A", twoOpt: true },
    );
    expect(order[0]).toBe("A");
    expect(order.join("")).toBe("ABC");
    expect(total).toBe(2);
  });

  it("is stable on a single node", () => {
    const r = orderTour([{ id: "only", cost: 3 }], () => 0);
    expect(r).toEqual({ order: ["only"], cost: 3 });
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
});
