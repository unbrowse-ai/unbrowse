/**
 * Witness: the internal-API replay-fetch egress escalation is gated by the idempotency firmament.
 * A blocked READ (GET/HEAD) climbs the egress ladder; a blocked WRITE NEVER does — re-issuing a
 * blocked-looking POST/PUT/PATCH/DELETE could double-apply a mutation the first call already
 * committed server-side. This pins that safety property deterministically (no live network).
 */
import { test, expect } from "bun:test";
import { shouldEscalateBlockedReplay } from "../src/execution/index.js";

const BLOCK = [0, 401, 402, 403, 429, 500, 503]; // 402 included — one classifier with egressChain.isBlock
const SERVED = [200, 201, 204, 301, 400, 404];

test("a blocked READ escalates — GET/HEAD on a block status", () => {
  for (const s of BLOCK) {
    expect(shouldEscalateBlockedReplay("GET", s)).toBe(true);
    expect(shouldEscalateBlockedReplay("HEAD", s)).toBe(true);
    expect(shouldEscalateBlockedReplay("get", s)).toBe(true); // case-insensitive
  }
});

test("a WRITE never escalates — even on a block status (idempotency firmament)", () => {
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const s of BLOCK) {
      expect(shouldEscalateBlockedReplay(m, s)).toBe(false);
    }
  }
});

test("a non-blocked response never escalates — no needless re-fetch of a served READ", () => {
  for (const s of SERVED) {
    expect(shouldEscalateBlockedReplay("GET", s)).toBe(false);
  }
});

test("unknown/empty method defaults to GET semantics but only on a block", () => {
  expect(shouldEscalateBlockedReplay("", 403)).toBe(true);
  expect(shouldEscalateBlockedReplay("", 200)).toBe(false);
});
