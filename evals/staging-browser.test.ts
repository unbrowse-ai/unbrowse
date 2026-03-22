#!/usr/bin/env bun
/**
 * Staging browser eval — real local browser/orchestrator path against staging backend.
 *
 * Usage:
 *   UNBROWSE_BACKEND_URL=https://unbrowse-backend-staging.lewis-6d8.workers.dev \
 *     bun test ./evals/staging-browser.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { assessIntentResult } from "../src/intent-match.js";

const BACKEND_URL =
  process.env.UNBROWSE_BACKEND_URL ??
  process.env.STAGING_URL ??
  "https://unbrowse-backend-staging.lewis-6d8.workers.dev";

process.env.UNBROWSE_BACKEND_URL ??= BACKEND_URL;
process.env.UNBROWSE_NON_INTERACTIVE ??= "1";
process.env.UNBROWSE_TOS_ACCEPTED ??= "1";
process.env.UNBROWSE_KURI_ATTACH_EXISTING_CHROME ??= "0";

const { startUnbrowseServer } = await import("../src/server.js");
type RunningUnbrowseServer = import("../src/server.js").RunningUnbrowseServer;

const TARGET_URL = "https://www.npmjs.com/package/express";

let server: RunningUnbrowseServer | null = null;
let baseUrl = "";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      probe.close((err) => err ? reject(err) : resolve(address.port));
    });
    probe.on("error", reject);
  });
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T; latencyMs: number }> {
  const startedAt = Date.now();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    data: await res.json() as T,
    latencyMs: Date.now() - startedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

beforeAll(async () => {
  const port = await getFreePort();
  server = await startUnbrowseServer({
    host: "127.0.0.1",
    port,
    logger: false,
    scheduleVerification: false,
  });
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server?.close();
});

describe(`Staging browser eval (${BACKEND_URL})`, () => {
  test("local browser server becomes healthy", async () => {
    const { status, data, latencyMs } = await api<{ status?: string }>("GET", "/health");
    console.log(`  local health: ${status} (${latencyMs}ms)`);
    expect(status).toBe(200);
    expect(data?.status).toBe("ok");
  }, 10_000);

  test("browser capture learns and executes package detail correctly", async () => {
    const learned = await api<{
      result?: { learned_skill_id?: string; seeded_from?: string };
      trace?: { endpoint_id?: string; success?: boolean };
      source?: string;
      timing?: { total_ms?: number };
    }>("POST", "/v1/intent/resolve", {
      intent: "get package info",
      params: { url: TARGET_URL },
      context: { url: TARGET_URL },
      force_capture: true,
    });

    console.log(
      `  browser capture: status=${learned.status} source=${learned.data?.source ?? "none"} endpoint=${learned.data?.trace?.endpoint_id ?? "none"} ${learned.latencyMs}ms`,
    );
    expect(learned.status).toBe(200);
    expect(learned.data?.source).toBe("live-capture");
    expect(learned.data?.trace?.success).toBe(true);
    expect(learned.data?.trace?.endpoint_id).toBe("browser-capture");
    expect(learned.data?.result?.seeded_from).toBeDefined();

    const learnedSkillId = learned.data?.result?.learned_skill_id;
    expect(typeof learnedSkillId).toBe("string");

    const skill = await api<{ execution_type?: string; endpoints?: Array<{ endpoint_id?: string }> }>(
      "GET",
      `/v1/skills/${learnedSkillId}`,
    );
    expect(skill.status).toBe(200);
    expect(skill.data?.execution_type).toBe("http");
    expect(Array.isArray(skill.data?.endpoints)).toBe(true);
    expect((skill.data?.endpoints?.length ?? 0)).toBeGreaterThan(0);

    const endpointId = skill.data?.endpoints?.[0]?.endpoint_id;
    expect(typeof endpointId).toBe("string");

    const executed = await api<{
      result?: unknown;
      trace?: { success?: boolean; endpoint_id?: string };
    }>("POST", `/v1/skills/${learnedSkillId}/execute`, {
      params: {
        url: TARGET_URL,
        endpoint_id: endpointId,
      },
      intent: "get package info",
      context_url: TARGET_URL,
    });

    console.log(
      `  learned execute: status=${executed.status} endpoint=${executed.data?.trace?.endpoint_id ?? "none"} ${executed.latencyMs}ms`,
    );
    expect(executed.status).toBe(200);
    expect(executed.data?.trace?.success).toBe(true);
    expect(executed.data?.trace?.endpoint_id).toBe(endpointId);

    const result = executed.data?.result;
    expect(isRecord(result)).toBe(true);

    const verdict = assessIntentResult(result, "get package info");
    expect(verdict.verdict).toBe("pass");

    const packageInfo = result as Record<string, unknown>;
    expect(packageInfo.name).toBe("express");
    expect(typeof packageInfo.version).toBe("string");
    expect(String(packageInfo.version)).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof packageInfo.description).toBe("string");
    expect(String(packageInfo.description).toLowerCase()).toContain("framework");
    expect(Array.isArray(packageInfo.keywords)).toBe(true);
    expect((packageInfo.keywords as unknown[]).map(String)).toContain("express");
    expect(Array.isArray(packageInfo.dependencies)).toBe(true);
    expect((packageInfo.dependencies as unknown[]).length).toBeGreaterThan(5);
    expect(typeof packageInfo.url).toBe("string");
    expect(String(packageInfo.url)).toContain("expressjs.com");
  }, 120_000);
});
