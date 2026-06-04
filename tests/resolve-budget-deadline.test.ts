import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runResolveRace } from "../src/orchestrator/resolve-race.js";
import type { SkillManifest } from "../src/types/index.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("runResolveRace integration (deterministic via test seams)", () => {
  it("returns no_match (winner: null) when all racers slow past deadline", async () => {
    const t0 = Date.now();
    const r = await runResolveRace({
      contextUrl: "https://example.com/foo",
      intent: "fetch foo",
      params: {},
      budgetMs: 80,
      probeOverride: async () => { await sleep(500); return { status: 200, content_type: "application/json" }; },
    });
    const elapsed = Date.now() - t0;
    expect(r.winner).toBeNull();
    expect(elapsed).toBeLessThan(200);
    expect(r.tried.find((t) => t.name === "probe")?.status).toBe("deadline");
  });

  it("probe wins when no recipe + no skill_id + URL is fetchable", async () => {
    const r = await runResolveRace({
      contextUrl: "https://example.com/foo",
      intent: "fetch foo",
      params: {},
      budgetMs: 1000,
      probeOverride: async () => { await sleep(5); return { status: 200, content_type: "application/json", byte_length: 1234 }; },
    });
    expect(r.winner).not.toBeNull();
    expect(r.winner!.kind).toBe("probe");
  });

  it("probe loses when status is non-2xx (no winner if alone)", async () => {
    const r = await runResolveRace({
      contextUrl: "https://example.com/foo",
      intent: "fetch foo",
      params: {},
      budgetMs: 200,
      probeOverride: async () => ({ status: 404, content_type: "text/html" }),
    });
    expect(r.winner).toBeNull();
    const probe = r.tried.find((t) => t.name === "probe");
    expect(probe?.status).toBe("lost");
  });

  it("marketplace racer wins when skill_id known and lookup returns endpoints", async () => {
    const skill = {
      skill_id: "x",
      domain: "example.com",
      endpoints: [{ endpoint_id: "e1", method: "GET", url_template: "https://example.com/api/x" }],
    } as unknown as SkillManifest;
    const r = await runResolveRace({
      contextUrl: "https://example.com/foo",
      intent: "fetch x",
      params: {},
      budgetMs: 1000,
      knownSkillId: "x",
      marketplaceLookup: async () => skill,
      probeOverride: async () => { await sleep(200); return { status: 200, content_type: "text/html" }; },
    });
    expect(r.winner).not.toBeNull();
    expect(r.winner!.kind).toBe("marketplace");
  });

  it("marketplace racer loses when lookup returns empty endpoints", async () => {
    const r = await runResolveRace({
      contextUrl: "https://example.com/foo",
      intent: "fetch x",
      params: {},
      budgetMs: 400,
      knownSkillId: "x",
      marketplaceLookup: async () => ({ skill_id: "x", domain: "example.com", endpoints: [] } as unknown as SkillManifest),
      probeOverride: async () => { await sleep(200); return { status: 500, content_type: "text/html" }; },
    });
    expect(r.winner).toBeNull();
    expect(r.tried.find((t) => t.name === "marketplace")?.status).toBe("lost");
  });

  it("budget honored within ±100ms when no racer can finish", async () => {
    const t0 = Date.now();
    const r = await runResolveRace({
      contextUrl: "https://example.com/foo",
      intent: "fetch foo",
      params: {},
      budgetMs: 100,
      probeOverride: async () => { await sleep(2000); return { status: 200, content_type: "application/json" }; },
    });
    const elapsed = Date.now() - t0;
    expect(r.winner).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(250);
  });
});
