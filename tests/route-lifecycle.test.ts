import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claimRoutePublishPermit,
  decideRouteLifecycleAction,
  executeRouteLifecycleInteraction,
  getRouteLifecycle,
  initialRouteLifecycleRecord,
  issueRoutePublishPermit,
  validateRoutePublishPermit,
  reduceRouteLifecycle,
  routeLifecycleKey,
  settleRoutePublishPermit,
  transitionRouteLifecycle,
  type RouteLifecycleIdentity,
} from "../src/runtime/route-lifecycle.js";

let dir: string;
let file: string;
const identity: RouteLifecycleIdentity = {
  principal_scope: "principal:test",
  skill_id: "skill-1",
  endpoint_fingerprint: "sha256:endpoint-a",
  intent_shape_hash: "sha256:intent-shape-a",
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "route-lifecycle-"));
  file = path.join(dir, "state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pure route lifecycle", () => {
  test("requires a browser witness before API success can validate", () => {
    const start = initialRouteLifecycleRecord(routeLifecycleKey(identity), "2026-01-01T00:00:00.000Z");
    const noWitness = reduceRouteLifecycle(start, {
      type: "api_validation_succeeded",
      at: "2026-01-01T00:00:01.000Z",
      baseline_fingerprint: "base-a",
    });
    expect(noWitness.state).toBe("discovered");
    expect(noWitness.api_validation_successes).toBe(0);
    expect(decideRouteLifecycleAction(start)).toBe("browser_discover");
    expect(decideRouteLifecycleAction(noWitness)).toBe("browser_discover");
  });

  test("cold observation, independent replay, then publication is ordered and idempotent", () => {
    const start = initialRouteLifecycleRecord(routeLifecycleKey(identity), "2026-01-01T00:00:00.000Z");
    const observed = reduceRouteLifecycle(start, {
      type: "browser_observed",
      at: "2026-01-01T00:00:01.000Z",
      baseline_fingerprint: "base-a",
      dag_fingerprint: "dag-a",
    });
    expect(observed.state).toBe("validation_pending");
    expect(decideRouteLifecycleAction(observed)).toBe("api_validate");

    const validated = reduceRouteLifecycle(observed, {
      type: "api_validation_succeeded",
      at: "2026-01-01T00:00:02.000Z",
      baseline_fingerprint: "base-a",
      dag_fingerprint: "dag-a",
    });
    expect(validated.state).toBe("validated");
    expect(validated.api_validation_successes).toBe(1);
    expect(decideRouteLifecycleAction(validated)).toBe("api_execute");

    const eligible = reduceRouteLifecycle(validated, { type: "publish_requested", artifact_fingerprint: "artifact-a", at: "2026-01-01T00:00:03.000Z" });
    expect(eligible.state).toBe("publish_eligible");
    const published = reduceRouteLifecycle(eligible, {
      type: "publish_succeeded",
      visibility: "shadow",
      artifact_fingerprint: "artifact-a",
      at: "2026-01-01T00:00:04.000Z",
    });
    expect(published.state).toBe("shadow_published");
    const duplicate = reduceRouteLifecycle(published, {
      type: "publish_succeeded",
      visibility: "shadow",
      artifact_fingerprint: "artifact-a",
      at: "2026-01-01T00:00:05.000Z",
    });
    expect(duplicate.published_at).toBe("2026-01-01T00:00:04.000Z");
  });

  test("mismatched parity cannot validate and repeated failures become stale", () => {
    const observed = reduceRouteLifecycle(initialRouteLifecycleRecord(routeLifecycleKey(identity)), {
      type: "browser_observed",
      baseline_fingerprint: "base-a",
      dag_fingerprint: "dag-a",
    });
    const mismatch = reduceRouteLifecycle(observed, {
      type: "api_validation_succeeded",
      baseline_fingerprint: "base-b",
      dag_fingerprint: "dag-a",
    });
    expect(mismatch.state).toBe("validation_pending");
    expect(mismatch.api_validation_successes).toBe(0);
    expect(mismatch.consecutive_failures).toBe(1);
    const stale = reduceRouteLifecycle(mismatch, { type: "api_validation_failed" });
    expect(stale.state).toBe("stale");
  });

  test("capture-only and failed routes cannot become publish eligible", () => {
    const observed = reduceRouteLifecycle(initialRouteLifecycleRecord(routeLifecycleKey(identity)), {
      type: "browser_observed",
      baseline_fingerprint: "base-a",
    });
    expect(reduceRouteLifecycle(observed, { type: "publish_requested", artifact_fingerprint: "artifact-a" }).state).toBe("validation_pending");
    const failed = reduceRouteLifecycle(observed, { type: "api_validation_failed" });
    expect(reduceRouteLifecycle(failed, { type: "publish_requested", artifact_fingerprint: "artifact-a" }).state).not.toBe("publish_eligible");
  });
});

