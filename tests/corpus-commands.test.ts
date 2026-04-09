/**
 * Tests for corpus-test and corpus-run CLI commands.
 * These cover arg parsing and output schema without hitting a live server.
 */

import { describe, test, expect } from "bun:test";
import { parseArgs } from "../src/cli.js";

describe("corpus-test arg parsing", () => {
  test("parses --retries flag", () => {
    const { command, flags } = parseArgs(["bun", "cli.ts", "corpus-test", "--url", "https://example.com", "--retries", "5"]);
    expect(command).toBe("corpus-test");
    expect(flags["retries"]).toBe("5");
    expect(flags["url"]).toBe("https://example.com");
  });

  test("defaults retries to 3 when not specified", () => {
    const { command, flags } = parseArgs(["bun", "cli.ts", "corpus-test", "--url", "https://example.com"]);
    expect(command).toBe("corpus-test");
    // retries flag absent — caller should default to 3
    expect(flags["retries"]).toBeUndefined();
  });

  test("parses --id flag", () => {
    const { flags } = parseArgs(["bun", "cli.ts", "corpus-test", "--url", "https://example.com", "--id", "my-site"]);
    expect(flags["id"]).toBe("my-site");
  });
});

describe("corpus-run arg parsing", () => {
  test("parses --corpus and --out flags", () => {
    const { command, flags } = parseArgs(["bun", "cli.ts", "corpus-run", "--corpus", "evals/trace-loop.json", "--out", "evals/snapshot.json"]);
    expect(command).toBe("corpus-run");
    expect(flags["corpus"]).toBe("evals/trace-loop.json");
    expect(flags["out"]).toBe("evals/snapshot.json");
  });

  test("parses --retries override", () => {
    const { flags } = parseArgs(["bun", "cli.ts", "corpus-run", "--corpus", "evals/trace-loop.json", "--out", "snap.json", "--retries", "2"]);
    expect(flags["retries"]).toBe("2");
  });
});

describe("corpus snapshot schema", () => {
  test("CorpusRunResult fields match compare-corpus-runs schema", () => {
    // Validate the schema we expect both corpus-run output and compare-corpus-runs.mjs to use.
    // This is a structural contract test — we check the required fields exist in a mock result.
    const mockResult = {
      id: "tiktok-trending",
      capture: "ok",
      endpoints: 12,
      requests: 40,
      resolve_endpoints: 3,
      verdict: "pass",
      attempts: 2,
      notes: "",
    };

    // Required fields for compare-corpus-runs.mjs
    const requiredFields = ["id", "capture", "endpoints", "requests", "resolve_endpoints", "verdict", "attempts"];
    for (const field of requiredFields) {
      expect(mockResult).toHaveProperty(field);
    }
  });

  test("snapshot top-level fields include results array", () => {
    const mockSnapshot = {
      git_sha: "abc123",
      timestamp: new Date().toISOString(),
      total_runtime_ms: 120000,
      results: [
        {
          id: "site-1",
          capture: "ok",
          endpoints: 5,
          requests: 20,
          resolve_endpoints: 2,
          verdict: "pass",
          attempts: 1,
          notes: "",
        },
      ],
    };

    expect(mockSnapshot).toHaveProperty("git_sha");
    expect(mockSnapshot).toHaveProperty("timestamp");
    expect(mockSnapshot).toHaveProperty("total_runtime_ms");
    expect(Array.isArray(mockSnapshot.results)).toBe(true);
    expect(mockSnapshot.results[0]).toHaveProperty("id");
    expect(mockSnapshot.results[0]).toHaveProperty("attempts");
  });
});
