import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setMarketplaceClientForTests, fingerprintMarketplacePublishDraft, publishSkill } from "../src/marketplace/index.js";
import { issueRoutePublishPermit, transitionRouteLifecycle } from "../src/runtime/route-lifecycle.js";

// Witness for the marketplace_published-overclaim fix: publishSkill must report
// whether the skill ACTUALLY reached the remote marketplace (published_remotely)
// rather than silently returning the local cache on remote failure — the false
// success that made the capture flag lie.

// Use the marketplace test seam instead of mock.module(), which leaks across
// Bun test files in the same process.
let shouldThrow = false;
let remoteCalls = 0;
let lastIdempotencyKey: string | undefined;
let configDir: string;
const originalConfigDir = process.env.UNBROWSE_CONFIG_DIR;
const originalConfigPath = process.env.UNBROWSE_CONFIG_PATH;
const fakeClient = {
  listSkills: async () => [],
  getSkill: async () => null,
  cachePublishedSkill: () => {},
  isLocalOnlyMode: () => false,
  publishSkill: async (draft: { domain?: string; skill_id?: string }, options?: { idempotencyKey?: string }) => {
    lastIdempotencyKey = options?.idempotencyKey;
    remoteCalls += 1;
    if (shouldThrow) throw new Error("backend 500: simulated remote failure");
    return { ...draft, skill_id: draft.skill_id ?? "remote-id", version: "1.0.1", warnings: [] };
  },
  updateEndpointScore: async () => {},
} as never;

beforeEach(async () => {
  remoteCalls = 0;
  lastIdempotencyKey = undefined;
  configDir = mkdtempSync(join(tmpdir(), "unbrowse-publish-consent-"));
  const configPath = join(configDir, "config.json");
  writeFileSync(configPath, JSON.stringify({ contribution: { share_pointers: true, auto_review: false, passive_index: true } }));
  process.env.UNBROWSE_CONFIG_DIR = configDir;
  process.env.UNBROWSE_CONFIG_PATH = configPath;
  const { _clearContributionCacheForTests } = await import("../src/config/contribution.js");
  _clearContributionCacheForTests();
  _setMarketplaceClientForTests(fakeClient);
});

afterEach(async () => {
  shouldThrow = false;
  _setMarketplaceClientForTests(null);
  if (originalConfigDir == null) delete process.env.UNBROWSE_CONFIG_DIR; else process.env.UNBROWSE_CONFIG_DIR = originalConfigDir;
  if (originalConfigPath == null) delete process.env.UNBROWSE_CONFIG_PATH; else process.env.UNBROWSE_CONFIG_PATH = originalConfigPath;
  const { _clearContributionCacheForTests } = await import("../src/config/contribution.js");
  _clearContributionCacheForTests();
  rmSync(configDir, { recursive: true, force: true });
});

const draft = {
  skill_id: "shop-example-skill",
  domain: "shop.example",
  name: "shop.example",
  endpoints: [{ endpoint_id: "e1", method: "GET", url_template: "https://shop.example/x", description: "list items" }],
} as never;

async function lifecycleAuthorization() {
  const dir = mkdtempSync(join(tmpdir(), "unbrowse-publish-truth-"));
  const lifecycle_store = { file: join(dir, "lifecycle.json") };
  const route_identity = {
    principal_scope: "principal:test",
    skill_id: draft.skill_id,
    endpoint_fingerprint: "GET:https://shop.example/x",
    intent_shape_hash: "list-items",
  };
  await transitionRouteLifecycle(route_identity, { type: "browser_observed", baseline_fingerprint: "shape-a", dag_fingerprint: "dag-a" }, lifecycle_store);
  await transitionRouteLifecycle(route_identity, { type: "api_validation_succeeded", baseline_fingerprint: "shape-a", dag_fingerprint: "dag-a" }, lifecycle_store);
  const publish_permit = await issueRoutePublishPermit(route_identity, fingerprintMarketplacePublishDraft(draft), lifecycle_store);
  if (!publish_permit) throw new Error("permit issuance failed");
  return { authorization: { publish_permit, route_identity, lifecycle_store }, dir };
}

test("missing lifecycle permit fails closed before remote transport", async () => {
  const r = await publishSkill(draft);
  expect(r.published_remotely).toBe(false);
  expect(remoteCalls).toBe(0);
});

test("lifecycle proof cannot substitute for explicit contribution consent", async () => {
  const { authorization, dir } = await lifecycleAuthorization();
  try {
    writeFileSync(process.env.UNBROWSE_CONFIG_PATH!, JSON.stringify({ contribution: { share_pointers: false, auto_review: false, passive_index: true } }));
    const { _clearContributionCacheForTests } = await import("../src/config/contribution.js");
    _clearContributionCacheForTests();
    const r = await publishSkill(draft, authorization);
    expect(r.published_remotely).toBe(false);
    expect(remoteCalls).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("one permit cannot send the same artifact twice concurrently", async () => {
  const { authorization, dir } = await lifecycleAuthorization();
  try {
    const results = await Promise.all([
      publishSkill(draft, authorization),
      publishSkill(draft, authorization),
    ]);
    expect(remoteCalls).toBe(1);
    expect(results.filter((result) => result.published_remotely)).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("remote success → published_remotely: true", async () => {
  shouldThrow = false;
  const { authorization, dir } = await lifecycleAuthorization();
  try {
    const r = await publishSkill(draft, authorization);
    expect(r.published_remotely).toBe(true);
    expect(lastIdempotencyKey).toBe(authorization.publish_permit.permit_id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("remote FAILURE → published_remotely: false (was a silent local fallback claiming success)", async () => {
  shouldThrow = true;
  const { authorization, dir } = await lifecycleAuthorization();
  try {
    const r = await publishSkill(draft, authorization);
    expect(r.published_remotely).toBe(false);
    // still returns a usable local skill (the cache fallback is preserved) — just honest about it
    expect(r.skill_id).toBeTruthy();
    const retry = await publishSkill(draft, authorization);
    expect(retry.published_remotely).toBe(false);
    expect(remoteCalls).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
