import { describe, expect, it } from "bun:test";
import { runResolveRace, type RaceWinnerProbe } from "../src/orchestrator/resolve-race.js";

// Truth-telling gap regression: probeUrl already declares
// `method_used: "HEAD" | "GET-1byte"` on its return type. The resolve-race
// wrapper used to truncate the field, so the orchestrator's no_match emit
// path could not surface whether the probe HEAD succeeded or fell back to
// the ranged-GET branch. Both signals are diagnostic for the agent when it
// is deciding whether to retry the URL, escalate to capture, or trust the
// probe's content-type verdict.
//
// This file pins the contract: when the probe wins the race, the returned
// RaceWinnerProbe carries the method_used value the probe layer reported.

describe("runResolveRace propagates probe.method_used to RaceWinnerProbe", () => {
  it("carries method_used: HEAD when the HEAD branch settles the probe", async () => {
    const r = await runResolveRace({
      contextUrl: "https://api.example.com/posts",
      intent: "list posts",
      params: {},
      budgetMs: 1000,
      probeOverride: async () => ({
        status: 200,
        content_type: "application/json; charset=utf-8",
        byte_length: 4321,
        method_used: "HEAD",
      }),
    });

    expect(r.winner).not.toBeNull();
    expect(r.winner!.kind).toBe("probe");
    const probeWinner = r.winner as RaceWinnerProbe;
    expect(probeWinner.method_used).toBe("HEAD");
  });

  it("carries method_used: GET-1byte when the ranged-GET fallback settles the probe", async () => {
    const r = await runResolveRace({
      contextUrl: "https://chunked-api.example.com/items",
      intent: "list items",
      params: {},
      budgetMs: 1000,
      probeOverride: async () => ({
        status: 200,
        content_type: "application/json",
        // byte_length absent: HEAD rejected with 405, GET-1byte fired and
        // returned a content-type but the server omitted Content-Range
        // (chunked transfer encoding). method_used still carries the truth.
        method_used: "GET-1byte",
      }),
    });

    expect(r.winner).not.toBeNull();
    expect(r.winner!.kind).toBe("probe");
    const probeWinner = r.winner as RaceWinnerProbe;
    expect(probeWinner.method_used).toBe("GET-1byte");
  });

  it("leaves method_used undefined when the override omits it (backward compat)", async () => {
    const r = await runResolveRace({
      contextUrl: "https://api.example.com/posts",
      intent: "list posts",
      params: {},
      budgetMs: 1000,
      probeOverride: async () => ({
        status: 200,
        content_type: "application/json",
        byte_length: 100,
      }),
    });

    expect(r.winner).not.toBeNull();
    expect(r.winner!.kind).toBe("probe");
    const probeWinner = r.winner as RaceWinnerProbe;
    expect(probeWinner.method_used).toBeUndefined();
  });
});
