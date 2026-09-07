// The cli_timeout fix (#838): the outer resolve deadline must cover the orchestrator's
// live-capture ceiling so a cold capture isn't abandoned with a false cli_timeout.
import { describe, it, expect } from "bun:test";
import { computeResolveDeadlineMs } from "../src/resolve-deadline.js";

describe("computeResolveDeadlineMs (#838 false cli_timeout fix)", () => {
  it("floors at the live-capture ceiling (120s) + 20s margin, not budget+30s", () => {
    // default budget 8s → old code gave 38s; must now be 140s (covers live-capture).
    expect(computeResolveDeadlineMs(undefined, {})).toBe(140_000);
    expect(computeResolveDeadlineMs(8000, {})).toBe(140_000);
  });

  it("uses budget+30s only when it exceeds the live-capture floor", () => {
    // budget 200s + 30s = 230s > 140s floor → 230s.
    expect(computeResolveDeadlineMs(200_000, {})).toBe(230_000);
  });

  it("a mid budget still gets the floor (the false-timeout case)", () => {
    // budget 40s + 30s = 70s < 140s floor → floored to 140s (was the 70s false timeout).
    expect(computeResolveDeadlineMs(40_000, {})).toBe(140_000);
  });

  it("UNBROWSE_API_TIMEOUT_MS overrides everything", () => {
    expect(computeResolveDeadlineMs(8000, { UNBROWSE_API_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(computeResolveDeadlineMs(200_000, { UNBROWSE_API_TIMEOUT_MS: "5000" })).toBe(5000);
  });

  it("honors a configured live-capture ceiling", () => {
    // ceiling 60s → floor 80s.
    expect(computeResolveDeadlineMs(8000, { UNBROWSE_LIVE_CAPTURE_TIMEOUT_MS: "60000" })).toBe(80_000);
  });

  it("ignores a non-numeric / zero override", () => {
    expect(computeResolveDeadlineMs(8000, { UNBROWSE_API_TIMEOUT_MS: "0" })).toBe(140_000);
    expect(computeResolveDeadlineMs(8000, { UNBROWSE_API_TIMEOUT_MS: "abc" })).toBe(140_000);
  });
});