describe("route lifecycle integrity edges", () => {
  test("cannot omit a stored DAG witness or regress public publication", () => {
    const observed = reduceRouteLifecycle(initialRouteLifecycleRecord(routeLifecycleKey(identity)), {
      type: "browser_observed", baseline_fingerprint: "base-a", dag_fingerprint: "dag-a",
    });
    const omittedDag = reduceRouteLifecycle(observed, {
      type: "api_validation_succeeded", baseline_fingerprint: "base-a",
    });
    expect(omittedDag.state).toBe("validation_pending");
    expect(omittedDag.api_validation_successes).toBe(0);
    const validated = reduceRouteLifecycle(observed, {
      type: "api_validation_succeeded", baseline_fingerprint: "base-a", dag_fingerprint: "dag-a",
    });
    const eligible = reduceRouteLifecycle(validated, { type: "publish_requested", artifact_fingerprint: "artifact-a" });
    const publicRecord = reduceRouteLifecycle(eligible, {
      type: "publish_succeeded", visibility: "public", artifact_fingerprint: "artifact-a",
    });
    const attemptedRegression = reduceRouteLifecycle(publicRecord, {
      type: "publish_succeeded", visibility: "shadow", artifact_fingerprint: "artifact-a",
    });
    expect(attemptedRegression).toEqual(publicRecord);
    const wrongArtifact = reduceRouteLifecycle(eligible, {
      type: "publish_succeeded", visibility: "public", artifact_fingerprint: "artifact-b",
    });
    expect(wrongArtifact.state).toBe("publish_eligible");
  });
});

describe("durable route lifecycle store", () => {
  test("persists and reloads validation evidence", async () => {
    await transitionRouteLifecycle(identity, {
      type: "browser_observed",
      baseline_fingerprint: "base-a",
      dag_fingerprint: "dag-a",
    }, { file });
    await transitionRouteLifecycle(identity, {
      type: "api_validation_succeeded",
      baseline_fingerprint: "base-a",
      dag_fingerprint: "dag-a",
    }, { file });
    const loaded = await getRouteLifecycle(identity, { file });
    expect(loaded.state).toBe("validated");
    expect(loaded.browser_observations).toBe(1);
    expect(loaded.api_validation_successes).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
  });

  test("serializes concurrent writers without losing observations", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      transitionRouteLifecycle(identity, {
        type: "browser_observed",
        at: `2026-01-01T00:00:0${index}.000Z`,
        baseline_fingerprint: "base-a",
      }, { file, lock_timeout_ms: 5_000 }),
    ));
    const loaded = await getRouteLifecycle(identity, { file });
    expect(loaded.browser_observations).toBe(8);
    expect(loaded.state).toBe("validation_pending");
  });

  test("corrupt state fails closed to discovered instead of inventing validation", async () => {
    writeFileSync(file, "not-json");
    const loaded = await getRouteLifecycle(identity, { file });
    expect(loaded.state).toBe("discovered");
    expect(loaded.api_validation_successes).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith("state.json.corrupt."))).toBe(true);
  });

  test("recovers a lock left by a dead process", async () => {
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999_999_999, at: new Date().toISOString() }));
    const next = await transitionRouteLifecycle(identity, {
      type: "browser_observed",
      baseline_fingerprint: "base-a",
    }, { file, lock_timeout_ms: 250 });
    expect(next.state).toBe("validation_pending");
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
});


