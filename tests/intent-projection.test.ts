import { describe, expect, it } from "bun:test";
import { projectResultForIntent } from "../src/execution/index.js";

describe("intent-based result projection", () => {
  it("projects statuses for post intents", () => {
    const projected = projectResultForIntent({
      accounts: [{ username: "a" }],
      statuses: [{ id: "1", content: "hello", url: "https://example.com/1" }],
      hashtags: [{ name: "openai" }],
    }, "search posts");

    expect(Array.isArray(projected)).toBe(true);
    expect((projected as Array<Record<string, string>>)[0]?.content).toBe("hello");
  });

  it("projects accounts for people intents", () => {
    const projected = projectResultForIntent({
      statuses: [{ id: "1" }],
      accounts: [{ username: "sam", display_name: "Sam Altman" }],
    }, "search people");

    expect(Array.isArray(projected)).toBe(true);
    expect((projected as Array<Record<string, string>>)[0]?.username).toBe("sam");
  });
});
