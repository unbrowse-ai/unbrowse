import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillManifest } from "../src/types/skill.js";
import {
  passivePublishArtifactFingerprint,
  queuePassiveSkillPublish,
  resetPassivePublishQueueForTests,
} from "../src/orchestrator/passive-publish.js";
import {
  getRouteLifecycle,
  issueRoutePublishPermit,
  transitionRouteLifecycle,
  type RouteLifecycleIdentity,
} from "../src/runtime/route-lifecycle.js";

let dir: string;
let configPath: string;
let lifecycleFile: string;
const originalConfigDir = process.env.UNBROWSE_CONFIG_DIR;
const originalConfigPath = process.env.UNBROWSE_CONFIG_PATH;

const identity: RouteLifecycleIdentity = {
  principal_scope: "principal:test",
  skill_id: "permit-skill",
  endpoint_fingerprint: "sha256:endpoint",
  intent_shape_hash: "sha256:intent",
};

function skill(description = "original"): SkillManifest {
  const at = "2026-01-01T00:00:00.000Z";
  return {
    skill_id: "permit-skill", version: "1.0.0", schema_version: "1", name: "Permit skill",
    intent_signature: "find things", domain: "api.github.com", description,
    owner_type: "community", execution_type: "http",
    endpoints: [{
      endpoint_id: "ep-1", method: "GET", url_template: "https://api.github.com/things?q={q}",
      description: "find", idempotency: "safe", verification_status: "verified", reliability_score: 0.9,
      response_schema: { type: "object", properties: { items: { type: "array" } } },
    }],
    lifecycle: { status: "active" }, created_at: at, updated_at: at,
  } as SkillManifest;
}

const deps = (published: SkillManifest[]) => ({
  publishSkill: async (draft: SkillManifest) => {
    const result = { ...draft, published_remotely: true } as SkillManifest;
    published.push(result);
    return result;
  },
  cachePublishedSkill: (_skill: SkillManifest) => {},
  validateManifest: async (_skill: SkillManifest) => ({ valid: true, hardErrors: [], softWarnings: [] }),
});

async function permitFor(value: SkillManifest) {
  await transitionRouteLifecycle(identity, {
    type: "browser_observed", baseline_fingerprint: "base", dag_fingerprint: "dag",
  }, { file: lifecycleFile });
  await transitionRouteLifecycle(identity, {
    type: "api_validation_succeeded", baseline_fingerprint: "base", dag_fingerprint: "dag",
  }, { file: lifecycleFile });
  return (await issueRoutePublishPermit(identity, passivePublishArtifactFingerprint(value), { file: lifecycleFile }))!;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "passive-permit-"));
  configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    contribution: { share_pointers: true, auto_review: true, passive_index: true, set_via: "mode-command" },
    capture_pipeline: { auto_publish_checkpoints: true },
  }));
  process.env.UNBROWSE_CONFIG_DIR = dir;
  process.env.UNBROWSE_CONFIG_PATH = configPath;
  const { _clearContributionCacheForTests } = await import("../src/config/contribution.js");
  _clearContributionCacheForTests();
});

beforeEach(() => {
  lifecycleFile = join(dir, `lifecycle-${crypto.randomUUID()}.json`);
  resetPassivePublishQueueForTests();
});

afterAll(async () => {
  if (originalConfigDir == null) delete process.env.UNBROWSE_CONFIG_DIR; else process.env.UNBROWSE_CONFIG_DIR = originalConfigDir;
  if (originalConfigPath == null) delete process.env.UNBROWSE_CONFIG_PATH; else process.env.UNBROWSE_CONFIG_PATH = originalConfigPath;
  const { _clearContributionCacheForTests } = await import("../src/config/contribution.js");
  _clearContributionCacheForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("passive publish lifecycle permit", () => {
  test("publishes with a store-backed permit and records lifecycle publication", async () => {
    const value = skill();
    const permit = await permitFor(value);
    const published: SkillManifest[] = [];
    await queuePassiveSkillPublish(value, {
      deps: deps(published), parity: "pass", publish_permit: permit,
      route_identity: identity, lifecycle_store: { file: lifecycleFile },
    });
    expect(published).toHaveLength(1);
  });

  test("rejects self-asserted and artifact-tampered permits", async () => {
    const original = skill();
    const permit = await permitFor(original);
    const published: SkillManifest[] = [];
    await queuePassiveSkillPublish(skill("tampered"), {
      deps: deps(published), parity: "pass", publish_permit: permit,
      route_identity: identity, lifecycle_store: { file: lifecycleFile },
    });
    expect(published).toHaveLength(0);

    resetPassivePublishQueueForTests();
    await queuePassiveSkillPublish(original, {
      deps: deps(published), parity: "pass",
      publish_permit: { ...permit, permit_id: crypto.randomUUID() },
      route_identity: identity, lifecycle_store: { file: lifecycleFile },
    });
    expect(published).toHaveLength(0);
  });
  test("local fallback is not recorded as shadow/public and remains retryable", async () => {
    const value = skill();
    const permit = await permitFor(value);
    let remoteAttempts = 0;
    const localOnlyDeps = {
      ...deps([]),
      publishSkill: async (draft: SkillManifest) => {
        remoteAttempts += 1;
        return { ...draft, published_remotely: false } as SkillManifest & { published_remotely: boolean };
      },
    };
    await queuePassiveSkillPublish(value, {
      deps: localOnlyDeps, parity: "pass", publish_permit: permit,
      route_identity: identity, lifecycle_store: { file: lifecycleFile },
    });
    expect(remoteAttempts).toBe(1);
    expect((await getRouteLifecycle(identity, { file: lifecycleFile })).state).toBe("publish_eligible");
  });

});
