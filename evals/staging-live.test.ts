#!/usr/bin/env bun
/**
 * Staging live eval — runs unbrowse CLI resolve against the staging backend.
 * Tests the full client → staging backend → capture → extract pipeline.
 *
 * This is the gate that must pass before production deploy.
 *
 * Set STAGING_URL env var to point the CLI at staging.
 *
 * Usage:
 *   UNBROWSE_BACKEND_URL=https://unbrowse-backend-staging.lewis-6d8.workers.dev \
 *     bun test ./evals/staging-live.test.ts
 */

import { describe, test, expect } from "bun:test";
import { execSync } from "child_process";

const STAGING_URL =
  process.env.UNBROWSE_BACKEND_URL ??
  "https://unbrowse-backend-staging.lewis-6d8.workers.dev";

interface ResolveResult {
  result?: {
    error?: string;
    data?: unknown;
    _extraction?: { source?: string; confidence?: number };
  };
  trace?: {
    success?: boolean;
    skill_id?: string;
    error?: string;
  };
  timing?: {
    total_ms?: number;
  };
}

function runResolve(intent: string, url: string, timeoutSec = 60): ResolveResult | null {
  try {
    const bunPath = process.env.HOME + "/.bun/bin/bun";
    const cliPath = process.cwd() + "/src/cli.ts";
    const stdout = execSync(
      `${bunPath} ${cliPath} resolve --intent "${intent}" --url "${url}"`,
      {
        timeout: timeoutSec * 1000,
        env: {
          ...process.env,
          UNBROWSE_BACKEND_URL: STAGING_URL,
          PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    ).toString();

    // Find JSON in output (skip log lines)
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("{")) {
        try {
          return JSON.parse(trimmed) as ResolveResult;
        } catch { /* not JSON */ }
      }
    }
    return null;
  } catch (err) {
    console.log(`  resolve failed: ${(err as Error).message?.slice(0, 100)}`);
    return null;
  }
}

describe(`Staging live eval (${STAGING_URL})`, () => {
  // Sites that should work (from the passing eval corpus)
  const passSites = [
    { url: "https://www.irs.gov", intent: "get homepage content", id: "L01" },
    { url: "https://www.npr.org", intent: "get homepage content", id: "L10" },
    { url: "https://www.marketwatch.com", intent: "get homepage content", id: "L20" },
  ];

  for (const site of passSites) {
    test(`${site.id}: ${site.url} resolves successfully`, async () => {
      const result = runResolve(site.intent, site.url, 90);
      expect(result).not.toBeNull();

      const success = result?.trace?.success;
      const error = result?.result?.error ?? result?.trace?.error;
      const totalMs = result?.timing?.total_ms;

      console.log(`  ${site.id}: success=${success} error=${error ?? "none"} time=${totalMs ?? "?"}ms`);

      expect(success).toBe(true);
    }, 120_000); // 2 min timeout per site
  }

  // Sites that previously crashed with Invalid URL (should no longer crash)
  test("previously crashing sites don't return Invalid URL", async () => {
    const crashSites = [
      { url: "https://gymshark.com", id: "L07" },
      { url: "https://www.booking.com", id: "L16" },
    ];

    for (const site of crashSites) {
      const result = runResolve("get homepage content", site.url, 90);
      const error = result?.trace?.error ?? result?.result?.error;
      console.log(`  ${site.id} ${site.url}: error=${error ?? "none"}`);

      // Should NOT be "Invalid URL" — may be no_endpoints which is acceptable
      expect(error).not.toBe("Invalid URL");
    }
  }, 240_000);

  // Latency check — resolve should complete in under 30s for known sites
  test("resolve latency under 30s for known sites", async () => {
    const result = runResolve("get homepage content", "https://www.npr.org", 60);
    const totalMs = result?.timing?.total_ms ?? 999999;
    console.log(`  npr.org resolve: ${totalMs}ms`);
    expect(totalMs).toBeLessThan(30000);
  }, 90_000);
});
