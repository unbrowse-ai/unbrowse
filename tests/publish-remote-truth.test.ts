import { afterEach, beforeEach, expect, test } from "bun:test";
import { _setMarketplaceClientForTests, publishSkill } from "../src/marketplace/index.js";

// Witness for the marketplace_published-overclaim fix: publishSkill must report
// whether the skill ACTUALLY reached the remote marketplace (published_remotely)
// rather than silently returning the local cache on remote failure — the false
// success that made the capture flag lie. (1 Cor 5:6-7.)

// Use the marketplace test seam instead of mock.module(), which leaks across
// Bun test files in the same process.
let shouldThrow = false;
const fakeClient = {
  listSkills: async () => [],
  getSkill: async () => null,
  cachePublishedSkill: () => {},
  isLocalOnlyMode: () => false,
  publishSkill: async (draft: { domain?: string; skill_id?: string }) => {
    if (shouldThrow) throw new Error("backend 500: simulated remote failure");
    return { ...draft, skill_id: draft.skill_id ?? "remote-id", version: "1.0.1", warnings: [] };
  },
  updateEndpointScore: async () => {},
} as never;

beforeEach(() => {
  _setMarketplaceClientForTests(fakeClient);
});

afterEach(() => {
  shouldThrow = false;
  _setMarketplaceClientForTests(null);
});

const draft = {
  domain: "shop.example",
  name: "shop.example",
  endpoints: [{ endpoint_id: "e1", method: "GET", url_template: "https://shop.example/x", description: "list items" }],
} as never;

test("remote success → published_remotely: true", async () => {
  shouldThrow = false;
  const r = await publishSkill(draft);
  expect(r.published_remotely).toBe(true);
});

test("remote FAILURE → published_remotely: false (was a silent local fallback claiming success)", async () => {
  shouldThrow = true;
  const r = await publishSkill(draft);
  expect(r.published_remotely).toBe(false);
  // still returns a usable local skill (the cache fallback is preserved) — just honest about it
  expect(r.skill_id).toBeTruthy();
});
