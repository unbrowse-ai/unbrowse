import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { AGENT_FRONT_DOOR_OUTPUT_BUDGET_BYTES, AGENT_PATH, compactAgentFrontDoorResult, convergeAgentFrontDoorResult } from "../src/agent-path.js";

describe("agent path convergence", () => {
  it("marks successful results complete without changing their value", () => {
    const result = convergeAgentFrontDoorResult(
      {
        trace: { success: true },
        result: { status: "ok", items: [1, 2], next_action: { command: "unbrowse execute --skill x --endpoint y" } },
      },
      { intent: "list items", url: "https://example.com/items" },
    );

    expect(result.result).toEqual({ status: "ok", items: [1, 2] });
    expect(result.agent_path).toEqual({ step: 1, status: "complete", primary: AGENT_PATH.cli.primary });
  });

  it("keeps the shipped skill on the same three commands", () => {
    const skill = readFileSync(new URL("../packages/skill/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain(`\`${AGENT_PATH.cli.primary}\``);
    expect(skill).toContain(`\`${AGENT_PATH.cli.auth}\``);
    expect(skill).toContain(`\`${AGENT_PATH.cli.capture}\``);
  });

  it("collapses multiple recovery suggestions to the first executable next step", () => {
    const result = convergeAgentFrontDoorResult(
      {
        trace: { success: false },
        result: {
          error: "low_quality_dom_extraction",
          next_step: {
            suggested_commands: [
              "# inspect the page",
              'unbrowse go --url "https://example.com"',
              "unbrowse snap",
            ],
          },
        },
      },
      { intent: "read title", url: "https://example.com" },
    );

    expect(result.next_step).toBe('unbrowse go --url "https://example.com"');
    expect(JSON.stringify(result)).not.toContain("suggested_commands");
    expect(result.agent_path).toMatchObject({
      step: "next_step",
      status: "recovery",
      then_retry_once: 'unbrowse "read title" --url "https://example.com"',
    });
  });

  it("synthesizes only the documented auth and capture recovery moves", () => {
    const auth = convergeAgentFrontDoorResult(
      { trace: { success: false }, result: { error: "auth_required", login_url: "https://example.com/login" } },
      { intent: "read account", url: "https://example.com/account" },
    );
    const miss = convergeAgentFrontDoorResult(
      { trace: { success: false }, result: { status: "no_match" } },
      { intent: "list items", url: "https://example.com/items" },
    );

    expect(auth.next_step).toBe('unbrowse auth "https://example.com/login"');
    expect(auth.agent_path).toMatchObject({ step: 2, status: "recovery" });
    expect(miss.next_step).toBe('unbrowse capture --url "https://example.com/items" --intent "list items"');
    expect(miss.agent_path).toMatchObject({ step: 3, status: "recovery" });
  });

  it("holds a policy-deferred shortlist instead of declaring step one complete", () => {
    const result = convergeAgentFrontDoorResult(
      {
        trace: { success: true },
        result: null,
        available_endpoints: [{ endpoint_id: "write", method: "POST" }],
        next_action: {
          command: "unbrowse execute --skill site --endpoint write --confirm-third-party-terms",
        },
      },
      { intent: "post the update", url: "https://example.com/compose" },
    );

    expect(result.next_step).toBe(
      "unbrowse execute --skill site --endpoint write --confirm-third-party-terms",
    );
    expect(result.agent_path).toMatchObject({
      step: "next_step",
      status: "recovery",
      then_retry_once: 'unbrowse "post the update" --url "https://example.com/compose"',
    });
  });
  it("keeps prose out of next_step and represents payment as a typed ask gate", () => {
    const result = convergeAgentFrontDoorResult(
      { trace: { success: false }, result: { error: "payment_required", next_step: "pay somebody somehow" } },
      { intent: "read paid report", url: "https://example.com/report" },
    );

    expect(result.next_step).toBeUndefined();
    expect(result.gate).toEqual({
      decision: "ask",
      reason: "Payment authorization is required; do not capture around the payment gate.",
    });
    expect(result.agent_path).toMatchObject({ step: "hold", status: "blocked" });
    expect(result.agent_path).not.toHaveProperty("then_retry_once");
  });

  it("emits next_step only when it is an executable unbrowse command", () => {
    const command = convergeAgentFrontDoorResult(
      { trace: { success: false }, result: { error: "miss", next_step: 'unbrowse capture --url "https://example.com" --intent "read"' } },
      { intent: "read", url: "https://example.com" },
    );
    const prose = convergeAgentFrontDoorResult(
      { trace: { success: false }, result: { error: "unknown", next_step: "inspect it manually" } },
      { intent: "read", url: "https://example.com" },
    );

    expect(command.next_step).toMatch(/^unbrowse(?:\s|$)/);
    expect(prose.next_step).toBeUndefined();
    expect(prose.gate).toMatchObject({ decision: "deny" });
  });


  it("projects one-call success into a compact task-shaped answer", () => {
    const compact = compactAgentFrontDoorResult({
      trace: { success: true, trace_id: "t1", skill_id: "s1" },
      result: {
        items: [{ title: "Story", points: 42, url: "https://example.com/story" }],
        text: "x".repeat(50_000),
        markdown: "y".repeat(50_000),
        diagnostic: { candidates: Array.from({ length: 100 }, (_, i) => i) },
      },
      source: "route-cache",
      skill: { endpoints: Array.from({ length: 100 }, (_, i) => i) },
      agent_path: { step: 1, status: "complete" },
    }, { intent: "top stories with point counts", url: "https://news.ycombinator.com" });

    expect(compact.items).toEqual([{ title: "Story", points: 42, url: "https://example.com/story" }]);
    expect(compact).not.toHaveProperty("skill");
    expect(compact).not.toHaveProperty("text");
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(AGENT_FRONT_DOOR_OUTPUT_BUDGET_BYTES);
    expect(compact.provenance).toEqual({ trace_id: "t1", skill_id: "s1" });
  });

  it("keeps an arbitrary direct-fetch result even when guidance is present", () => {
    const compact = compactAgentFrontDoorResult({
      ok: true,
      source: "direct-fetch",
      result: { books: [{ name: "The Princess and the Queen" }] },
      suggested_next_actions: [{ command: "unbrowse capture --url x --intent y", why: "more" }],
    }, { intent: "list books", url: "https://example.com/api/books" });

    expect(compact.result).toEqual({ books: [{ name: "The Princess and the Queen" }] });
    expect(compact.suggested_next_actions).toHaveLength(1);
  });

  it("enforces the byte budget for large arbitrary result objects", () => {
    const compact = compactAgentFrontDoorResult({
      ok: true,
      source: "direct-fetch",
      result: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`key${index}`, "x".repeat(8_000)])),
    }, { intent: "read large object", url: "https://example.com/data" });
    expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThanOrEqual(AGENT_FRONT_DOOR_OUTPUT_BUDGET_BYTES);
    expect(compact.truncated).toBe(true);
    expect(compact.full_output).toContain("--raw");
  });

  it("enforces the byte budget even when recovery metadata is adversarially large", () => {
    const hugeObject = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`key${index}`, "x".repeat(8_000)]));
    const compact = compactAgentFrontDoorResult({
      ok: false,
      error: "e".repeat(8_000),
      status: "s".repeat(8_000),
      message: "m".repeat(8_000),
      next_step: `unbrowse ${"n".repeat(8_000)}`,
      gate: hugeObject,
      agent_path: hugeObject,
    }, { intent: "i".repeat(8_000), url: `https://example.com/${"u".repeat(8_000)}` });
    expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThanOrEqual(AGENT_FRONT_DOOR_OUTPUT_BUDGET_BYTES);
    expect(compact.truncated).toBe(true);
  });

});
