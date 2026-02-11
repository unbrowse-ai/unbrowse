import { describe, expect, it } from "bun:test";
import { extractPromptText, hasApiIntent } from "../src/plugin/context-hints.js";

describe("context hints intent detection", () => {
  it("detects direct API intent text", () => {
    expect(hasApiIntent("Please capture internal API endpoints for this site")).toBe(true);
  });

  it("detects intent from user messages payload", () => {
    const event = {
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: [{ text: "Can you reverse engineer the API for this web app?" }] },
      ],
    };
    expect(hasApiIntent(event)).toBe(true);
  });

  it("ignores assistant-only API mentions", () => {
    const event = {
      messages: [
        { role: "assistant", content: "Use unbrowse_capture for API discovery" },
        { role: "user", content: "Write a short poem about trees" },
      ],
    };
    expect(hasApiIntent(event)).toBe(false);
  });

  it("extracts text from direct and message fields", () => {
    const event = {
      prompt: "hello",
      messages: [{ role: "user", content: "capture api calls" }],
    };
    expect(extractPromptText(event)).toContain("capture api calls");
  });
});
