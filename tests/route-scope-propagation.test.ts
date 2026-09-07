/**
 * Route identity is HOST scope — in the TWO PLACES THE ORCHESTRATOR FIX DID NOT REACH.
 *
 * `src/orchestrator/index.ts` was fixed first (see tests/route-cache-host-scope.test.ts)
 * by introducing `routeScopeHost()` / `sameRouteScope()`. But the same collision —
 * "compare eTLD+1, therefore every host under gov.sg shares one route namespace" —
 * was still live in two other call sites, which is how the 2026-08 defect
 * (asking for https://data.gov.sg/datasets and getting GitBook's UI *translation
 * file* back, with trace.success true) could still be served or re-created:
 *
 *   1. SELECTION — `localShortlistForDomain` (src/cli-v7/eval/resolve.ts). The local
 *      skill-cache shortlist `unbrowse eval resolve --url https://data.gov.sg/...`
 *      returns BEFORE any network round-trip, so a guide.data.gov.sg route shortlisted
 *      here is the answer the agent gets.
 *   2. PROPAGATION — `findAndMergeDomainSnapshot` (src/lib/indexer-core/index.ts).
 *      Merging is the back door: under eTLD+1 matching, a capture on
 *      guide.data.gov.sg merged its GitBook endpoints INTO the data.gov.sg manifest.
 *      After that, the poisoned endpoint lives inside a manifest whose own `domain`
 *      IS `data.gov.sg`, so every downstream host check — including the orchestrator's
 *      new one — passes it. Fixing selection without fixing merge just delays the bug
 *      by one capture.
 *
 * Both compare a stored skill's CAPTURE context against the REQUEST context, which is
 * the structural signature of route identity, so both are host-scoped through the one
 * shared helper. Endpoint OWNERSHIP is a different question and stays registrable-wide:
 * a site's own XHRs legitimately live on `api.`/`cdn.` subdomains, so the endpoints
 * inside a matched/merged skill are never filtered by host. Both are asserted below.
 *
 * Every test pins BOTH directions, because a tightening-only suite stays green while
 * the product turns into an all-miss cache:
 *   - guide.data.gov.sg must NOT answer data.gov.sg      (the reproduction)
 *   - guide.data.gov.sg MUST still answer itself         (the control — proves the
 *     reproduction fails for the host-scope reason, not because selection is broken)
 *   - www.example.com must STILL be reusable for example.com  (legitimate reuse)
 *
 * WHY EVERYTHING RUNS IN A CHILD PROCESS — same two repo properties as
 * tests/route-cache-host-scope.test.ts:
 *   1. `UNBROWSE_SKILL_SNAPSHOT_DIR` is read once at orchestrator module-eval time and
 *      flips ISOLATED_SKILL_SNAPSHOT_MODE (src/orchestrator/index.ts:323), which is what
 *      suppresses the ~/.unbrowse route-cache / domain-cache load AND its debounced
 *      flush. Set from inside a shared `bun test` process it is unreliable — another
 *      test file may have imported the orchestrator first, in which case the module is
 *      already bound to the developer's real ~/.unbrowse and a flush can TRUNCATE it.
 *   2. tests/browser-lazy-tab.test.ts and tests/workflow-publish-export.test.ts call
 *      `mock.module("../src/orchestrator/index.js", …)`, which is PROCESS-WIDE in bun —
 *      anything this file imported at the top level would silently become their stub
 *      when the whole suite runs.
 * `UNBROWSE_SKILL_CACHE_DIR` and `UNBROWSE_CONFIG_DIR` are likewise pointed at the temp
 * dir so `listLocalSkills()` enumerates the fixture and never the developer's cache.
 * Fully offline; ~/.unbrowse is never read and never written.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { SkillManifest } from "../src/types.js";

const WORK_DIR = mkdtempSync(join(tmpdir(), "unbrowse-route-scope-prop-"));
const SNAPSHOT_DIR = join(WORK_DIR, "skill-snapshots");
const SKILL_CACHE_DIR = join(WORK_DIR, "skill-cache");
const MERGE_DIR = join(WORK_DIR, "merge-snapshots");
const RESOLVE_MOD = resolve(import.meta.dir, "../src/cli-v7/eval/resolve.ts");
const INDEXER_MOD = resolve(import.meta.dir, "../src/lib/indexer-core/index.ts");

afterAll(() => {
  rmSync(WORK_DIR, { recursive: true, force: true });
});

const GUIDE_SKILL_ID = "z7Ztm3NZ2HZIFEgm3P2kd"; // the skill_id the live run reported
const PORTAL_SKILL_ID = "portal-data-gov-sg-000";
const WWW_SKILL_ID = "www-example-skill-01";
const APEX_SKILL_ID = "apex-example-skill-1";

const DRIVER = `
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const SNAPSHOT_DIR = ${JSON.stringify(SNAPSHOT_DIR)};
const SKILL_CACHE_DIR = ${JSON.stringify(SKILL_CACHE_DIR)};
const MERGE_DIR = ${JSON.stringify(MERGE_DIR)};
process.env.UNBROWSE_SKILL_SNAPSHOT_DIR = SNAPSHOT_DIR;
process.env.UNBROWSE_SKILL_CACHE_DIR = SKILL_CACHE_DIR;

const { localShortlistForDomain } = await import(${JSON.stringify(RESOLVE_MOD)});
const { findAndMergeDomainSnapshot } = await import(${JSON.stringify(INDEXER_MOD)});

function manifest(skillId, domain, endpointId, endpointUrl) {
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
    intent_signature: "list the datasets",
    intents: ["list the datasets"],
    description: "API skill for " + domain,
    endpoints: [{
      endpoint_id: endpointId,
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
  "guide-list", "https://guide.data.gov.sg/~gitbook/api/spaces/list-all-datasets");
// The route that legitimately answers the request.
const PORTAL = manifest(${JSON.stringify(PORTAL_SKILL_ID)}, "data.gov.sg",
  "portal-list", "https://api-open.data.gov.sg/v1/public/api/datasets");
// Legitimate www<->apex reuse. NOTE the endpoint hosts: a site's own XHRs on an
// \`api.\` subdomain are ENDPOINT OWNERSHIP and must survive both gates untouched.
const WWW = manifest(${JSON.stringify(WWW_SKILL_ID)}, "www.example.com",
  "www-search", "https://api.example.com/search?q={query}");
const APEX = manifest(${JSON.stringify(APEX_SKILL_ID)}, "example.com",
  "apex-detail", "https://api.example.com/items/{item_id}");

/* ---------- selection: localShortlistForDomain (src/cli-v7/eval/resolve.ts) ---------- */

