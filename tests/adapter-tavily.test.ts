/**
 * Witness: the @tavily/core drop-in. Same `tavily({...}).search/extract`, tavily-shaped
 * responses, routed through the hole (stub transport — hermetic).
 */
import { test, expect } from "bun:test";
import { tavily } from "../src/sdk/adapters/tavily.js";
import type { HoleTransport } from "../src/sdk/hole.js";

const stub: HoleTransport = async (req) => ({
  ok: true,
  intent: req.intent,
  answer: req.intent.startsWith("extract") ? undefined : "tavily answer",
  items: req.intent.startsWith("extract")
    ? [{ url: req.url, text: "extracted body" }]
    : [
        { title: "T1", url: "https://a.example/1", text: "alpha", score: 0.7 },
        { title: "T2", url: "https://b.example/2", text: "beta", score: 0.6 },
      ],
});

test("tavily.search returns the tavily response shape", async () => {
  const tvly = tavily({ transport: stub });
  const res = await tvly.search("anthropic");
  expect(res.query).toBe("anthropic");
  expect(res.answer).toBe("tavily answer");
  expect(res.results).toEqual([
    { title: "T1", url: "https://a.example/1", content: "alpha", score: 0.7, rawContent: undefined },
    { title: "T2", url: "https://b.example/2", content: "beta", score: 0.6, rawContent: undefined },
  ]);
});

test("tavily.extract returns results + failedResults", async () => {
  const tvly = tavily({ transport: stub });
  const res = await tvly.extract(["https://x.example/page"]);
  expect(res.results).toEqual([{ url: "https://x.example/page", rawContent: "extracted body" }]);
  expect(res.failedResults).toEqual([]);
});
