#!/usr/bin/env bun
/**
 * Staging browser eval — runs CLI resolve against staging backend.
 * Requires Chrome + Kuri on the runner.
 *
 * Usage:
 *   UNBROWSE_BACKEND_URL=https://unbrowse-backend-staging.lewis-6d8.workers.dev \
 *     bun test ./evals/staging-browser.test.ts
 */

import { describe, test, expect } from "bun:test";
import { join } from "path";

const STAGING_URL =
  process.env.UNBROWSE_BACKEND_URL ??
  "https://unbrowse-backend-staging.lewis-6d8.workers.dev";

const PROJECT_ROOT = join(import.meta.dir, "..");

interface ResolveResult {
  result?: {
    error?: string;
    data?: unknown;
    _extraction?: { source?: string; confidence?: number };
  };
  trace?: {
    success?: boolean;
    error?: string;
  };
  timing?: { total_ms?: number; source?: string };
}

async function resolve(intent: string, url: string, timeoutMs = 90_000): Promise<ResolveResult | null> {
  try {
    const proc = Bun.spawn(
      ["bun", "run", join(PROJECT_ROOT, "src/cli.ts"), "resolve", "--intent", intent, "--url", url],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          UNBROWSE_BACKEND_URL: STAGING_URL,
          PATH: `/usr/local/bin:${process.env.HOME}/.bun/bin:${process.env.PATH}`,
          HOME: process.env.HOME!,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const timeout = setTimeout(() => proc.kill(), timeoutMs);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    clearTimeout(timeout);

    if (stderr && !stderr.includes("[unbrowse]")) {
      console.log(`  stderr: ${stderr.slice(0, 150)}`);
    }

    // Find JSON in stdout
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("{")) {
        try { return JSON.parse(trimmed) as ResolveResult; } catch { /* skip */ }
      }
    }

    console.log(`  no JSON in stdout (${stdout.length} chars)`);
    return null;
  } catch (err) {
    console.log(`  resolve error: ${(err as Error).message?.slice(0, 100)}`);
    return null;
  }
}

describe(`Staging browser eval (${STAGING_URL})`, () => {
  // Known-working site — should hit cached skill
  test("irs.gov resolves", async () => {
    const result = await resolve("get homepage content", "https://www.irs.gov");
    const success = result?.trace?.success;
    const error = result?.trace?.error;
    const source = result?.timing?.source;
    console.log(`  irs.gov: success=${success} error=${error ?? "none"} source=${source ?? "?"}`);
    expect(result).not.toBeNull();
    expect(success).toBe(true);
  }, 120_000);

  // Known-working site
  test("npr.org resolves", async () => {
    const result = await resolve("get homepage content", "https://www.npr.org");
    const success = result?.trace?.success;
    const source = result?.timing?.source;
    console.log(`  npr.org: success=${success} source=${source ?? "?"}`);
    expect(result).not.toBeNull();
    expect(success).toBe(true);
  }, 120_000);

  // Regression: no Invalid URL crashes
  test("gymshark does not crash with Invalid URL", async () => {
    const result = await resolve("get homepage content", "https://gymshark.com");
    const error = result?.trace?.error;
    console.log(`  gymshark: error=${error ?? "none"}`);
    // no_endpoints is acceptable, Invalid URL is not
    expect(error).not.toBe("Invalid URL");
  }, 120_000);

  // Latency
  test("marketwatch resolves under 30s", async () => {
    const start = Date.now();
    const result = await resolve("get homepage content", "https://www.marketwatch.com");
    const wallMs = Date.now() - start;
    const success = result?.trace?.success;
    console.log(`  marketwatch: success=${success} wall=${wallMs}ms`);
    expect(wallMs).toBeLessThan(30_000);
  }, 60_000);
});