function stageSkillCache(skills) {
  rmSync(SKILL_CACHE_DIR, { recursive: true, force: true });
  mkdirSync(SKILL_CACHE_DIR, { recursive: true });
  for (const skill of skills) {
    writeFileSync(join(SKILL_CACHE_DIR, skill.skill_id + ".json"), JSON.stringify(skill), "utf-8");
  }
}

/** Shortlist -> the skill_ids it offered, deduped and sorted (stable to compare). */
function shortlist(skills, requestedDomain) {
  stageSkillCache(skills);
  const rows = localShortlistForDomain(requestedDomain, 10);
  return [...new Set(rows.map((r) => r.skill_id))].sort();
}

/** Shortlist -> the endpoint URLs it offered (proves ownership stays registrable-wide). */
function shortlistUrls(skills, requestedDomain) {
  stageSkillCache(skills);
  return localShortlistForDomain(requestedDomain, 10).map((r) => r.url).sort();
}

/* ---------- propagation: findAndMergeDomainSnapshot (src/lib/indexer-core) ---------- */

function stageMergeDir(skills) {
  rmSync(MERGE_DIR, { recursive: true, force: true });
  mkdirSync(MERGE_DIR, { recursive: true });
  for (const skill of skills) {
    writeFileSync(join(MERGE_DIR, skill.skill_id + ".json"), JSON.stringify(skill), "utf-8");
  }
}

/** Merge -> { skill_id, endpointIds } of the accumulated manifest, or null when
 *  no on-disk snapshot was judged to be the same site. */
function merge(onDisk, captureDomain, incoming) {
  stageMergeDir(onDisk);
  const merged = findAndMergeDomainSnapshot(MERGE_DIR, captureDomain, incoming);
  return merged
    ? { skill_id: merged.skill_id, endpointIds: merged.endpoints.map((e) => e.endpoint_id).sort() }
    : null;
}

