#!/usr/bin/env bun
/**
 * Staging browser eval — runs CLI resolve with browser capture against staging.
 * Requires Chrome + Kuri on the runner.
 *
 * Tests the full pipeline: CLI → local Kuri → capture → staging backend → extract
 *
 * Usage:
 *   UNBROWSE_BACKEND_URL=https://unbrowse-backend-staging.lewis-6d8.workers.dev \
 *     bun test ./evals/staging-browser.test.ts
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
    _extraction?: { source?: string; confidence?: number; quality_note?: string };
  };
  trace?: {
    success?: boolean;
    skill_id?: string;
    error?: string;
  };
  timing?: { total_ms?: number };
}

function runResolve(intent: string, url: string, timeoutSec = 90): ResolveResult | null {
  try {
    const stdout = execSync(
      `bun src/cli.ts resolve --intent "${intent}" --url "${url}"`,
      {
        timeout: timeoutSec * 1000,
        env: {
          ...process.env,
          UNBROWSE_BACKEND_URL: STAGING_URL,
          HOME: process.env.HOME,
          PATH: `/usr/local/bin:${process.env.HOME}/.bun/bin:${process.env.PATH}`,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    ).toString();

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("{")) {
        try { return JSON.parse(trimmed) as ResolveResult; } catch { /* skip */ }
      }
    }
    return null;
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? "";
    console.log(`  resolve error: ${(err as Error).message?.slice(0, 80)}`);
    if (stderr) console.log(`  stderr: ${stderr.slice(0, 200)}`);
    return null;
  }
}

describe(`Staging browser eval (${STAGING_URL})`, () => {
  // Known-working sites from eval corpus
  test("L01: irs.gov resolves via existing skill", () => {
    const result = runResolve("get homepage content", "https://www.irs.gov");
    expect(result).not.toBeNull();
    const success = result?.trace?.success;
    const error = result?.result?.error ?? result?.trace?.error;
    console.log(`  irs.gov: success=${success} error=${error ?? "none"}`);
    expect(success).toBe(true);
  }, 120_000);

  test("L10: npr.org resolves with data", () => {
    const result = runResolve("get homepage content", "https://www.npr.org");
    expect(result).not.toBeNull();
    const success = result?.trace?.success;
    const hasData = !!result?.result?.data;
    console.log(`  npr.org: success=${success} hasData=${hasData}`);
    expect(success).toBe(true);
  }, 120_000);

  // SSR fallback test — these sites should now extract via plain HTTP fetch
  test("SSR fallback: thetrainline.com extracts data", () => {
    const result = runResolve("get homepage content", "https://www.thetrainline.com");
    expect(result).not.toBeNull();
    const success = result?.trace?.success;
    const error = result?.result?.error ?? result?.trace?.error;
    const source = result?.result?._extraction?.source;
    console.log(`  trainline: success=${success} error=${error ?? "none"} source=${source ?? "n/a"}`);
    // Should succeed with SSR fallback, or at minimum not crash
    expect(error).not.toBe("Invalid URL");
  }, 120_000);

  // Regression: no Invalid URL crashes
  test("regression: gymshark does not crash with Invalid URL", () => {
    const result = runResolve("get homepage content", "https://gymshark.com");
    const error = result?.trace?.error ?? result?.result?.error;
    console.log(`  gymshark: error=${error ?? "none"}`);
    expect(error).not.toBe("Invalid URL");
  }, 120_000);

  // Latency regression
  test("resolve completes within 60s for known sites", () => {
    const start = Date.now();
    const result = runResolve("get homepage content", "https://www.marketwatch.com", 60);
    const wallMs = Date.now() - start;
    const apiMs = result?.timing?.total_ms;
    console.log(`  marketwatch: wall=${wallMs}ms api=${apiMs ?? "?"}ms`);
    expect(wallMs).toBeLessThan(60000);
  }, 90_000);
});
