/**
 * Route identity is HOST scope, not cookie scope.
 *
 * Reproduction (live, 2026-08): asked for https://data.gov.sg/datasets with intent
 * "list the datasets", unbrowse replayed a route that had been captured on
 * guide.data.gov.sg — a GitBook-hosted developer guide — and returned GitBook's UI
 * *translation file* ('powered_by_gitbook', locale names, flag emoji) as "the
 * datasets", with trace.success true and intent_verdict "pass". The route-cache
 * entry read:
 *
 *   key:     "cli-2957301:gov.sg:list the datasets:
 *             https://guide.data.gov.sg/developer-guide/dataset-apis/list-all-datasets"
 *   domain:  gov.sg
 *
 * Every host under gov.sg shared one route namespace because route/skill selection
 * compared registrable domains (eTLD+1). Cookies legitimately want eTLD+1 — routes
 * do not: two hosts under one registrable domain are routinely two different
 * applications with two different APIs.
 *
 * These tests pin BOTH directions of the equivalence:
 *   - guide.data.gov.sg must NOT be selected for data.gov.sg  (the reproduction);
 *   - www.example.com must STILL be reusable for example.com  (not blanket
 *     strictness — an all-miss cache is a total product regression that would
 *     still look green in a suite that only tested the tightening).
 *
 * WHY EVERYTHING RUNS IN A CHILD PROCESS. Two constraints force it, and both are
 * properties of this repo rather than of this test:
 *   1. UNBROWSE_SKILL_SNAPSHOT_DIR is read once at orchestrator module-eval time
 *      and also flips ISOLATED_SKILL_SNAPSHOT_MODE (no ~/.unbrowse cache load, no
 *      persist). Setting it from inside a shared `bun test` process is unreliable —
 *      another test file may have imported the orchestrator first, in which case
 *      the module is already bound to the developer's real ~/.unbrowse dirs.
 *   2. tests/browser-lazy-tab.test.ts and tests/workflow-publish-export.test.ts
 *      call `mock.module("../src/orchestrator/index.js", …)`, which is PROCESS-WIDE
 *      in bun — any symbol this file imported at the top level would silently
 *      become their stub when the whole suite runs.
 * A child process gives a pristine module graph with the temp snapshot dir bound
 * before import. Fully offline; the developer's ~/.unbrowse is never read and
 * never written.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { SkillManifest } from "../src/types.js";

const WORK_DIR = mkdtempSync(join(tmpdir(), "unbrowse-route-scope-"));
const SNAPSHOT_DIR = join(WORK_DIR, "skill-snapshots");
const ORCHESTRATOR = resolve(import.meta.dir, "../src/orchestrator/index.ts");

afterAll(() => {
  rmSync(WORK_DIR, { recursive: true, force: true });
});

const DATASETS_INTENT = "list the datasets";
const DATASETS_URL = "https://data.gov.sg/datasets";
const GUIDE_URL = "https://guide.data.gov.sg/developer-guide/dataset-apis/list-all-datasets";
// The snapshot-SELECTION cases use the two site ROOTS on purpose. A deeper path
// trips `marketplaceSkillMatchesContext`'s concrete-resource path-coherence gate,
// which would make the reproduction go green for the wrong reason (path
// incoherence rather than host scope). At the roots every other gate is verified
// to pass for BOTH hosts — that is exactly what the `control` case proves — so
// route scope is the only discriminator left.
const DATASETS_ROOT = "https://data.gov.sg/";
const GUIDE_ROOT = "https://guide.data.gov.sg/";

const GUIDE_SKILL_ID = "z7Ztm3NZ2HZIFEgm3P2kd"; // the skill_id the live run reported
const PORTAL_SKILL_ID = "portal-data-gov-sg-000";

/** (skillDomain, contextUrl) pairs put through cachedSkillHostMatchesContext. */
const REPLAY_CASES: Array<[string, string]> = [
  ["guide.data.gov.sg", DATASETS_URL],
  ["gov.sg", DATASETS_URL],
  ["guide.data.gov.sg", GUIDE_URL],
  ["www.example.com", "https://example.com/datasets"],
  ["example.com", "https://www.example.com/datasets"],
];

/** Inputs put through routeScopeHost. */
const HOST_CASES: Array<string | null> = [
  "https://www.example.com/x",
  "www.example.com",
  "example.com",
  "http://127.0.0.1:39629/x",
  null,
  "",
  "   ",
];

