/**
 * Witness: `fill` can ACT (not just read) and AUTO-INDEXES a captured route via an
 * injected index hook (the discover → publish loop), toggleable. Hermetic.
 */
import { test, expect } from "bun:test";
import { createHole, type HoleTransport, type IndexInfo } from "../src/sdk/hole.js";

// transport that records whether it was asked to ACT, and reports a fresh capture
const actTransport: HoleTransport = async (req) => ({
  ok: true,
  intent: req.intent,
  items: [{ url: "https://shop/api/cart", text: req.act ? "added to cart" : "viewed" }],
  captured: req.act === true, // an action against a new route → a capture to index
  skill: { domain: "shop.example", name: "add-to-cart" },
});

test("fill ACTS when req.act is set (execute, not just search)", async () => {
  let sawAct = false;
  const hole = createHole({
    transport: async (req) => {
      sawAct = req.act === true;
      return { ok: true, intent: req.intent, items: [{ text: "done" }] };
    },
  });
  const r = await hole.fill({ intent: "add the blue shoes to my cart", act: true });
  expect(sawAct).toBe(true);
  expect(r.items[0].text).toBe("done");
});

test("a captured route is auto-indexed through the index hook", async () => {
  const indexed: IndexInfo[] = [];
  const hole = createHole({
    transport: actTransport,
    index: (info) => {
      indexed.push(info);
    },
  });
  const r = await hole.fill({ intent: "add to cart", act: true });
  expect(r.captured).toBe(true);
  expect(r.indexed).toBe(true);
  expect(indexed).toHaveLength(1);
  expect(indexed[0].skill.domain).toBe("shop.example");
  expect(indexed[0].intent).toBe("add to cart");
});

test("autoIndex:false skips indexing even on a capture", async () => {
  const indexed: IndexInfo[] = [];
  const hole = createHole({ transport: actTransport, index: (i) => void indexed.push(i), autoIndex: false });
  const r = await hole.fill({ intent: "add to cart", act: true });
  expect(r.captured).toBe(true);
  expect(r.indexed).toBeUndefined();
  expect(indexed).toHaveLength(0);
});

test("a non-capture read does not index", async () => {
  const indexed: IndexInfo[] = [];
  const hole = createHole({ transport: actTransport, index: (i) => void indexed.push(i) });
  const r = await hole.fill({ intent: "just look", act: false });
  expect(r.captured).toBe(false);
  expect(indexed).toHaveLength(0);
});
