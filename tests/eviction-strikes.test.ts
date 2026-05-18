// FALSIFIER for the 2-strike local eviction policy.
//
// Pre-2026-05-19: every 404 → immediate eviction. Single-strike policy
// killed callable sibling endpoints during 404-recovery flows
// (bench-gate probe 003 crates.io).
// Post-fix: 404 increments a strike counter, evict only on the 2nd
// strike inside a 5-minute window. 410 Gone still evicts immediately
// because the protocol-level "gone for good" semantic is unambiguous.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  recordEndpointStrike,
  clearEndpointStrikes,
  _resetStrikesForTests,
  STRIKE_THRESHOLD_FOR_TESTS,
  STRIKE_WINDOW_MS_FOR_TESTS,
} from "../src/client/eviction-strikes";

beforeEach(() => _resetStrikesForTests());
afterEach(() => _resetStrikesForTests());

describe("recordEndpointStrike: 2-strike local eviction policy", () => {
  test("first 404 strike does NOT trigger eviction", () => {
    const out = recordEndpointStrike("skill_A", "ep_1");
    expect(out.shouldEvict).toBe(false);
    expect(out.strikes).toBe(1);
  });

  test("second 404 strike inside the window DOES trigger eviction", () => {
    recordEndpointStrike("skill_A", "ep_1");
    const out = recordEndpointStrike("skill_A", "ep_1");
    expect(out.shouldEvict).toBe(true);
    expect(out.strikes).toBe(STRIKE_THRESHOLD_FOR_TESTS);
  });

  test("clearEndpointStrikes resets the counter (success between strikes)", () => {
    recordEndpointStrike("skill_A", "ep_1");
    clearEndpointStrikes("skill_A", "ep_1");
    const out = recordEndpointStrike("skill_A", "ep_1");
    expect(out.shouldEvict).toBe(false);
    expect(out.strikes).toBe(1);
  });

  test("strikes are scoped per (skill, endpoint) — one ep's strike does not bleed to a sibling", () => {
    recordEndpointStrike("skill_A", "ep_1");
    const out = recordEndpointStrike("skill_A", "ep_2");
    expect(out.shouldEvict).toBe(false);
    expect(out.strikes).toBe(1);
  });

  test("strikes are scoped per skill — same endpoint id under different skill is independent", () => {
    recordEndpointStrike("skill_A", "ep_shared");
    const out = recordEndpointStrike("skill_B", "ep_shared");
    expect(out.shouldEvict).toBe(false);
    expect(out.strikes).toBe(1);
  });

  test("strikes are scoped per client_scope (multi-tenant isolation)", () => {
    recordEndpointStrike("skill_A", "ep_1", "tenant_x");
    const out = recordEndpointStrike("skill_A", "ep_1", "tenant_y");
    expect(out.shouldEvict).toBe(false);
    expect(out.strikes).toBe(1);
  });

  test("after eviction triggers, the counter resets so a re-published endpoint starts fresh", () => {
    recordEndpointStrike("skill_A", "ep_1");
    const evicted = recordEndpointStrike("skill_A", "ep_1");
    expect(evicted.shouldEvict).toBe(true);
    // Counter was dropped on eviction-threshold; subsequent strike is
    // strike 1 of a new window.
    const next = recordEndpointStrike("skill_A", "ep_1");
    expect(next.shouldEvict).toBe(false);
    expect(next.strikes).toBe(1);
  });

  test("strike window is 5 minutes (300000ms) — protocol contract pinned", () => {
    expect(STRIKE_WINDOW_MS_FOR_TESTS).toBe(5 * 60 * 1000);
    expect(STRIKE_THRESHOLD_FOR_TESTS).toBe(2);
  });
});

// Structural assertion: the execution-side caller distinguishes 410 (single-
// strike) from 404 (two-strike). If a future refactor collapses them, this
// fires.
describe("execution caller wires strikes for 404 but not for 410", () => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
describe("execution caller wires strikes for 404 but not for 410", () => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const src = readFileSync(join(import.meta.dir, "..", "src", "execution", "index.ts"), "utf8");

  // Anchor on the eviction-policy comment block so we don't match the
  // earlier `trace.error = … status === 404 ? …` ternary.
  const policyAnchor = "Stale-endpoint eviction.";
  const policyIdx = src.indexOf(policyAnchor);
  const policyBlock = policyIdx > 0 ? src.slice(policyIdx, policyIdx + 3000) : "";

  test("eviction-policy block exists in execution/index.ts", () => {
    expect(policyIdx).toBeGreaterThan(0);
  });

  test("404 sub-branch within the eviction-policy block calls recordEndpointStrike", () => {
    // Within the eviction-policy block, the 404 arm should invoke
    // the strike helper, not direct eviction.
    const arm404Idx = policyBlock.indexOf("status === 404");
    expect(arm404Idx).toBeGreaterThan(0);
    const arm404 = policyBlock.slice(arm404Idx, arm404Idx + 800);
    expect(arm404).toContain("recordEndpointStrike");
  });

  test("410 sub-branch within the eviction-policy block evicts immediately (no strike helper)", () => {
    // Carve out just the 410 arm — from `if (status === 410)` to the
    // `} else if` boundary.
    const arm410Idx = policyBlock.indexOf("status === 410");
    expect(arm410Idx).toBeGreaterThan(0);
    const boundary = policyBlock.indexOf("} else if", arm410Idx);
    expect(boundary).toBeGreaterThan(arm410Idx);
    const arm410 = policyBlock.slice(arm410Idx, boundary);
    expect(arm410).toContain("evictCachedEndpoint");
    expect(arm410).not.toContain("recordEndpointStrike");
  });

  test("success branch clears strikes (so transient flapping endpoints don't accumulate)", () => {
    expect(src).toContain("clearEndpointStrikes(skill.skill_id, endpoint.endpoint_id, options?.client_scope)");
  });
});
});
