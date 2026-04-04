import { describe, expect, test } from "bun:test";
import { hashApiKey } from "../src/client/index.js";

describe("delta attribution (#232)", () => {
  test("hashApiKey returns a stable deterministic hash", () => {
    const hash1 = hashApiKey("test-api-key-abc123");
    const hash2 = hashApiKey("test-api-key-abc123");
    expect(hash1).toBe(hash2);
    // SHA-256 hex digest is 64 chars
    expect(hash1).toHaveLength(64);
    // Must be hex only
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("hashApiKey never returns the raw key", () => {
    const key = "REMOVED_STRIPE_KEY";
    const hash = hashApiKey(key);
    expect(hash).not.toBe(key);
    expect(hash).not.toContain(key);
  });

  test("hashApiKey returns empty string for empty/missing keys", () => {
    expect(hashApiKey("")).toBe("");
    expect(hashApiKey("local-only")).toBe("");
  });

  test("different keys produce different hashes", () => {
    const h1 = hashApiKey("key-aaa");
    const h2 = hashApiKey("key-bbb");
    expect(h1).not.toBe(h2);
  });
});
