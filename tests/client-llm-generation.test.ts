/**
 * Witness: the "index it nicely" generation runs CLIENT-SIDE via a pluggable generate hook
 * (the agent's own model), never a server round-trip. When a client generate is provided,
 * it produces the route's name/description and the index hook receives it.
 */
import { test, expect } from "bun:test";
import { createHole, type HoleTransport, type IndexInfo } from "../src/sdk/hole.js";

const capture: HoleTransport = async (req) => ({
  ok: true,
  intent: req.intent,
  items: [{ url: "https://api.shop/products", text: "products json" }],
  captured: true,
  skill: { domain: "shop.example" }, // no description yet — the client LLM fills it
});

test("a client-side generate hook names + describes the captured route", async () => {
  const prompts: string[] = [];
  let indexedSkill: IndexInfo["skill"] | null = null;
  const hole = createHole({
    transport: capture,
    // the agent's OWN model — runs on the client, no server call
    generate: (prompt) => {
      prompts.push(prompt);
      return "product-search — list shop products by query";
    },
    index: (info) => {
      indexedSkill = info.skill;
    },
  });

  const r = await hole.fill({ intent: "find products on shop.example" });

  // the client model was actually invoked, with the captured route in the prompt
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("shop.example");
  // its output became the route's nice name + description
  expect(r.skill?.name).toBe("product-search");
  expect(r.skill?.description).toBe("list shop products by query");
  // and the index hook received the client-generated metadata
  expect(indexedSkill).toEqual({ domain: "shop.example", name: "product-search", description: "list shop products by query" });
});

test("no client model → WE still generate a description (free, deterministic), no server call", async () => {
  let indexed = false;
  // no `generate` hook and no network: the description must still be filled by us
  const hole = createHole({ transport: capture, index: () => void (indexed = true) });
  const r = await hole.fill({ intent: "find products on shop.example" });
  expect(indexed).toBe(true);
  // our zero-cost deterministic baseline named + described it — the user wrote nothing
  expect(r.skill?.name).toBe("shop-find");
  expect(r.skill?.description).toBe("Find route on shop.example — find products on shop.example");
});

test("describe:false opts out — route indexed with no generated description", async () => {
  let captured: { description?: string } | undefined;
  const hole = createHole({ transport: capture, index: (i) => void (captured = i.skill), describe: false });
  const r = await hole.fill({ intent: "x" });
  expect(r.indexed).toBe(true);
  expect(r.skill?.description).toBeUndefined();
  expect(captured?.description).toBeUndefined();
});

test("client generation is async-capable (real models return promises)", async () => {
  const hole = createHole({
    transport: capture,
    generate: async (_p) => "async-route — described by a real async model",
    index: () => {},
  });
  const r = await hole.fill({ intent: "x" });
  expect(r.skill?.name).toBe("async-route");
  expect(r.skill?.description).toBe("described by a real async model");
});
