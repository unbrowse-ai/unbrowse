/**
 * Witness: the browser-use Agent drop-in. Same `new Agent({task}).run()`, routed through
 * the hole (stub transport — hermetic).
 */
import { test, expect } from "bun:test";
import { Agent } from "../src/sdk/adapters/browser-use.js";
import type { HoleTransport } from "../src/sdk/hole.js";

const stub: HoleTransport = async (req) => ({
  ok: true,
  intent: req.intent,
  answer: "task done: found 2 items",
  items: [
    { title: "R1", url: "https://a.example/1", text: "one" },
    { title: "R2", url: "https://b.example/2", text: "two" },
  ],
});

test("Agent.run fills the task through the hole and returns a result", async () => {
  const agent = new Agent({ task: "find the cheapest flight", transport: stub });
  const out = await agent.run();
  expect(out.task).toBe("find the cheapest flight");
  expect(out.done).toBe(true);
  expect(out.result).toBe("task done: found 2 items");
  expect(out.items).toHaveLength(2);
  expect(out.items[0].url).toBe("https://a.example/1");
});

test("Agent accepts an llm param for signature compatibility", async () => {
  const agent = new Agent({ task: "x", llm: { provider: "anthropic" }, transport: stub });
  const out = await agent.run();
  expect(out.done).toBe(true);
});
