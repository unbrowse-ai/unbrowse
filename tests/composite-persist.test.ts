/**
 * composite-persist.test — lever 3 of the contract-ledger (internal/composition-persist-replay-plan.md).
 *
 * When a multi-step resolve satisfies a target by walking a prerequisite DAG, the walked composite
 * is persisted as a content-addressed descriptor so a later resolve for the same intent can REPLAY
 * the DAG (lever 4) instead of re-walking it. The load-bearing properties this witness proves:
 *   1. round-trip — writeComposite → readComposite returns {target, steps, edges} verbatim.
 *   2. deterministic address — the same (intent, domain, ordered steps, edges) yields the SAME
 *      composite_id, so a second identical resolve hits the same persisted descriptor.
 *   3. address sensitivity — changing the step order or the intent changes the id (no false reuse).
 *   4. gate — persistence is OFF unless UNBROWSE_LOCAL_CACHES=1 (composites are local caches that
 *      can go stale like the routes they compose; the backend graph stays source of truth).
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compositeAddress,
  compositeLookupKey,
  writeComposite,
  readComposite,
  planPrereqOrder,
  type ChainStepInfo,
  type CompositeEdge,
  type PersistedComposite,
} from "../src/orchestrator/index.js";

const DOMAIN = "news.ycombinator.com";
const TARGET = "get_comments";

const steps: ChainStepInfo[] = [
  { endpoint_id: "search", ok: true, yielded: ["story_id"] },
  { endpoint_id: "get_item", ok: true, yielded: ["author"] },
];
const edges: CompositeEdge[] = [
  { from: "search", binding: "story_id", to: "get_comments" },
  { from: "get_item", binding: "author", to: "get_comments" },
];

let dir: string;
const prevCaches = process.env.UNBROWSE_LOCAL_CACHES;
const prevDir = process.env.UNBROWSE_COMPOSITE_DIR;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "unbrowse-composites-"));
  process.env.UNBROWSE_COMPOSITE_DIR = dir;
});
afterAll(() => {
  if (prevCaches === undefined) delete process.env.UNBROWSE_LOCAL_CACHES;
  else process.env.UNBROWSE_LOCAL_CACHES = prevCaches;
  if (prevDir === undefined) delete process.env.UNBROWSE_COMPOSITE_DIR;
  else process.env.UNBROWSE_COMPOSITE_DIR = prevDir;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("composite content-address (structural identity, intent-independent)", () => {
  it("yields the SAME id for the same domain/target/steps/edges", () => {
    const a = compositeAddress(DOMAIN, TARGET, steps, edges);
    const b = compositeAddress(DOMAIN, TARGET, steps, edges);
    expect(a).toBe(b);
    expect(a).toMatch(/^composite:[0-9a-f]{32}$/);
  });

  it("changes the id when the step order changes (a different DAG)", () => {
    const a = compositeAddress(DOMAIN, TARGET, steps, edges);
    const b = compositeAddress(DOMAIN, TARGET, [steps[1], steps[0]], edges);
    expect(a).not.toBe(b);
  });

  it("changes the id when the target endpoint changes", () => {
    const a = compositeAddress(DOMAIN, TARGET, steps, edges);
    const b = compositeAddress(DOMAIN, "get_item", steps, edges);
    expect(a).not.toBe(b);
  });

  it("the replay lookup key depends only on domain + target (known pre-walk)", () => {
    const a = compositeLookupKey(DOMAIN, TARGET);
    const b = compositeLookupKey(DOMAIN, TARGET);
    expect(a).toBe(b);
    expect(a).toMatch(/^lookup:[0-9a-f]{32}$/);
    expect(compositeLookupKey(DOMAIN, "get_item")).not.toBe(a);
  });
});

describe("composite persistence gate", () => {
  it("does NOT write when UNBROWSE_LOCAL_CACHES is off (backend stays source of truth)", () => {
    delete process.env.UNBROWSE_LOCAL_CACHES;
    const id = compositeAddress("example.com", TARGET, steps, edges);
    const path = writeComposite({
      composite_id: id,
      intent_signature: "gated",
      domain: "example.com",
      target: TARGET,
      steps,
      edges,
      created_at: "2026-06-14T00:00:00.000Z",
    });
    expect(path).toBeUndefined();
    expect(readComposite("example.com", TARGET)).toBeUndefined();
  });
});

describe("composite round-trip (write → read by pre-walk lookup key)", () => {
  it("persists under the gate and reads back {target, steps, edges} verbatim", () => {
    process.env.UNBROWSE_LOCAL_CACHES = "1";
    const id = compositeAddress(DOMAIN, TARGET, steps, edges);
    const descriptor = {
      composite_id: id,
      intent_signature: "top hn comments",
      domain: DOMAIN,
      target: TARGET,
      steps,
      edges,
      created_at: "2026-06-14T00:00:00.000Z",
    };
    const path = writeComposite(descriptor);
    expect(path).toBeDefined();
    expect(existsSync(path!)).toBe(true);

    // replay finds it by (domain, target) — what a later resolve knows before walking
    const round = readComposite(DOMAIN, TARGET);
    expect(round).toBeDefined();
    expect(round!.composite_id).toBe(id);
    expect(round!.target).toBe(TARGET);
    expect(round!.steps).toEqual(steps);
    expect(round!.edges).toEqual(edges);
    expect(round!.domain).toBe(DOMAIN);
  });

  it("a second resolve with a DIFFERENT intent phrasing still finds the same composite", () => {
    process.env.UNBROWSE_LOCAL_CACHES = "1";
    // the structure is the target endpoint's property; phrasing is irrelevant to the lookup
    const round = readComposite(DOMAIN, TARGET);
    expect(round).toBeDefined();
    expect(round!.steps.map((s) => s.endpoint_id)).toEqual(["search", "get_item"]);
  });

  it("returns undefined for an unknown (domain, target) pair (clean miss → full recompute)", () => {
    expect(readComposite("unknown.example", "no_such_target")).toBeUndefined();
  });
});

describe("composite replay decision (lever 4 — known-good order, guarded fallback)", () => {
  const persisted: PersistedComposite = {
    composite_id: compositeAddress(DOMAIN, TARGET, steps, edges),
    intent_signature: "top hn comments",
    domain: DOMAIN,
    target: TARGET,
    steps,
    edges,
    created_at: "2026-06-14T00:00:00.000Z",
  };
  const allReplayable = () => true;

  it("replays the recorded step order when every constituent is still replayable", () => {
    const d = planPrereqOrder([], persisted, allReplayable);
    expect(d.prereqOrder).toEqual(["search", "get_item"]);
    expect(d.replayedCompositeId).toBe(persisted.composite_id);
  });

  it("merges extra live-advisory prereqs after the recorded order, deduped", () => {
    const d = planPrereqOrder(["get_item", "extra_prereq"], persisted, allReplayable);
    expect(d.prereqOrder).toEqual(["search", "get_item", "extra_prereq"]);
    expect(d.replayedCompositeId).toBe(persisted.composite_id);
  });

  it("falls back to the live order (no replay) when a constituent is now non-replayable", () => {
    // e.g. a recorded step is now an irreversible op, or was removed from the skill
    const guard = (id: string) => id !== "get_item";
    const d = planPrereqOrder(["search"], persisted, guard);
    expect(d.prereqOrder).toEqual(["search"]);
    expect(d.replayedCompositeId).toBeUndefined();
  });

  it("uses the live order when no composite is persisted (clean miss)", () => {
    const d = planPrereqOrder(["search", "get_item"], undefined, allReplayable);
    expect(d.prereqOrder).toEqual(["search", "get_item"]);
    expect(d.replayedCompositeId).toBeUndefined();
  });

  it("does not replay an empty-steps composite", () => {
    const empty = { ...persisted, steps: [] };
    const d = planPrereqOrder(["live"], empty, allReplayable);
    expect(d.prereqOrder).toEqual(["live"]);
    expect(d.replayedCompositeId).toBeUndefined();
  });

  it("end-to-end: persist a walk, then replay finds it and seeds the recorded order", () => {
    process.env.UNBROWSE_LOCAL_CACHES = "1";
    writeComposite(persisted);
    // a later resolve looks up by (domain, target), gets the composite, plans the order
    const found = readComposite(DOMAIN, TARGET);
    expect(found).toBeDefined();
    const d = planPrereqOrder([], found, allReplayable);
    expect(d.prereqOrder).toEqual(["search", "get_item"]);
    expect(d.replayedCompositeId).toBe(persisted.composite_id);
  });
});
