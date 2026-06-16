/**
 * Failing-first witness (Matt 7:24-25) for the free, zero-setup tier — the two
 * PURE decision kernels the Day-5 wiring grows from, testable with no network
 * and no destruction (unlike the full register-anon path, which the 426 gate +
 * fixed config path block from deterministic prod testing).
 *
 *  - firstMintDecision(): WHEN to silently mint a free anon key (headless only).
 *  - searchToShortlist(): remap the anonymous `/v1/search` {results} envelope
 *    into resolve's {domain_results, global_results} shortlist shape (the floor).
 *
 * Both functions do not exist yet — this is sown RED on purpose. Day 5 adds them
 * (src/client/index.ts + src/cli-v7/eval/resolve.ts) and this goes green.
 */
import { test, expect } from "bun:test";
import { firstMintDecision } from "../src/client/index.ts";
import { searchToShortlist } from "../src/cli-v7/eval/resolve.ts";

test("firstMintDecision: silently mint a free anon key ONLY when headless + no key + no identity", () => {
  // Headless fresh machine: the whole point — provision invisibly, for free.
  expect(firstMintDecision({ headless: true, hasUsableKey: false, hasIdentity: false })).toBe(true);
  // Interactive fresh machine: a human is present — defer to onboarding, do NOT
  // silently accept ToS / mint on their behalf.
  expect(firstMintDecision({ headless: false, hasUsableKey: false, hasIdentity: false })).toBe(false);
  // Already holds a usable key: never mint.
  expect(firstMintDecision({ headless: true, hasUsableKey: true, hasIdentity: false })).toBe(false);
  // Has a prior identity: that is the refresh path, not first-mint.
  expect(firstMintDecision({ headless: true, hasUsableKey: false, hasIdentity: true })).toBe(false);
});

test("searchToShortlist: remap anonymous /v1/search {results} into resolve's shortlist shape", () => {
  const out = searchToShortlist([{ id: "a", score: 0.9 }, { id: "b", score: 0.5 }]);
  expect(out.domain_results).toEqual([]);
  expect(out.global_results).toEqual([{ id: "a", score: 0.9 }, { id: "b", score: 0.5 }]);
  // Tolerate empty / non-array input — never throw, just an empty shortlist.
  expect(searchToShortlist(undefined as unknown as []).global_results).toEqual([]);
});
