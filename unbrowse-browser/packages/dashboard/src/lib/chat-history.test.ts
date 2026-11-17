import { describe, expect, test } from "bun:test";
import { chatStorageKey, createChatBook, dropChat, loadChat, saveChat } from "./chat-history";

function memoryStore(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const fakeChat = (id: string) => ({ id, stopped: 0, stop() { this.stopped++; } });

describe("a chat's stored history", () => {
  test("comes back as it was saved", () => {
    const store = memoryStore();
    saveChat(store, "a", [{ id: "1" }]);
    expect(loadChat(store, "a")).toEqual([{ id: "1" }]);
  });

  test("one session's history is not another's", () => {
    const store = memoryStore();
    saveChat(store, "a", [{ id: "1" }]);
    expect(loadChat(store, "b")).toEqual([]);
  });

  test("a closed session's chat doesn't come back under its name", () => {
    const store = memoryStore();
    saveChat(store, "a", [{ id: "1" }]);
    dropChat(store, "a");
    expect(loadChat(store, "a")).toEqual([]);
    expect(store.items.size).toBe(0);
  });

  test("images are left out", () => {
    const store = memoryStore();
    saveChat(store, "a", [{ url: "data:image/png;base64,AAAA" }]);
    expect(store.items.get(chatStorageKey("a"))).toBe('[{"url":"[image stripped]"}]');
  });

  test("a damaged entry reads as no history", () => {
    expect(loadChat(memoryStore({ [chatStorageKey("a")]: "{nope" }), "a")).toEqual([]);
    expect(loadChat(memoryStore({ [chatStorageKey("a")]: '{"a":1}' }), "a")).toEqual([]);
  });

  test("a store that refuses never reaches the person", () => {
    const refuses = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("denied"); },
    };
    expect(loadChat(refuses, "a")).toEqual([]);
    saveChat(refuses, "a", []);
    dropChat(refuses, "a");
    expect(loadChat(null, "a")).toEqual([]);
  });
});

describe("a chat across a session switch", () => {
  test("coming back finds the same chat, with its turn still running", () => {
    const book = createChatBook(fakeChat);
    const a = book.chatFor("a");
    book.chatFor("b");
    expect(book.chatFor("a")).toBe(a);
    expect(a.stopped).toBe(0);
  });

  test("closing the session stops its turn, and the name starts fresh", () => {
    const book = createChatBook(fakeChat);
    const a = book.chatFor("a");
    book.forget("a");
    expect(a.stopped).toBe(1);
    expect(book.chatFor("a")).not.toBe(a);
  });

  test("a forgotten chat isn't current, so its last turn can't save it back", () => {
    const book = createChatBook(fakeChat);
    const a = book.chatFor("a");
    expect(book.isCurrent("a", a)).toBe(true);
    book.forget("a");
    expect(book.isCurrent("a", a)).toBe(false);
  });

  test("forgetting a chat never opened is nothing", () => {
    createChatBook(fakeChat).forget("a");
  });
});
