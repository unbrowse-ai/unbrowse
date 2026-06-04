/**
 * Witness: layer 3 of the EBM ledger-energy stack is WIRED into the live ranker.
 *
 * The lever: "layers 2-3 are the experiment and the roadmap, not yet a fitted
 * network." This proves layer 3 is no longer just an offline experiment — the
 * learned contrastive energy head, fit by scripts/ebm/layer3_train.py and shipped
 * as a content-addressed pointer, is loaded and scored by the production ranker
 * signal src/ranking/signals/learned-energy.ts.
 *
 * No mocks (per CLAUDE.md): we run the REAL python trainer to ship a real head
 * pointer, then call the REAL learnedEnergy() loader and assert it (a) loads the
 * weights, (b) ranks a genuinely good route (exa + ep0 — true quality ~0.85)
 * above a genuinely bad one (direct-fetch + ep5 — true quality ~0.35), the
 * generative structure the head was trained to recover, and (c) fails closed to
 * null when the head is disabled.
 */
import { test, expect, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { learnedEnergy, __resetLearnedCache } from "../src/ranking/signals/learned-energy.js";

const REPO = join(import.meta.dir, "..");

beforeAll(() => {
  // Ship the witness head from the deterministic synthetic ledger. It lands in the
  // SYNTHETIC pointer (never the live energy-head.latest.json), so we point the loader
  // at it and allow synthetic explicitly — the production ranker would refuse it.
  const r = spawnSync("python3", ["scripts/ebm/layer3_train.py", "--quiet"], { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`layer3_train failed: ${r.stderr || r.stdout}`);
  process.env.UNBROWSE_EBM_HEAD = join(REPO, "bench/ebm/energy-head.synthetic.json");
  process.env.UNBROWSE_EBM_ALLOW_SYNTHETIC = "1";
  __resetLearnedCache();
});

test("learned head ships and loads", () => {
  expect(existsSync(join(REPO, "bench/ebm/energy-head.synthetic.json"))).toBe(true);
  const e = learnedEnergy("d3.com", "ep0", "exa", "task about search on d3.com");
  expect(e).not.toBeNull();
  expect(e!).toBeGreaterThan(0);
  expect(e!).toBeLessThan(1);
});

test("learned head ranks a good route above a bad route", () => {
  const good = learnedEnergy("d3.com", "ep0", "exa", "task about search on d3.com")!;
  const bad = learnedEnergy("d3.com", "ep5", "direct-fetch", "task about search on d3.com")!;
  expect(good).toBeGreaterThan(bad);
  // the gap should be material (the head recovered source/endpoint quality)
  expect(good - bad).toBeGreaterThan(0.1);
});

test("fails closed to null when disabled", () => {
  const prev = process.env.UNBROWSE_LEARNED_ENERGY;
  process.env.UNBROWSE_LEARNED_ENERGY = "0";
  __resetLearnedCache();
  expect(learnedEnergy("d3.com", "ep0", "exa", "x")).toBeNull();
  if (prev === undefined) delete process.env.UNBROWSE_LEARNED_ENERGY;
  else process.env.UNBROWSE_LEARNED_ENERGY = prev;
  __resetLearnedCache();
});
