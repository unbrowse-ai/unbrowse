/**
 * Real OpenClaw Integration Tests — No mocking.
 *
 * Spins up real OpenClaw agent sessions and sends messages that trigger
 * actual unbrowse tool calls. The agent uses its LLM to reason about the
 * request, call the appropriate tool, and return the result.
 *
 * Requirements:
 *   - OpenClaw gateway running on port 18789
 *   - Agent "main" configured
 *   - unbrowse-openclaw plugin installed and enabled
 *
 * These tests use real API tokens and take 10-30s each.
 * Run with: bun test src/__tests__/integration/tool-harness.test.ts
 */

import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { OpenClawHarness, createTestHarness } from "../harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "..", "fixtures");

function loadFixtureRaw(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, `${name}.har.json`), "utf-8"));
}

// Track all harnesses so we can clean up even if a test fails
const harnesses: OpenClawHarness[] = [];
function newHarness(): OpenClawHarness {
  const oc = createTestHarness();
  harnesses.push(oc);
  return oc;
}

afterEach(() => {
  // Dispose all harnesses created during this test
  for (const oc of harnesses) {
    oc.dispose();
  }
  harnesses.length = 0;
});

// ── unbrowse_skills — list captured APIs ──────────────────────────────────

describe("unbrowse_skills", () => {
  it("lists captured skills when asked", async () => {
    const oc = newHarness();
    const res = await oc.send(
      "Call unbrowse_skills to list my captured API skills. Just call the tool and show the result."
    );

    expect(res.status).toBe("ok");
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.text).toMatch(/skill|endpoint|captured|api|\d+/i);
  }, 60_000);
});

// ── unbrowse_learn — parse HAR into a skill ───────────────────────────────

describe("unbrowse_learn", () => {
  it("parses a HAR file and generates a skill", async () => {
    const oc = newHarness();
    const harPath = oc.writeHarFixture(loadFixtureRaw("todo-api"), "todo-api.har.json");

    const res = await oc.send(
      `Call unbrowse_learn with harPath="${harPath}". Just call the tool, nothing else.`
    );

    expect(res.status).toBe("ok");
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.text).toMatch(/skill|endpoint|todo|generated|auth/i);
  }, 60_000);

  it("reports endpoints and auth method", async () => {
    const oc = newHarness();
    const harPath = oc.writeHarFixture(loadFixtureRaw("todo-api"), "todo-api.har.json");

    const res = await oc.send(
      `Call unbrowse_learn with harPath="${harPath}". Show what endpoints were found.`
    );

    expect(res.status).toBe("ok");
    expect(res.text).toMatch(/GET|POST|PUT|DELETE|endpoint/i);
  }, 60_000);
});

// ── unbrowse_analyze — deep API analysis ──────────────────────────────────

describe("unbrowse_analyze", () => {
  it("analyzes an existing skill with deep mode", async () => {
    const oc = newHarness();
    const harPath = oc.writeHarFixture(loadFixtureRaw("todo-api"), "todo-api.har.json");

    // Step 1: Learn — creates the skill
    const learnRes = await oc.send(
      `Call unbrowse_learn with harPath="${harPath}". Report the service name.`
    );
    expect(learnRes.status).toBe("ok");

    // Extract service name from response
    const serviceMatch = learnRes.text.match(/`(\w[\w-]*)`/)
      || learnRes.text.match(/(?:service|skill)[:\s]+[`"]?(\S+?)[`"]?[\s,.\n]/i)
      || learnRes.text.match(/(\w+app\w*)/i);
    const serviceName = serviceMatch?.[1] ?? "todoapp";

    // Step 2: Analyze
    const analyzeRes = await oc.send(
      `Call unbrowse_analyze with service="${serviceName}" and depth="deep". Show the full analysis.`
    );

    expect(analyzeRes.status).toBe("ok");
    expect(analyzeRes.text.length).toBeGreaterThan(50);
    expect(analyzeRes.text).toMatch(/entity|confidence|domain|analysis|auth/i);
  }, 120_000);
});

// ── Multi-turn conversation — learn then query ────────────────────────────

describe("multi-turn session", () => {
  it("maintains context across messages in same session", async () => {
    const oc = newHarness();
    const harPath = oc.writeHarFixture(loadFixtureRaw("todo-api"), "todo-api.har.json");

    // Turn 1: Learn
    const turn1 = await oc.send(`Call unbrowse_learn with harPath="${harPath}".`);
    expect(turn1.status).toBe("ok");

    // Turn 2: Ask about what was learned — agent has session context
    const turn2 = await oc.send(
      "What endpoints were in that skill you just generated? List them."
    );
    expect(turn2.status).toBe("ok");
    expect(turn2.text).toMatch(/GET|POST|todo|endpoint/i);
    expect(oc.history.length).toBe(2);
  }, 120_000);
});

// ── Token usage tracking ──────────────────────────────────────────────────

describe("usage tracking", () => {
  it("tracks token usage across messages", async () => {
    const oc = newHarness();
    await oc.send("Call unbrowse_skills. Just list them briefly.");

    const usage = oc.totalUsage();
    expect(usage.total).toBeGreaterThan(0);

    const meta = oc.history[0].response.meta;
    expect(meta.provider).toBeTruthy();
    expect(meta.model).toBeTruthy();
  }, 60_000);
});
