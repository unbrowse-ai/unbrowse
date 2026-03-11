import { describe, expect, test } from "bun:test";
import { isValidAgentEmail, normalizeAgentEmail, resolveAgentName } from "../src/client/index.js";

describe("client registration identity", () => {
  test("normalizes valid email agent names", () => {
    expect(normalizeAgentEmail("  Lewis@Example.COM ")).toBe("lewis@example.com");
    expect(isValidAgentEmail("Lewis@Example.COM")).toBe(true);
    expect(resolveAgentName(" Lewis@Example.COM ", "host-abc123")).toBe("lewis@example.com");
  });

  test("falls back to local agent id when email is invalid", () => {
    expect(isValidAgentEmail("not-an-email")).toBe(false);
    expect(resolveAgentName("not-an-email", "host-abc123")).toBe("host-abc123");
    expect(resolveAgentName("", "host-abc123")).toBe("host-abc123");
  });
});
