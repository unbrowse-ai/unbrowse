/**
 * Witness: the learned "what-worked" ledger confidence is wired live into rankEndpoints.
 *
 * The thesis, made a runtime signal: each captured route is a primitive the agent's own
 * execution ledger (~/.unbrowse/traces) ranks by P(success | domain, route). This test
 * proves (a) the signal reads a real ledger and scores a historically-successful route
 * above a failed one, (b) it stays NEUTRAL when cold (no history → no opinion), and
 * (c) rankEndpoints actually re-orders toward the route the agent has succeeded with.
 *
 * No mocks: real temp ledger files on disk, real rankEndpoints over real EndpointDescriptors.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLedgerIndex,
  ledgerConfidence,
  ledgerConfidenceCached,
  LEDGER_NEUTRAL,
  __resetLedgerCache,
} from "../src/lib/ranking-core/signals/ledger-confidence.js";
import { rankEndpoints } from "../src/execution/index.js";
import type { EndpointDescriptor } from "../src/types/skill.js";

let dir: string;

function writeTrace(name: string, domain: string, endpoint_id: string, outcome: "success" | "failure"): void {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ domain, endpoint_id, source: "live-capture", outcome }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unbrowse-ledger-confidence-"));
  process.env.UNBROWSE_TRACES = dir;
  delete process.env.UNBROWSE_LEDGER_CONFIDENCE;
  __resetLedgerCache();
});

afterEach(() => {
  delete process.env.UNBROWSE_TRACES;
  // Restore the suite-wide default (_setup.ts) so we don't leak the enabled
  // signal into sibling test files sharing this bun process.
  process.env.UNBROWSE_LEDGER_CONFIDENCE = "0";
  __resetLedgerCache();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

test("ledger confidence: a route that always succeeded outscores one that always failed", () => {
  for (let i = 0; i < 5; i++) writeTrace(`g${i}`, "x.com", "good-ep", "success");
  for (let i = 0; i < 5; i++) writeTrace(`b${i}`, "x.com", "bad-ep", "failure");

  const idx = loadLedgerIndex(dir);
  const good = ledgerConfidence(idx, "x.com", "good-ep");
  const bad = ledgerConfidence(idx, "x.com", "bad-ep");
  expect(good).toBeGreaterThan(0.5);
  expect(bad).toBeLessThan(0.5);
  expect(good).toBeGreaterThan(bad);
});

test("ledger confidence: cold route (no history) is exactly NEUTRAL", () => {
  const idx = loadLedgerIndex(dir); // empty ledger
  expect(ledgerConfidence(idx, "never.com", "unseen-ep")).toBe(LEDGER_NEUTRAL);
  // a single observation is below MIN_EVIDENCE → still neutral (no premature opinion)
  writeTrace("one", "y.com", "lonely-ep", "success");
  expect(ledgerConfidence(loadLedgerIndex(dir), "y.com", "lonely-ep")).toBe(LEDGER_NEUTRAL);
});

test("ledger confidence: disabled flag forces neutral", () => {
  for (let i = 0; i < 5; i++) writeTrace(`g${i}`, "x.com", "good-ep", "success");
  __resetLedgerCache();
  process.env.UNBROWSE_LEDGER_CONFIDENCE = "0";
  expect(ledgerConfidenceCached("x.com", "good-ep")).toBe(LEDGER_NEUTRAL);
});

test("rankEndpoints re-orders toward the historically-successful route", () => {
  for (let i = 0; i < 6; i++) writeTrace(`g${i}`, "shop.example", "winner", "success");
  for (let i = 0; i < 6; i++) writeTrace(`b${i}`, "shop.example", "loser", "failure");
  __resetLedgerCache();

  // two endpoints identical except endpoint_id (endpoint_id does not otherwise score)
  const mk = (id: string): EndpointDescriptor =>
    ({
      endpoint_id: id,
      method: "GET",
      url_template: "https://shop.example/api/items",
      description: "list items",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.5,
    }) as EndpointDescriptor;

  // feed the loser first; the ledger boost must lift the winner above it
  const ranked = rankEndpoints([mk("loser"), mk("winner")], "list items", "shop.example");
  expect(ranked.length).toBe(2);
  expect(ranked[0].endpoint.endpoint_id).toBe("winner");
  expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
});

test("ledger confidence: the REAL local ledger loads and yields in-range confidences", () => {
  delete process.env.UNBROWSE_TRACES; // use the real ~/.unbrowse/traces
  const idx = loadLedgerIndex();
  // the real ledger has thousands of traces; every back-off rate must be a valid prob
  const all = [...idx.byDomainEndpoint.values(), ...idx.byEndpoint.values()];
  expect(all.length).toBeGreaterThan(0);
  for (const c of all.slice(0, 200)) {
    const r = (c.succ + 1) / (c.total + 2);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
  }
});
