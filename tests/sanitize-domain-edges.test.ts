// Sanitizer edge tests — Phase 1.1 Day-5 creature (LOW-1 fix).
import { describe, test, expect } from "bun:test";
import { sanitizeDomain } from "../src/indexer/queue-store.js";

describe("sanitizeDomain edges", () => {
  test("NFC and NFD collapse to same output", () => {
    const precomposed = "Ë"; // Ë
    const decomposed = "Ë"; // E + combining diaeresis
    expect(sanitizeDomain(precomposed)).toBe(sanitizeDomain(decomposed));
  });

  test("basic ASCII unchanged", () => {
    expect(sanitizeDomain("example.com")).toBe("example.com");
  });

  test("CON gets prefix", () => {
    expect(sanitizeDomain("CON")).toBe("_CON");
  });

  test("lowercase con gets prefix", () => {
    expect(sanitizeDomain("con")).toBe("_con");
  });

  test("CON.example gets prefix", () => {
    expect(sanitizeDomain("CON.example")).toBe("_CON.example");
  });

  test("COM1 gets prefix", () => {
    expect(sanitizeDomain("COM1")).toBe("_COM1");
  });

  test("LPT9.bar gets prefix", () => {
    expect(sanitizeDomain("LPT9.bar")).toBe("_LPT9.bar");
  });

  test("console NOT prefixed", () => {
    expect(sanitizeDomain("console")).toBe("console");
  });

  test("com10 NOT prefixed", () => {
    expect(sanitizeDomain("com10")).toBe("com10");
  });

  test("length cap still works", () => {
    expect(sanitizeDomain("a".repeat(300)).length).toBeLessThanOrEqual(200);
  });
});
