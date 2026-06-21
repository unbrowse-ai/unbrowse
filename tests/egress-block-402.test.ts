/**
 * Witness: egressChain treats 402 Payment Required as a DEAD tier (escalate), not a served body.
 * An exhausted/unfunded residential-proxy account returns 402 (witnessed live against iProyal,
 * 2026-06-21); the old isBlock (0/401/403/429/≥500) would have mistaken that 402 page for the
 * answer and stopped escalating. Pinned deterministically — no network.
 */
import { test, expect } from "bun:test";
import { isBlock } from "../src/execution/egress-chain.js";

test("402 Payment Required is a dead-egress block (the live iProyal-exhausted case)", () => {
  expect(isBlock(402)).toBe(true);
});

test("the rest of the dead set is unchanged", () => {
  for (const s of [0, 401, 403, 429, 500, 503]) expect(isBlock(s)).toBe(true);
});

test("served / legitimate statuses are NOT blocks (no needless escalation)", () => {
  for (const s of [200, 201, 204, 301, 304, 400, 404]) expect(isBlock(s)).toBe(false);
});
