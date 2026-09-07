// wrangler-production-firmament.test.ts
//
// Day-4 lamp over the Day-3 F8 seed (commit 29e290aa0): the explicit
// [env.production] block in backend/wrangler.toml is load-bearing for
// the staging-then-prod separation required by global principle
// 20260521T194246Z-7ad798e3 (signed release manifest + named-env deploys).
//
// Without this block, `wrangler deploy --env production` silently falls
// back to the top-level [vars] / [[kv_namespaces]] surface and the
// staging-vs-prod boundary erodes without warning. This test parses the
// REAL wrangler.toml (no mocks, no fixtures — per CLAUDE.md "Tests must
// hit real code paths") and asserts every load-bearing field is intact.
//
// Falsifier: deleting any of the [env.production*] blocks, mutating the
// production routes, drifting the STATS_KV id away from the top-level
// binding, or regressing the existing [env.staging] block will turn
// this test red on the very next `bun test`.
import { describe, test, expect } from "bun:test";
import { TOML } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WRANGLER_PATH = resolve(import.meta.dir, "..", "wrangler.toml");

type KvNs = { binding: string; id: string; preview_id?: string };
type Route = { pattern: string; zone_name?: string };
type EnvBlock = {
  name?: string;
  workers_dev?: boolean;
  routes?: Route[];
  kv_namespaces?: KvNs[];
  vars?: Record<string, string>;
};
type Wrangler = {
  name: string;
  kv_namespaces?: KvNs[];
  vars?: Record<string, string>;
  env?: Record<string, EnvBlock>;
};

function loadWrangler(): Wrangler {
  const raw = readFileSync(WRANGLER_PATH, "utf8");
  return TOML.parse(raw) as Wrangler;
}

describe("wrangler.toml — production firmament (Day-3 F8 seed 29e290aa0)", () => {
  test("top-level name is unbrowse-backend (baseline)", () => {
    const w = loadWrangler();
    expect(w.name).toBe("unbrowse-backend");
  });

  test("[env.production] block exists (the load-bearing assertion)", () => {
    const w = loadWrangler();
    expect(w.env).toBeDefined();
    expect(w.env!.production).toBeDefined();
  });

  test("[env.production] name matches top-level worker name", () => {
    const w = loadWrangler();
    // Same-name keeps the production deploy targeting the existing Worker
    // script slot; a name drift would create a parallel Worker and silently
    // strand the existing one.
    expect(w.env!.production!.name).toBe(w.name);
    expect(w.env!.production!.name).toBe("unbrowse-backend");
  });

  test("[env.production.vars].ENVIRONMENT === 'production' (deploy intent)", () => {
    const w = loadWrangler();
    const vars = w.env!.production!.vars;
    expect(vars).toBeDefined();
    expect(vars!.ENVIRONMENT).toBe("production");
  });

  test("[env.production.kv_namespaces] binds STATS_KV with parity to top-level id", () => {
    const w = loadWrangler();
    const prodKv = w.env!.production!.kv_namespaces;
    expect(prodKv).toBeDefined();
    expect(Array.isArray(prodKv)).toBe(true);

    const prodStats = prodKv!.find((k) => k.binding === "STATS_KV");
    expect(prodStats).toBeDefined();

    // Parity check: production env MUST reuse the top-level STATS_KV id so
    // analytics writes don't silently fork into a separate namespace. The
    // top-level binding stays for CI back-compat (deploy.yml still uses
    // `wrangler deploy` without --env in some paths); both must agree.
    const topKv = w.kv_namespaces?.find((k) => k.binding === "STATS_KV");
    expect(topKv).toBeDefined();
    expect(prodStats!.id).toBe(topKv!.id);
  });

  test("[env.production.routes] includes beta-api.unbrowse.ai (current prod host)", () => {
    const w = loadWrangler();
    const routes = w.env!.production!.routes;
    expect(routes).toBeDefined();
    expect(Array.isArray(routes)).toBe(true);
    expect(routes!.length).toBeGreaterThan(0);

    const hasBetaApi = routes!.some((r) =>
      r.pattern?.includes("beta-api.unbrowse.ai"),
    );
    expect(hasBetaApi).toBe(true);
  });

  test("[env.staging] still exists (no regression of the sibling firmament)", () => {
    const w = loadWrangler();
    expect(w.env!.staging).toBeDefined();
    expect(w.env!.staging!.name).toBe("unbrowse-backend-staging");
    // Staging must declare its own ENVIRONMENT so logs + KV namespacing
    // (backend/src/services/kv.ts) can branch correctly.
    expect(w.env!.staging!.vars?.ENVIRONMENT).toBe("staging");
  });
});
