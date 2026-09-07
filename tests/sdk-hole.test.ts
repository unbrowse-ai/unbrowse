/**
 * Witness: the single streaming "hole" — one tool, fill an intent, stream the items.
 * Hermetic: an injected stub transport (no network), so the shape contract is pinned.
 */
import { test, expect } from "bun:test";
import { createHole, type HoleTransport } from "../src/sdk/hole.js";

const stub: HoleTransport = async (req) => ({
  ok: true,
  intent: req.intent,
  answer: "the answer",
  source: "stub",
  items: [
    { title: "First", url: "https://a.example/1", text: "alpha body", score: 0.9, publishedDate: "2026-01-01", highlights: ["a"], summary: "sum", rawContent: "RAW1" },
    { title: "Second", url: "https://b.example/2", text: "beta body", score: 0.8 },
  ],
});

test("hole.fill routes the intent through the transport and returns normalized items", async () => {
  const hole = createHole({ transport: stub });
  const r = await hole.fill({ intent: "find anthropic news" });
  expect(r.ok).toBe(true);
  expect(r.intent).toBe("find anthropic news");
  expect(r.answer).toBe("the answer");
  expect(r.items).toHaveLength(2);
  expect(r.items[0].url).toBe("https://a.example/1");
});

test("hole.stream yields each filled item", async () => {
  const hole = createHole({ transport: stub });
  const got: string[] = [];
  for await (const item of hole.stream({ intent: "x" })) got.push(item.url ?? "");
  expect(got).toEqual(["https://a.example/1", "https://b.example/2"]);
});

test("an unsealed hole carries no wallet seal", async () => {
  const r = await createHole({ transport: stub }).fill({ intent: "x" });
  expect(r.seal).toBeUndefined();
});
