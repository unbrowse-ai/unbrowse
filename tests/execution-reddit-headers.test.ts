import { describe, expect, it } from "bun:test";
import { buildStructuredReplayHeaders } from "../src/execution/index.js";

describe("buildStructuredReplayHeaders", () => {
  it("adds browser-like headers for reddit structured replay", () => {
    const headers = buildStructuredReplayHeaders(
      "https://www.reddit.com/r/programming/",
      "https://www.reddit.com/r/programming/.json",
      { accept: "*/*" },
    );

    expect(headers.accept).toBe("application/json,text/plain,*/*");
    expect(headers["referer"]).toBe("https://www.reddit.com/r/programming/");
    expect(headers["accept-language"]).toBe("en-US,en;q=0.9");
    expect(typeof headers["user-agent"]).toBe("string");
  });

  it("leaves same-url non-reddit fetches alone", () => {
    const headers = buildStructuredReplayHeaders(
      "https://github.com/trending",
      "https://github.com/trending",
      { accept: "*/*" },
    );

    expect(headers.accept).toBe("*/*");
    expect(headers["referer"]).toBeUndefined();
    expect(headers["accept-language"]).toBeUndefined();
  });

  it("adds browser-like headers for non-reddit api replays", () => {
    const headers = buildStructuredReplayHeaders(
      "https://www.npmjs.com/search?q=openai",
      "https://registry.npmjs.org/-/v1/search?text=openai&size=20",
      {},
    );

    expect(headers.accept).toBe("application/json,text/plain,*/*");
    expect(headers["referer"]).toBe("https://www.npmjs.com/search?q=openai");
    expect(headers["accept-language"]).toBe("en-US,en;q=0.9");
    expect(typeof headers["user-agent"]).toBe("string");
  });
});
