import { describe, expect, test } from "bun:test";
import { compactMessages, type ChatMessage } from "./chat-compaction";

const say = (id: string, role = "user"): ChatMessage => ({
  id,
  role,
  parts: [{ type: "text", text: id }],
});

/** A conversation of `count` messages, then the reply that carried the compaction. */
function afterCompaction(count: number, keepLastN: number, summary = "The user is buying a ticket."): ChatMessage[] {
  const sent = Array.from({ length: count }, (_, i) => say(`m${i}`, i % 2 ? "assistant" : "user"));
  return [
    ...sent,
    {
      id: "reply",
      role: "assistant",
      parts: [{ type: "text", text: "done" }],
      metadata: { compacted: true, summary, keepLastN },
    },
  ];
}

const textOf = (m: ChatMessage) => (m.parts[0] as { text: string }).text;

describe("a compacted conversation", () => {
  test("the next turn carries the summary the server wrote", () => {
    const next = compactMessages(afterCompaction(20, 5))!;
    expect(next[0].role).toBe("system");
    expect(textOf(next[0])).toBe("[Conversation summary]\nThe user is buying a ticket.");
  });

  test("every message the server kept stays, with the reply after them", () => {
    const next = compactMessages(afterCompaction(20, 5))!;
    expect(next.slice(1).map((m) => m.id)).toEqual(["m15", "m16", "m17", "m18", "m19", "reply"]);
  });

  test("compacting again changes nothing, so a reload keeps the summary", () => {
    const next = compactMessages(afterCompaction(20, 5))!;
    expect(compactMessages(next)).toBeNull();
    expect(compactMessages(JSON.parse(JSON.stringify(next)))).toBeNull();
  });

  test("a later compaction replaces the first and folds it in", () => {
    const first = compactMessages(afterCompaction(20, 5, "first"))!;
    const later: ChatMessage = {
      id: "reply-2",
      role: "assistant",
      parts: [{ type: "text", text: "ok" }],
      metadata: { compacted: true, summary: "second", keepLastN: 2 },
    };
    const next = compactMessages([...first, say("ask"), later])!;
    expect(next.map((m) => m.id)).toEqual(["compaction-reply-2", "reply", "ask", "reply-2"]);
    expect(textOf(next[0])).toContain("second");
  });

  test("a reply the server didn't compact leaves the conversation alone", () => {
    expect(compactMessages([say("a"), say("b", "assistant")])).toBeNull();
    const failed = { ...say("c", "assistant"), metadata: { compacted: false, warning: "too large" } };
    expect(compactMessages([say("a"), failed])).toBeNull();
  });

  test("without a summary there is nothing to stand for what would go, so nothing goes", () => {
    const reply = { ...say("r", "assistant"), metadata: { compacted: true, keepLastN: 1 } };
    expect(compactMessages([say("a"), say("b"), say("c"), reply])).toBeNull();
  });

  test("when the server kept everything no message is dropped", () => {
    expect(compactMessages(afterCompaction(3, 3))).toBeNull();
  });
});