describe("lifecycle-bound publish permits", () => {
  async function validateRoute() {
    await transitionRouteLifecycle(identity, {
      type: "browser_observed", baseline_fingerprint: "base-a", dag_fingerprint: "dag-a",
    }, { file });
    await transitionRouteLifecycle(identity, {
      type: "api_validation_succeeded", baseline_fingerprint: "base-a", dag_fingerprint: "dag-a",
    }, { file });
  }

  test("issues only from validated state and is idempotent while live", async () => {
    expect(await issueRoutePublishPermit(identity, "artifact-a", { file })).toBeUndefined();
    await validateRoute();
    const first = await issueRoutePublishPermit(identity, "artifact-a", {
      file, now: "2026-01-01T00:00:00.000Z", permit_ttl_ms: 60_000,
    });
    const second = await issueRoutePublishPermit(identity, "artifact-a", {
      file, now: "2026-01-01T00:00:01.000Z", permit_ttl_ms: 60_000,
    });
    expect(first).toBeDefined();
    expect(second).toEqual(first);
    expect((await getRouteLifecycle(identity, { file })).state).toBe("publish_eligible");
  });

  test("atomically leases once across concurrent senders and consumes on success", async () => {
    await validateRoute();
    const permit = (await issueRoutePublishPermit(identity, "artifact-a", {
      file, now: "2026-01-01T00:00:00.000Z", permit_ttl_ms: 60_000,
    }))!;
    const claims = await Promise.all([
      claimRoutePublishPermit(permit, identity, "artifact-a", { file, now: "2026-01-01T00:00:01.000Z" }),
      claimRoutePublishPermit(permit, identity, "artifact-a", { file, now: "2026-01-01T00:00:01.000Z" }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    await settleRoutePublishPermit(permit, claim, true, { file, now: "2026-01-01T00:00:02.000Z" });
    expect(await claimRoutePublishPermit(permit, identity, "artifact-a", {
      file, now: "2026-01-01T00:00:03.000Z",
    })).toBeUndefined();
  });

  test("releases a failed send for retry while its permit is live", async () => {
    await validateRoute();
    const permit = (await issueRoutePublishPermit(identity, "artifact-a", {
      file, now: "2026-01-01T00:00:00.000Z", permit_ttl_ms: 60_000,
    }))!;
    const firstClaim = (await claimRoutePublishPermit(permit, identity, "artifact-a", {
      file, now: "2026-01-01T00:00:01.000Z",
    }))!;
    expect(firstClaim).toMatch(/^claim_/);
    await settleRoutePublishPermit(permit, firstClaim, false, { file, now: "2026-01-01T00:00:02.000Z" });
    expect(await claimRoutePublishPermit(permit, identity, "artifact-a", {
      file, now: "2026-01-01T00:00:03.000Z",
    })).toMatch(/^claim_/);
  });

  test("an expired send lease is not automatically reclaimed after an ambiguous commit", async () => {
    await validateRoute();
    const permit = (await issueRoutePublishPermit(identity, "artifact-a", {
      file, now: "2026-01-01T00:00:00.000Z", permit_ttl_ms: 60_000,
    }))!;
    const stale = (await claimRoutePublishPermit(permit, identity, "artifact-a", {
      file, now: "2026-01-01T00:00:01.000Z", permit_claim_ttl_ms: 100,
    }))!;
    expect(await claimRoutePublishPermit(permit, identity, "artifact-a", {
      file, now: "2026-01-01T00:00:02.000Z",
    })).toBeUndefined();
    await settleRoutePublishPermit(permit, "claim_attacker", false, { file, now: "2026-01-01T00:00:03.000Z" });
    expect(await claimRoutePublishPermit(permit, identity, "artifact-a", {
      file, now: "2026-01-01T00:00:03.000Z",
    })).toBeUndefined();
    await settleRoutePublishPermit(permit, stale, true, { file, now: "2026-01-01T00:00:04.000Z" });
  });

  test("rejects tampered scope/artifact and expired permits", async () => {
    await validateRoute();
    const permit = (await issueRoutePublishPermit(identity, "artifact-a", {
      file, now: "2026-01-01T00:00:00.000Z", permit_ttl_ms: 1_000,
    }))!;
    expect(await validateRoutePublishPermit(permit, identity, "artifact-a", {
      file, now: "2026-01-01T00:00:00.500Z",
    })).toBe(true);
    expect(await validateRoutePublishPermit({ ...permit, skill_id: "attacker-skill" }, identity, "artifact-a", {
      file, now: "2026-01-01T00:00:00.500Z",
    })).toBe(false);
    expect(await validateRoutePublishPermit(permit, { ...identity, principal_scope: "principal:other" }, "artifact-a", {
      file, now: "2026-01-01T00:00:00.500Z",
    })).toBe(false);
    expect(await validateRoutePublishPermit(permit, { ...identity, endpoint_fingerprint: "sha256:other" }, "artifact-a", {
      file, now: "2026-01-01T00:00:00.500Z",
    })).toBe(false);
    expect(await validateRoutePublishPermit(permit, { ...identity, intent_shape_hash: "sha256:other" }, "artifact-a", {
      file, now: "2026-01-01T00:00:00.500Z",
    })).toBe(false);
    expect(await validateRoutePublishPermit(permit, identity, "artifact-b", {
      file, now: "2026-01-01T00:00:00.500Z",
    })).toBe(false);
    expect(await validateRoutePublishPermit(permit, identity, "artifact-a", {
      file, now: "2026-01-01T00:00:01.000Z",
    })).toBe(false);
  });
});


describe("production interaction lifecycle witness", () => {
  test("capture, independent validation, then API-only execution survives fresh store callers", async () => {
    let browserCalls = 0;
    let apiCalls = 0;
    const interact = () => executeRouteLifecycleInteraction(identity, {
      browser_discover: async () => {
        browserCalls += 1;
        return { value: "browser", baseline_fingerprint: "base-a", dag_fingerprint: "dag-a" };
      },
      api_replay: async () => {
        apiCalls += 1;
        return { value: "api", baseline_fingerprint: "base-a", dag_fingerprint: "dag-a" };
      },
    }, { file });

    // Each call constructs a new interaction/store view; only the file is shared,
    // matching independent CLI/MCP process invocations.
    const first = await interact();
    expect(first.action).toBe("browser_discover");
    expect(first.record.state).toBe("validation_pending");
    expect(browserCalls).toBe(1);
    expect(apiCalls).toBe(0);

    const second = await interact();
    expect(second.action).toBe("api_validate");
    expect(second.record.state).toBe("validated");
    expect(browserCalls).toBe(1);
    expect(apiCalls).toBe(1);

    const third = await interact();
    expect(third.action).toBe("api_execute");
    expect(third.record.state).toBe("validated");
    expect(browserCalls).toBe(1);
    expect(apiCalls).toBe(2);
  });
});
