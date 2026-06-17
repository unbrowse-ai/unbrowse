import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Env } from "../src/types.js";
import { statsKV, clearKVCacheForTests } from "../src/services/kv.js";
import {
  recordTokenInstall,
  recordAgentInstall,
  resolveInstallForToken,
  resolveInstallForAgent,
  linkAgentViaToken,
  getAttributionStats,
  getCohortFunnel,
  recordInstallVariant,
  variantForInstall,
  bumpCohortStage,
} from "../src/services/attribution-link.js";

const env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as unknown,
  ENVIRONMENT: "local-dev",
} as unknown as Env;

function createMockFetch(store: Map<string, string>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url);
    if (url.pathname === "/qdkv/set") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
      store.set(body.key, body.value);
      return Response.json({ ok: true });
    }
    if (url.pathname.startsWith("/qdkv/get/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
      const value = store.get(key);
      return Response.json(value == null ? { found: false, value: null } : { found: true, value });
    }
    if (url.pathname.startsWith("/qdkv/del/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
      store.delete(key);
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

describe("attribution-link — the funnel keystone join", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    clearKVCacheForTests();
    await statsKV(env).resetSplitIndex();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("round-trips token->install", async () => {
    await recordTokenInstall(env, "tok_1", "install_A");
    expect(await resolveInstallForToken(env, "tok_1")).toBe("install_A");
  });

  it("closes the keystone chain: token->install at install, then agent->install at register", async () => {
    await recordTokenInstall(env, "tok_2", "install_B"); // install time
    const linked = await linkAgentViaToken(env, "agent_X", "tok_2"); // register time
    expect(linked).toBe("install_B");
    expect(await resolveInstallForAgent(env, "agent_X")).toBe("install_B");
  });

  it("returns null (no fabricated link) when the token was never seen", async () => {
    const linked = await linkAgentViaToken(env, "agent_Y", "tok_unknown");
    expect(linked).toBeNull();
    expect(await resolveInstallForAgent(env, "agent_Y")).toBeNull();
  });

  it("ignores empty ids", async () => {
    await recordTokenInstall(env, "", "install_C");
    await recordAgentInstall(env, "agent_Z", "");
    expect(await resolveInstallForToken(env, "")).toBeNull();
    expect(await resolveInstallForAgent(env, "agent_Z")).toBeNull();
  });

  // Luke 15:4 — the lost edges that silently mis-attribute revenue.
  it("first-write-wins: a token re-bound to a DIFFERENT install keeps the first (replay-safe)", async () => {
    await recordTokenInstall(env, "tok_r", "install_first");
    await recordTokenInstall(env, "tok_r", "install_second");
    expect(await resolveInstallForToken(env, "tok_r")).toBe("install_first");
  });

  it("first-link-wins: an agent re-linked via a DIFFERENT token keeps its origin install", async () => {
    await recordTokenInstall(env, "tok_a", "install_1");
    await recordTokenInstall(env, "tok_b", "install_2");
    expect(await linkAgentViaToken(env, "agent_R", "tok_a")).toBe("install_1");
    expect(await linkAgentViaToken(env, "agent_R", "tok_b")).toBe("install_1"); // origin is fixed
    expect(await resolveInstallForAgent(env, "agent_R")).toBe("install_1");
  });

  it("idempotent re-link returns the same install (re-registration safe)", async () => {
    await recordTokenInstall(env, "tok_i", "install_i");
    expect(await linkAgentViaToken(env, "agent_I", "tok_i")).toBe("install_i");
    expect(await linkAgentViaToken(env, "agent_I", "tok_i")).toBe("install_i");
  });

  it("whitespace-only ids are rejected (no malformed KV keys)", async () => {
    await recordTokenInstall(env, "   ", "install_w");
    expect(await resolveInstallForToken(env, "   ")).toBeNull();
  });

  it("getAttributionStats counts linked agents + tokens (the coverage signal)", async () => {
    await recordTokenInstall(env, "tok_s1", "install_s1");
    await recordTokenInstall(env, "tok_s2", "install_s2");
    await linkAgentViaToken(env, "agent_S1", "tok_s1");
    const stats = await getAttributionStats(env);
    expect(stats.linked_tokens).toBe(2);
    expect(stats.linked_agents).toBe(1);
  });

  // Gen 1:26 — dominion: the whole chain, end-to-end, counted into the cohort funnel.
  it("END-TO-END: install → register → session counts into the cohort funnel by variant (KV counters)", async () => {
    // (a) INSTALL: route binds token→install, records install→variant, bumps installs
    await recordTokenInstall(env, "tok_e2e", "install_e2e");
    await recordInstallVariant(env, "install_e2e", "variant-A");
    await bumpCohortStage(env, "variant-A", "installs", "install_e2e");
    // (b) REGISTER: keystone links agent→install, resolves variant, bumps registered
    expect(await linkAgentViaToken(env, "agent_e2e", "tok_e2e")).toBe("install_e2e");
    const v = await variantForInstall(env, "install_e2e");
    expect(v).toBe("variant-A");
    await bumpCohortStage(env, v!, "registered", "install_e2e");
    // (c) USAGE: a session bumps active
    await bumpCohortStage(env, v!, "active", "install_e2e");
    // (d) DOMINION: the cohort funnel reflects the chain, by acquisition variant
    const cohort = await getCohortFunnel(env);
    const row = cohort.by_variant.find((r) => r.variant === "variant-A");
    expect(row).toBeDefined();
    expect(row!.installs).toBe(1);
    expect(row!.registered).toBe(1);
    expect(row!.active).toBe(1);
    expect(row!.registration_rate).toBe(1);
    expect(cohort.totals).toEqual({ installs: 1, registered: 1, active: 1 });
  });

  it("cohort counter dedupes per install: same install bumped twice counts once", async () => {
    await bumpCohortStage(env, "variant-D", "installs", "install_dup");
    await bumpCohortStage(env, "variant-D", "installs", "install_dup");
    const cohort = await getCohortFunnel(env);
    expect(cohort.by_variant.find((r) => r.variant === "variant-D")!.installs).toBe(1);
  });

  it("cohort: an install with NO registration shows registered=0 (honest funnel drop-off)", async () => {
    await recordInstallVariant(env, "install_lonely", "variant-B");
    await bumpCohortStage(env, "variant-B", "installs", "install_lonely");
    const cohort = await getCohortFunnel(env);
    const row = cohort.by_variant.find((r) => r.variant === "variant-B");
    expect(row!.installs).toBe(1);
    expect(row!.registered).toBe(0);
    expect(row!.activation_rate).toBe(0);
  });
});
