import { describe, expect, test } from "bun:test";
import {
  CLOSE_LIMIT_MS,
  LISTED_WITHIN_MS,
  START_LIMIT_MS,
  endSession,
  nextActivePort,
  omitPorts,
  settleClosing,
  settlePending,
  stalePorts,
} from "./session-lifecycle";

const starting = (extra = {}) => ({ session: "a", engine: "chrome", since: 0, ...extra });

describe("a session starting", () => {
  test("stops saying Starting once it is listed", () => {
    expect(settlePending([starting()], new Set(["a"]), 1)).toEqual([]);
  });

  test("keeps saying it while the start command runs", () => {
    const pending = [starting()];
    expect(settlePending(pending, new Set(), START_LIMIT_MS - 1)).toBe(pending);
  });

  test("a start that answered but never appears stops saying it", () => {
    const pending = [starting({ answeredAt: 1000 })];
    expect(settlePending(pending, new Set(), 1000 + LISTED_WITHIN_MS - 1)).toBe(pending);
    expect(settlePending(pending, new Set(), 1000 + LISTED_WITHIN_MS)).toEqual([]);
  });

  test("a start that never answers stops saying it too", () => {
    expect(settlePending([starting()], new Set(), START_LIMIT_MS)).toEqual([]);
  });

  test("time still passes while the poll is failing", () => {
    expect(settlePending([starting({ answeredAt: 0 })], null, LISTED_WITHIN_MS)).toEqual([]);
  });
});

describe("a session closing", () => {
  test("is done when the list no longer has it", () => {
    expect(settleClosing({ a: 0 }, new Set(), 1)).toEqual({});
  });

  test("stays while the list still has it, up to the limit", () => {
    const closing = { a: 0 };
    expect(settleClosing(closing, new Set(["a"]), CLOSE_LIMIT_MS - 1)).toBe(closing);
  });

  test("a close that never finishes gives the row back", () => {
    expect(settleClosing({ a: 0 }, new Set(["a"]), CLOSE_LIMIT_MS)).toEqual({});
  });

  test("a failed poll is no news that the session went", () => {
    const closing = { a: 0 };
    expect(settleClosing(closing, null, 1)).toBe(closing);
  });
});

describe("ending a session", () => {
  const run = async (answer: { ok: boolean; error?: string }) => {
    const seen: string[] = [];
    await endSession(async () => answer, {
      started: () => seen.push("closing"),
      refused: (why) => seen.push(`refused: ${why}`),
      ended: () => seen.push("chat forgotten"),
    });
    return seen;
  };

  test("a refused close gives the row back at once and keeps the chat", async () => {
    expect(await run({ ok: false, error: "daemon busy" })).toEqual(["closing", "refused: daemon busy"]);
  });

  test("a refusal with no reason still says something", async () => {
    expect(await run({ ok: false })).toEqual(["closing", "refused: The session could not be closed"]);
  });

  test("the chat goes only when the session has", async () => {
    expect(await run({ ok: true })).toEqual(["closing", "chat forgotten"]);
  });
});

describe("the session on screen", () => {
  test("stays while it is listed", () => {
    expect(nextActivePort(2, [{ session: "a", port: 1 }, { session: "b", port: 2 }])).toBe(2);
  });

  test("moves to a live session, past one that is closing", () => {
    const sessions = [
      { session: "a", port: 1, closing: true },
      { session: "b", port: 2 },
    ];
    expect(nextActivePort(9, sessions)).toBe(2);
  });

  test("is none when nothing is left", () => {
    expect(nextActivePort(9, [])).toBe(0);
  });
});

describe("what is cached by port", () => {
  test("a port that left the list is forgotten", () => {
    expect(stalePorts({ 1: "a", 2: "b" }, [{ session: "b", port: 2 }]).stale).toEqual([1]);
  });

  test("a port taken by another session is forgotten", () => {
    expect(stalePorts({ 1: "a" }, [{ session: "new", port: 1 }]).stale).toEqual([1]);
  });

  test("a session keeping its port keeps its cache", () => {
    expect(stalePorts({ 1: "a" }, [{ session: "a", port: 1 }]).stale).toEqual([]);
  });

  test("the rest of the cache stands", () => {
    const cache = { 1: "chrome", 2: "lightpanda" };
    expect(omitPorts(cache, [1])).toEqual({ 2: "lightpanda" });
    expect(omitPorts(cache, [3])).toBe(cache);
  });
});