const out = {
  shortlist: {
    guideForPortal: shortlist([GUIDE], "data.gov.sg"),
    guideForPortalUrl: shortlist([GUIDE], "https://data.gov.sg/datasets"),
    guideForGuide: shortlist([GUIDE], "guide.data.gov.sg"),
    bothForPortal: shortlist([GUIDE, PORTAL], "data.gov.sg"),
    bothForGuide: shortlist([GUIDE, PORTAL], "guide.data.gov.sg"),
    wwwForApex: shortlist([WWW], "example.com"),
    apexForWww: shortlist([APEX], "www.example.com"),
    ownershipUrls: shortlistUrls([WWW], "example.com"),
  },
  merge: {
    guideIntoPortal: merge([GUIDE], "data.gov.sg", PORTAL),
    guideIntoGuide: merge([GUIDE], "guide.data.gov.sg",
      manifest("guide-recapture-0001", "guide.data.gov.sg", "guide-detail",
        "https://guide.data.gov.sg/~gitbook/api/spaces/get-dataset")),
    wwwIntoApex: merge([WWW], "example.com", APEX),
    apexIntoWww: merge([APEX], "www.example.com", WWW),
  },
};
console.log("__RESULT__" + JSON.stringify(out));
`;

type MergeResult = { skill_id: string; endpointIds: string[] } | null;
type DriverResult = {
  shortlist: Record<string, string[]>;
  merge: Record<string, MergeResult>;
};

let out: DriverResult;

beforeAll(() => {
  const driverPath = join(WORK_DIR, "route-scope-propagation-driver.mjs");
  writeFileSync(driverPath, DRIVER, "utf-8");
  const proc = Bun.spawnSync([process.execPath, "run", driverPath], {
    // UNBROWSE_STATELESS is deliberately NOT set — it suppresses the local skill
    // cache and would hide the defect rather than test it. HOME is redirected as a
    // belt-and-braces guard so nothing can reach the developer's real ~/.unbrowse.
    env: {
      ...process.env,
      HOME: WORK_DIR,
      UNBROWSE_SKILL_SNAPSHOT_DIR: SNAPSHOT_DIR,
      UNBROWSE_SKILL_CACHE_DIR: SKILL_CACHE_DIR,
      UNBROWSE_CONFIG_DIR: join(WORK_DIR, "config"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const line = stdout.split("\n").find((row) => row.startsWith("__RESULT__"));
  if (!line) {
    throw new Error(
      `route-scope-propagation driver produced no result\nexit=${proc.exitCode}\nstdout:\n${stdout}\nstderr:\n${proc.stderr.toString()}`,
    );
  }
  out = JSON.parse(line.slice("__RESULT__".length)) as DriverResult;
});

describe("selection — resolve's local shortlist is host-scoped", () => {
  test("a route learned on guide.data.gov.sg is NOT shortlisted for data.gov.sg", () => {
    // THE reproduction, at the call site that answers before any network hop.
    // Under registrable-domain matching both hosts collapse to `gov.sg` and this
    // GitBook route is handed back as "the datasets".
    expect(out.shortlist.guideForPortal).toEqual([]);
    // …and via the `--url` form, which is the one SKILL.md tells agents to use.
    expect(out.shortlist.guideForPortalUrl).toEqual([]);
  });

  test("control: the same route IS still shortlisted for its own host", () => {
    // Proves the fixture is otherwise viable — safe-GET endpoint, reachable cache
    // dir — so the case above is empty for the host-scope reason and not because
    // the shortlist is simply broken.
    expect(out.shortlist.guideForGuide).toEqual([GUIDE_SKILL_ID]);
  });

  test("with both routes cached, each host gets only its own", () => {
    expect(out.shortlist.bothForPortal).toEqual([PORTAL_SKILL_ID]);
    expect(out.shortlist.bothForGuide).toEqual([GUIDE_SKILL_ID]);
  });

  test("legitimate reuse survives: www.example.com ↔ example.com", () => {
    // Not blanket strictness. Over-tightening to exact-hostname equality empties
    // both of these, which turns every request into a cache miss.
    expect(out.shortlist.wwwForApex).toEqual([WWW_SKILL_ID]);
    expect(out.shortlist.apexForWww).toEqual([APEX_SKILL_ID]);
  });

  test("endpoint ownership stays registrable-wide — api. endpoints are not filtered", () => {
    // The skill was captured on www.example.com; its own XHR lives on
    // api.example.com. Route identity is host-scoped; endpoint ownership is not.
    expect(out.shortlist.ownershipUrls).toEqual(["https://api.example.com/search?q={query}"]);
  });
});

describe("propagation — snapshot merge is host-scoped (the back door)", () => {
  test("a guide.data.gov.sg snapshot is NOT merged into a data.gov.sg capture", () => {
    // If it merged, the GitBook endpoint would end up inside a manifest whose own
    // `domain` is data.gov.sg — and every downstream host check, including the
    // orchestrator's new one, would then wave it through.
    expect(out.merge.guideIntoPortal).toBeNull();
  });

  test("control: a guide.data.gov.sg snapshot IS merged into a guide.data.gov.sg capture", () => {
    // Accumulation across captures still works on the site it was learned on —
    // so the case above is null for the host-scope reason, not because merging is
    // dead. Both endpoints are present: this is a real merge, not a passthrough.
    expect(out.merge.guideIntoGuide).toEqual({
      skill_id: GUIDE_SKILL_ID,
      endpointIds: ["guide-detail", "guide-list"],
    });
  });

  test("legitimate reuse survives: captures on www.example.com and example.com accumulate", () => {
    expect(out.merge.wwwIntoApex).toEqual({
      skill_id: WWW_SKILL_ID,
      endpointIds: ["apex-detail", "www-search"],
    });
    expect(out.merge.apexIntoWww).toEqual({
      skill_id: APEX_SKILL_ID,
      endpointIds: ["apex-detail", "www-search"],
    });
  });

  test("endpoint ownership stays registrable-wide — api. endpoints merge freely", () => {
    // Both merged endpoints are hosted on api.example.com while the skills' domains
    // are www.example.com / example.com. Tightening merge on the ENDPOINT host would
    // break every real capture; only the capture CONTEXT is host-scoped.
    expect(out.merge.wwwIntoApex?.endpointIds).toContain("apex-detail");
    expect(out.merge.wwwIntoApex?.endpointIds).toContain("www-search");
  });
});

// Keeps the fixture shape honest against the real type without importing the
// (process-wide mockable) orchestrator module into this process.
export type _RouteScopePropagationFixtureShape = Pick<SkillManifest, "skill_id" | "domain">;
