/**
 * Witness: layer 3 of the confidence-ledger-confidence stack is WIRED into the live ranker.
 *
 * The lever: "layers 2-3 are the experiment and the roadmap, not yet a fitted
 * network." This proves layer 3 is no longer just an offline experiment — the
 * learned learned ranking head, fit by (internal tooling) and shipped
 * as a content-addressed pointer, is loaded and scored by the production ranker
 * signal src/ranking/signals/learned-confidence.ts.
 *
 * No mocks (per CLAUDE.md): we run the REAL python trainer to ship a real head
 * pointer, then call the REAL learnedConfidence() loader and assert it (a) loads the
 * weights, (b) ranks a genuinely good route (exa + ep0 — true quality ~0.85)
 * above a genuinely bad one (direct-fetch + ep5 — true quality ~0.35), the
 * generative structure the head was trained to recover, and (c) fails closed to
 * null when the head is disabled.
 */
import { test, expect, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { learnedConfidence, __resetLearnedCache } from "../src/ranking/signals/learned-confidence.js";

const REPO = join(import.meta.dir, "..");

beforeAll(() => {
  // Ship the witness head from the deterministic synthetic ledger. It lands in the
  // SYNTHETIC pointer (never the live ranking-head.latest.json), so we point the loader
  // at it and allow synthetic explicitly — the production ranker would refuse it.
  const r = spawnSync("python3", ["(internal tooling)", "--quiet"], { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`layer3_train failed: ${r.stderr || r.stdout}`);
  process.env.UNBROWSE_RANKING_HEAD = join(REPO, "(internal tooling)");
  process.env.UNBROWSE_RANKING_ALLOW_SYNTHETIC = "1";
  __resetLearnedCache();
});

test("learned head ships and loads", () => {
  expect(existsSync(join(REPO, "(internal tooling)"))).toBe(true);
  const e = learnedConfidence("d3.com", "ep0", "exa", "task about search on d3.com");
  expect(e).not.toBeNull();
  expect(e!).toBeGreaterThan(0);
  expect(e!).toBeLessThan(1);
});

test("learned head ranks a good route above a bad route", () => {
  const good = learnedConfidence("d3.com", "ep0", "exa", "task about search on d3.com")!;
  const bad = learnedConfidence("d3.com", "ep5", "direct-fetch", "task about search on d3.com")!;
  expect(good).toBeGreaterThan(bad);
  // the gap should be material (the head recovered source/endpoint quality)
  expect(good - bad).toBeGreaterThan(0.1);
});

test("live ranker call site passes intent into routeConfidence (dead-feature regression guard)", () => {
  // The dropped-intent bug: src/execution/index.ts called routeConfidence(domain, ep, source)
  // without intent, so the head's n-gram features were always zero. This asserts the
  // 4th argument (intent) is present — if it is ever dropped again, this fails.
  const src = readFileSync(join(REPO, "src/execution/index.ts"), "utf8");
  expect(src).toMatch(/routeConfidence\([^)]*,\s*intent\s*\)/);
});

test("trainer reads intent from the real trace key (goal), not a phantom key", () => {
  // The runtime records intent under "goal" (telemetry.ts emitRouteTrace); the trainer
  // must accept either key or every real row has empty intent.
  const py = readFileSync(join(REPO, "(internal tooling)"), "utf8");
  expect(py).toMatch(/r\.get\("intent"\)\s*or\s*r\.get\("goal"/);
});

test("fails closed to null when disabled", () => {
  const prev = process.env.UNBROWSE_LEARNED_CONFIDENCE;
  process.env.UNBROWSE_LEARNED_CONFIDENCE = "0";
  __resetLearnedCache();
  expect(learnedConfidence("d3.com", "ep0", "exa", "x")).toBeNull();
  if (prev === undefined) delete process.env.UNBROWSE_LEARNED_CONFIDENCE;
  else process.env.UNBROWSE_LEARNED_CONFIDENCE = prev;
  __resetLearnedCache();
});