/** Pairs put through sameRouteScope. */
const SCOPE_PAIRS: Array<[string | null, string | null]> = [
  ["guide.data.gov.sg", "data.gov.sg"],
  ["data.gov.sg", "gov.sg"],
  ["news.google.com", "google.com"],
  ["music.youtube.com", "www.youtube.com"],
  ["github.com", "reddit.com"],
  ["www.example.com", "example.com"],
  ["www.airbnb.com", "www.airbnb.com.sg"],
  ["airbnb.com", "airbnb.com.sg"],
  ["guide.airbnb.com", "airbnb.com.sg"],
  ["http://localhost:3000", "http://localhost:3001"],
  ["http://localhost:3000", "http://localhost:3000/other"],
  [null, "example.com"],
  ["example.com", null],
];

/** Inputs put through getDomainReuseKey. */
const DOMAIN_KEY_CASES: string[] = [
  DATASETS_URL,
  GUIDE_URL,
  "https://www.example.com/a",
  "https://example.com/b",
  "http://127.0.0.1:39629/x",
  "https://www.airbnb.com/s/Tokyo/homes?tab_id=home_tab",
];

/** (domain, intent, url) triples put through buildResolveCacheKey. */
const RESOLVE_KEY_CASES: Array<[string | null, string, string]> = [
  ["data.gov.sg", DATASETS_INTENT, DATASETS_URL],
  ["guide.data.gov.sg", DATASETS_INTENT, GUIDE_URL],
  ["gov.sg", DATASETS_INTENT, DATASETS_URL],
  ["gov.sg", DATASETS_INTENT, GUIDE_URL],
  ["www.example.com", "x", "https://www.example.com/p"],
  ["example.com", "x", "https://example.com/p"],
];

const DRIVER = `
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const SNAPSHOT_DIR = ${JSON.stringify(SNAPSHOT_DIR)};
process.env.UNBROWSE_SKILL_SNAPSHOT_DIR = SNAPSHOT_DIR;

const orchestrator = await import(${JSON.stringify(ORCHESTRATOR)});
const {
  findBestLocalDomainSnapshot,
  cachedSkillHostMatchesContext,
  routeScopeHost,
  sameRouteScope,
  getDomainReuseKey,
  buildResolveCacheKey,
} = orchestrator;

function manifest(skillId, domain, endpointUrl) {
  return {
    skill_id: skillId,
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    name: domain,
    owner_type: "agent",
    index_status: "ok",
    domain,
    intent_signature: ${JSON.stringify(DATASETS_INTENT)},
    intents: [${JSON.stringify(DATASETS_INTENT)}],
    description: "API skill for " + domain,
    endpoints: [{
      endpoint_id: skillId + "-ep",
      method: "GET",
      url_template: endpointUrl,
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
      description: "List datasets",
      response_schema: { type: "array", items: { type: "object" } },
    }],
  };
}

// The poisoned route: captured on the GitBook-hosted developer guide.
const GUIDE = manifest(${JSON.stringify(GUIDE_SKILL_ID)}, "guide.data.gov.sg",
  "https://guide.data.gov.sg/~gitbook/api/spaces/list-all-datasets");
// The route that legitimately answers the request.
const PORTAL = manifest(${JSON.stringify(PORTAL_SKILL_ID)}, "data.gov.sg",
  "https://api-open.data.gov.sg/v1/public/api/datasets");
const WWW = manifest("www-example-skill-01", "www.example.com", "https://www.example.com/api/datasets");
const APEX = manifest("apex-example-skill-1", "example.com", "https://example.com/api/datasets");

function stage(skills) {
  rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  for (const skill of skills) {
    writeFileSync(join(SNAPSHOT_DIR, skill.skill_id + ".json"), JSON.stringify(skill), "utf-8");
  }
}

function pick(skills, requestedDomain, contextUrl) {
  stage(skills);
  const hit = findBestLocalDomainSnapshot(requestedDomain, ${JSON.stringify(DATASETS_INTENT)}, contextUrl);
  return hit ? hit.skill_id : null;
}

const out = {
  selection: {
    guideForPortal: pick([GUIDE],         "data.gov.sg",       ${JSON.stringify(DATASETS_ROOT)}),
    guideForGuide:  pick([GUIDE],         "guide.data.gov.sg", ${JSON.stringify(GUIDE_ROOT)}),
    bothForPortal:  pick([GUIDE, PORTAL], "data.gov.sg",       ${JSON.stringify(DATASETS_ROOT)}),
    bothForGuide:   pick([GUIDE, PORTAL], "guide.data.gov.sg", ${JSON.stringify(GUIDE_ROOT)}),
    wwwForApex:     pick([WWW],           "example.com",       "https://example.com/"),
    apexForWww:     pick([APEX],          "www.example.com",   "https://www.example.com/"),
  },
  replay: ${JSON.stringify(REPLAY_CASES)}.map(([d, u]) => cachedSkillHostMatchesContext(d, u)),
  hosts: ${JSON.stringify(HOST_CASES)}.map((h) => routeScopeHost(h)),
  scopes: ${JSON.stringify(SCOPE_PAIRS)}.map(([a, b]) => sameRouteScope(a, b)),
  domainKeys: ${JSON.stringify(DOMAIN_KEY_CASES)}.map((u) => getDomainReuseKey(u)),
  resolveKeys: ${JSON.stringify(RESOLVE_KEY_CASES)}.map(([d, i, u]) => buildResolveCacheKey(d, i, u)),
};
console.log("__RESULT__" + JSON.stringify(out));
`;

