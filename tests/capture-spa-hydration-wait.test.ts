import { describe, expect, it } from "bun:test";
import {
  isNonShellHydratedDom,
  shouldStopHydrationWait,
  type HydrationProbeSnapshot,
} from "../src/capture/index.js";

function snap(overrides: Partial<HydrationProbeSnapshot>): HydrationProbeSnapshot {
  return {
    textLength: 0,
    meaningfulElementCount: 0,
    mutationCount: 0,
    resourceCount: 0,
    hasSpaMarker: true,
    ...overrides,
  };
}

describe("generic SPA hydration wait primitives", () => {
  it("treats substantial body text as hydrated, not a shell", () => {
    expect(isNonShellHydratedDom(snap({ textLength: 240 }))).toBe(true);
    expect(isNonShellHydratedDom(snap({ textLength: 80, meaningfulElementCount: 3 }))).toBe(true);
    expect(isNonShellHydratedDom(snap({ textLength: 80, meaningfulElementCount: 1 }))).toBe(false);
  });

  it("keeps waiting while mutations or resource counts are still advancing", () => {
    const previous = snap({ textLength: 20, mutationCount: 1, resourceCount: 4 });
    expect(shouldStopHydrationWait(previous, snap({ textLength: 20, mutationCount: 2, resourceCount: 4 }), 200)).toBe(false);
    expect(shouldStopHydrationWait(previous, snap({ textLength: 20, mutationCount: 1, resourceCount: 5 }), 200)).toBe(false);
  });

  it("settles after a shell-like SPA has made progress and then gone quiet", () => {
    const previous = snap({ textLength: 20, mutationCount: 3, resourceCount: 8 });
    const current = snap({ textLength: 20, mutationCount: 3, resourceCount: 8 });
    expect(shouldStopHydrationWait(previous, current, 99)).toBe(false);
    expect(shouldStopHydrationWait(previous, current, 100)).toBe(true);
  });
});
