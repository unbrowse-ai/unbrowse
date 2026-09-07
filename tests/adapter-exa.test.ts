/**
 * Witness: the exa-js drop-in. Same `new Exa(...).search(...)` shape, exa-shaped results,
 * routed through the hole (stub transport — hermetic).
 */
import { test, expect } from "bun:test";
import { Exa } from "../src/sdk/adapters/exa.js";
import type { HoleTransport } from "../src/sdk/hole.js";

const stub: HoleTransport = async (req) => ({
  ok: true,
  intent: req.intent,
  answer: "the answer",
  items: [
    { title: "First", url: "https://a.example/1", text: "alpha", score: 0.9, publishedDate: "2026-01-01", highlights: ["h"], summary: "s" },
    { url: "https://b.example/2", text: "beta", score: 0.8 }, // no title → null
  ],
});

test("Exa.search returns exa-shaped results through the hole", async () => {
  const exa = new Exa("key", { transport: stub });
  const res = await exa.search("anthropic news", { numResults: 1 });
  expect(res.results).toHaveLength(1);
  const r = res.results[0];
  expect(r).toEqual({
    title: "First",
    url: "https://a.example/1",
    publishedDate: "2026-01-01",
    score: 0.9,
    text: "alpha",
    highlights: ["h"],
    summary: "s",
  });
});

test("Exa maps a missing title to null (exa contract)", async () => {
  const exa = new Exa("key", { transport: stub });
  const res = await exa.search("q");
  expect(res.results[1].title).toBeNull();
  expect(res.results[1].url).toBe("https://b.example/2");
});

test("Exa.searchAndContents requests text", async () => {
  const exa = new Exa(undefined, { transport: stub });
  const res = await exa.searchAndContents("q");
  expect(res.results[0].text).toBe("alpha");
});

test("Exa.answer returns the hole's answer", async () => {
  const exa = new Exa("k", { transport: stub });
  expect(await exa.answer("why")).toEqual({ answer: "the answer" });
});