type DriverResult = {
  selection: Record<string, string | null>;
  replay: boolean[];
  hosts: Array<string | null>;
  scopes: boolean[];
  domainKeys: Array<string | null>;
  resolveKeys: string[];
};

let out: DriverResult;

beforeAll(() => {
  const driverPath = join(WORK_DIR, "route-scope-driver.mjs");
  writeFileSync(driverPath, DRIVER, "utf-8");
  const proc = Bun.spawnSync([process.execPath, "run", driverPath], {
    // UNBROWSE_STATELESS is deliberately NOT set — it suppresses snapshot reads
    // entirely and would hide the defect rather than test it.
    env: { ...process.env, UNBROWSE_SKILL_SNAPSHOT_DIR: SNAPSHOT_DIR },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const line = stdout.split("\n").find((row) => row.startsWith("__RESULT__"));
  if (!line) {
    throw new Error(
      `route-scope driver produced no result\nexit=${proc.exitCode}\nstdout:\n${stdout}\nstderr:\n${proc.stderr.toString()}`,
    );
  }
  out = JSON.parse(line.slice("__RESULT__".length)) as DriverResult;
});

const replayOf = (skillDomain: string, contextUrl: string): boolean =>
  out.replay[REPLAY_CASES.findIndex(([d, u]) => d === skillDomain && u === contextUrl)]!;
const hostOf = (input: string | null): string | null =>
  out.hosts[HOST_CASES.indexOf(input)]!;
const scopeOf = (a: string | null, b: string | null): boolean =>
  out.scopes[SCOPE_PAIRS.findIndex(([x, y]) => x === a && y === b)]!;
const domainKeyOf = (url: string): string | null =>
  out.domainKeys[DOMAIN_KEY_CASES.indexOf(url)]!;
const resolveKeyOf = (domain: string | null, intent: string, url: string): string =>
  out.resolveKeys[RESOLVE_KEY_CASES.findIndex(([d, i, u]) => d === domain && i === intent && u === url)]!;

describe("route identity is host scope — the data.gov.sg reproduction", () => {
  test("a route learned on guide.data.gov.sg is NOT selected for data.gov.sg", () => {
    // THE reproduction. Only the GitBook guide skill is on disk. Under
    // registrable-domain matching both hosts collapse to `gov.sg` and this
    // snapshot is handed back as "the datasets".
    expect(out.selection.guideForPortal).toBeNull();
  });

  test("control: the same snapshot IS selected for its own host", () => {
    // Proves the fixture is otherwise viable, so the case above returns null for
    // the host-scope reason — not because some other gate (usable-endpoints /
    // intent relevance / marketplace context) rejected the manifest.
    expect(out.selection.guideForGuide).toBe(GUIDE_SKILL_ID);
  });

  test("with both snapshots on disk, each host gets its own route", () => {
    expect(out.selection.bothForPortal).toBe(PORTAL_SKILL_ID);
    expect(out.selection.bothForGuide).toBe(GUIDE_SKILL_ID);
  });

  test("the replay boundary drops the poisoned cache entry", () => {
    // cachedSkillHostMatchesContext is the guard the resolve fast path runs on the
    // STORED entry before hydrating the skill; false evicts it so it self-heals.
    expect(replayOf("guide.data.gov.sg", DATASETS_URL)).toBe(false);
    // The literal on-disk shape from the bug report: the entry had lost the host
    // entirely and recorded the registrable domain.
    expect(replayOf("gov.sg", DATASETS_URL)).toBe(false);
    // ...and it stays valid for the host it was actually learned on.
    expect(replayOf("guide.data.gov.sg", GUIDE_URL)).toBe(true);
  });

  test("the domain-level reuse key separates the two hosts", () => {
    expect(domainKeyOf(DATASETS_URL)).toBe("data.gov.sg");
    expect(domainKeyOf(GUIDE_URL)).toBe("guide.data.gov.sg");
    expect(domainKeyOf(DATASETS_URL)).not.toBe(domainKeyOf(GUIDE_URL));
  });

  test("key construction carries the host distinction, not the eTLD+1", () => {
    const portalKey = resolveKeyOf("data.gov.sg", DATASETS_INTENT, DATASETS_URL);
    const guideKey = resolveKeyOf("guide.data.gov.sg", DATASETS_INTENT, GUIDE_URL);
    expect(portalKey.startsWith("data.gov.sg:")).toBe(true);
    expect(guideKey.startsWith("guide.data.gov.sg:")).toBe(true);
    expect(portalKey).not.toBe(guideKey);

    // The exact defect: `context.domain` is caller-supplied and had already been
    // collapsed to "gov.sg". The URL's own host is the more specific truth and
    // must win, so the key segment can never read "gov.sg" for either host.
    const collapsedPortal = resolveKeyOf("gov.sg", DATASETS_INTENT, DATASETS_URL);
    const collapsedGuide = resolveKeyOf("gov.sg", DATASETS_INTENT, GUIDE_URL);
    expect(collapsedPortal.startsWith("gov.sg:")).toBe(false);
    expect(collapsedGuide.startsWith("gov.sg:")).toBe(false);
    expect(collapsedPortal.startsWith("data.gov.sg:")).toBe(true);
    expect(collapsedGuide.startsWith("guide.data.gov.sg:")).toBe(true);
    expect(collapsedPortal).not.toBe(collapsedGuide);
  });

  test("sameRouteScope rejects sibling subdomains under one registrable domain", () => {
    expect(scopeOf("guide.data.gov.sg", "data.gov.sg")).toBe(false);
    expect(scopeOf("data.gov.sg", "gov.sg")).toBe(false);
    expect(scopeOf("news.google.com", "google.com")).toBe(false);
    expect(scopeOf("music.youtube.com", "www.youtube.com")).toBe(false);
    expect(scopeOf("github.com", "reddit.com")).toBe(false);
  });
});

describe("the fix is not blanket strictness — legitimate reuse survives", () => {
  test("a route learned on www.example.com IS usable for example.com (and back)", () => {
    expect(out.selection.wwwForApex).toBe("www-example-skill-01");
    expect(out.selection.apexForWww).toBe("apex-example-skill-1");
  });

  test("www is an apex alias at every layer of the route scope", () => {
    expect(hostOf("https://www.example.com/x")).toBe("example.com");
    expect(hostOf("www.example.com")).toBe("example.com");
    expect(hostOf("example.com")).toBe("example.com");
    expect(scopeOf("www.example.com", "example.com")).toBe(true);
    expect(replayOf("www.example.com", "https://example.com/datasets")).toBe(true);
    expect(replayOf("example.com", "https://www.example.com/datasets")).toBe(true);
    expect(domainKeyOf("https://www.example.com/a")).toBe(domainKeyOf("https://example.com/b"));
    expect(resolveKeyOf("www.example.com", "x", "https://www.example.com/p").split(":")[0])
      .toBe(resolveKeyOf("example.com", "x", "https://example.com/p").split(":")[0]);
  });

  test("geo-variant registrable suffixes stay one route scope (airbnb.com ↔ airbnb.com.sg)", () => {
    expect(scopeOf("www.airbnb.com", "www.airbnb.com.sg")).toBe(true);
    expect(scopeOf("airbnb.com", "airbnb.com.sg")).toBe(true);
    // ...but the geo allowance never re-opens the sibling-subdomain hole: the
    // subdomain path in front of the registrable domain must match too.
    expect(scopeOf("guide.airbnb.com", "airbnb.com.sg")).toBe(false);
    // The eTLD+1 key asserted by tests/domain-skill-cache-fallback.test.ts stays put.
    expect(domainKeyOf("https://www.airbnb.com/s/Tokyo/homes?tab_id=home_tab")).toBe("airbnb.com");
  });

  test("port-sensitive hosts keep their port as the application boundary", () => {
    expect(hostOf("http://127.0.0.1:39629/x")).toBe("127.0.0.1:39629");
    expect(domainKeyOf("http://127.0.0.1:39629/x")).toBe("127.0.0.1:39629");
    expect(scopeOf("http://localhost:3000", "http://localhost:3001")).toBe(false);
    expect(scopeOf("http://localhost:3000", "http://localhost:3000/other")).toBe(true);
  });

  test("routeScopeHost is total on junk input", () => {
    expect(hostOf(null)).toBeNull();
    expect(hostOf("")).toBeNull();
    expect(hostOf("   ")).toBeNull();
    expect(scopeOf(null, "example.com")).toBe(false);
    expect(scopeOf("example.com", null)).toBe(false);
  });
});

// Keeps the manifest shape honest against the real type without importing the
// (process-wide mockable) orchestrator module into this process.
export type _RouteScopeFixtureShape = Pick<SkillManifest, "skill_id" | "domain">;
