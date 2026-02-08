/**
 * Demo: Full pipeline — pre/post contribution, typed wrappers, live execution.
 * Run: cd /Users/lekt9/Projects/unbrowse-openclaw && bun run test/e2e/demo-pipeline.ts
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureWithHar } from "../../src/har-capture.js";
import { parseHar, enrichApiData, HarParser } from "../../src/har-parser.js";
import { SkillGenerator } from "../../src/skill-generator.js";
import { ContributionTracker } from "../../src/contribution-tracker.js";

const FIXTURE = join(import.meta.dir, "fixtures", "example.har");
const sep = (title: string) => console.log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
const line = (title: string) => console.log(`\n${"─".repeat(50)}\n${title}\n${"─".repeat(50)}`);

// ── PHASE 1: User A initial skill ──────────────────────────────────────
sep("PHASE 1: USER A — Initial Skill (3 endpoints)");

let userAData = enrichApiData(parseHar(JSON.parse(readFileSync(FIXTURE, "utf-8")), "https://api.example-app.com"));
const outDir = mkdtempSync(join(tmpdir(), "unbrowse-demo-"));
const gen = new SkillGenerator();
const resultA = await gen.generate(userAData, outDir);

console.log(`Endpoints: ${resultA.endpointCount} | Auth: ${resultA.authMethod} | Hash: ${resultA.versionHash}`);
if (userAData.endpointGroups) {
  console.log("\nEndpoint Groups:");
  for (const g of userAData.endpointGroups) {
    console.log(`  ${g.method} ${g.normalizedPath} → ${g.methodName}()  "${g.description}"`);
    if (g.responseBodySchema) console.log(`    Response: ${g.responseBodySchema.summary}`);
  }
}

line("SKILL.md (Pre-Contribution)");
console.log(readFileSync(join(resultA.skillDir, "SKILL.md"), "utf-8"));

line("scripts/api.ts (Pre-Contribution)");
console.log(readFileSync(join(resultA.skillDir, "scripts", "api.ts"), "utf-8"));

line("references/REFERENCE.md (Pre-Contribution)");
console.log(readFileSync(join(resultA.skillDir, "references", "REFERENCE.md"), "utf-8"));

// ── PHASE 2: User B contributes ────────────────────────────────────────
sep("PHASE 2: USER B — Contribution (+4 novel endpoints, +2 auth headers)");

const userBHar = { log: { version: "1.2", creator: { name: "User B", version: "1.0" }, entries: [
  { request: { method: "GET", url: "https://api.example-app.com/v1/users/me", headers: [{ name: "authorization", value: "Bearer eyJ.B.sig" }, { name: "x-team-token", value: "team_999" }], queryString: [], cookies: [] }, response: { status: 200, headers: [{ name: "content-type", value: "application/json" }], content: { mimeType: "application/json", text: '{"id":"B","email":"b@test.com","role":"admin"}' } } },
  { request: { method: "PUT", url: "https://api.example-app.com/v1/projects/proj_1", headers: [{ name: "authorization", value: "Bearer eyJ.B.sig" }, { name: "content-type", value: "application/json" }], queryString: [], cookies: [], postData: { mimeType: "application/json", text: '{"name":"Updated","status":"active"}' } }, response: { status: 200, headers: [{ name: "content-type", value: "application/json" }], content: { mimeType: "application/json", text: '{"id":"proj_1","name":"Updated","status":"active"}' } } },
  { request: { method: "DELETE", url: "https://api.example-app.com/v1/projects/proj_1", headers: [{ name: "authorization", value: "Bearer eyJ.B.sig" }, { name: "x-admin-token", value: "admin_xyz" }], queryString: [], cookies: [] }, response: { status: 204, headers: [], content: { mimeType: "text/plain", text: "" } } },
  { request: { method: "GET", url: "https://api.example-app.com/v1/settings", headers: [{ name: "authorization", value: "Bearer eyJ.B.sig" }], queryString: [], cookies: [] }, response: { status: 200, headers: [{ name: "content-type", value: "application/json" }], content: { mimeType: "application/json", text: '{"theme":"dark","notifications":true,"language":"en"}' } } },
  { request: { method: "GET", url: "https://api.example-app.com/v1/projects/proj_1/members", headers: [{ name: "authorization", value: "Bearer eyJ.B.sig" }], queryString: [], cookies: [] }, response: { status: 200, headers: [{ name: "content-type", value: "application/json" }], content: { mimeType: "application/json", text: '[{"userId":"A","role":"owner"},{"userId":"B","role":"admin"}]' } } },
]}};

const parser = new HarParser();
const userBData = parser.parse(userBHar as any, "https://api.example-app.com");
const tracker = new ContributionTracker();
const epA = tracker.normalizeEndpoints(userAData.requests);
const epB = tracker.normalizeEndpoints(userBData.requests);

const delta = tracker.computeDelta(epA, epB, Object.keys(userAData.authHeaders), [...Object.keys(userAData.authHeaders), "x-team-token", "x-admin-token"]);
console.log(`Novel endpoints: ${delta.newEndpoints.length}`);
for (const ep of delta.newEndpoints) console.log(`  + ${ep.method} ${ep.normalizedPath}`);
console.log(`Novel auth: ${delta.authDiscoveries.join(", ")}`);
console.log(`Novelty score: ${delta.noveltyScore.toFixed(3)}`);

const merged = tracker.mergeContribution(epA, delta);
const proof = tracker.generateNoveltyProof(epA, delta, merged);
console.log(`\nProof chain: ${proof.beforeHash.slice(0,12)}… → ${proof.deltaHash.slice(0,12)}… → ${proof.afterHash.slice(0,12)}…`);

const deltaA = tracker.computeDelta([], epA, [], Object.keys(userAData.authHeaders));
let contribs: any[] = [];
contribs = tracker.updateContributorWeights(contribs, "user-a", deltaA);
contribs = tracker.updateContributorWeights(contribs, "user-b", delta);
console.log(`\nWeights: ${contribs.map(c => `${c.userId}: ${(c.weight*100).toFixed(1)}%`).join(", ")}`);

const payments: Record<string, number> = {};
for (let i = 0; i < 1000; i++) { const r = tracker.selectPaymentRecipient(contribs); payments[r] = (payments[r]||0)+1; }
console.log(`Payments (1000 sims): ${Object.entries(payments).map(([k,v]) => `${k}: ${v}`).join(", ")}`);

// ── PHASE 3: Post-contribution merged skill ────────────────────────────
sep("PHASE 3: POST-CONTRIBUTION — Merged Skill");

for (const req of userBData.requests) {
  const epKey = `${req.domain}:${req.path}`;
  if (!userAData.endpoints[epKey]) userAData.endpoints[epKey] = [];
  if (!userAData.endpoints[epKey].some((r: any) => r.method === req.method && r.path === req.path)) {
    userAData.endpoints[epKey].push(req);
    userAData.requests.push(req);
  }
}
userAData = enrichApiData(userAData);
const resultB = await gen.generate(userAData, outDir);

console.log(`Endpoints: ${resultA.endpointCount} → ${resultB.endpointCount} | Diff: ${resultB.diff}`);
console.log(`Hash: ${resultA.versionHash} → ${resultB.versionHash}`);

if (userAData.endpointGroups) {
  console.log("\nEndpoint Groups (post-merge):");
  for (const g of userAData.endpointGroups) {
    const schema = g.responseBodySchema ? ` → ${g.responseBodySchema.summary}` : "";
    console.log(`  ${g.method} ${g.normalizedPath} → ${g.methodName}()  "${g.description}"${schema}`);
  }
}

line("SKILL.md (Post-Contribution)");
console.log(readFileSync(join(resultB.skillDir, "SKILL.md"), "utf-8"));

line("scripts/api.ts (Post-Contribution — with typed wrappers)");
console.log(readFileSync(join(resultB.skillDir, "scripts", "api.ts"), "utf-8"));

line("references/REFERENCE.md (Post-Contribution)");
console.log(readFileSync(join(resultB.skillDir, "references", "REFERENCE.md"), "utf-8"));

// ── PHASE 4: Live capture — real sites ────────────────────────────────
// Each site: Playwright capture → parse → generate skill → replay endpoints.
// Tests the full pipeline against production internal APIs.

interface SiteConfig {
  name: string;
  seedUrl: string;
  urls: string[];
  replayEndpoints: { m: string; p: string; body?: Record<string, unknown> }[];
}

const SITES: SiteConfig[] = [
  {
    name: "NUSMods",
    seedUrl: "https://api.nusmods.com",
    urls: [
      "https://nusmods.com/modules/CS2030S",
      "https://nusmods.com/modules/CS1101S",
      "https://nusmods.com/venues",
    ],
    replayEndpoints: [
      { m: "GET", p: "/v2/2024-2025/moduleList.json" },
      { m: "GET", p: "/v2/2024-2025/modules/CS2030S.json" },
      { m: "GET", p: "/v2/2024-2025/modules/CS1101S.json" },
    ],
  },
  {
    name: "HackerNews",
    seedUrl: "https://hacker-news.firebaseio.com",
    urls: [
      "https://hacker-news.firebaseio.com/v0/topstories.json",
      "https://hacker-news.firebaseio.com/v0/item/1.json",
      "https://hacker-news.firebaseio.com/v0/user/pg.json",
      "https://hacker-news.firebaseio.com/v0/newstories.json",
      "https://hacker-news.firebaseio.com/v0/beststories.json",
    ],
    replayEndpoints: [
      { m: "GET", p: "/v0/topstories.json" },
      { m: "GET", p: "/v0/item/1.json" },
      { m: "GET", p: "/v0/user/pg.json" },
      { m: "GET", p: "/v0/beststories.json" },
    ],
  },
  {
    name: "GitHub",
    seedUrl: "https://api.github.com",
    urls: [
      "https://api.github.com/repos/torvalds/linux",
      "https://api.github.com/users/torvalds",
      "https://api.github.com/repos/torvalds/linux/commits?per_page=3",
      "https://api.github.com/repos/torvalds/linux/languages",
    ],
    replayEndpoints: [
      { m: "GET", p: "/repos/torvalds/linux" },
      { m: "GET", p: "/users/torvalds" },
      { m: "GET", p: "/repos/torvalds/linux/languages" },
    ],
  },
];

const liveDirs: string[] = [];

for (const site of SITES) {
  sep(`PHASE 4: LIVE — ${site.name}`);

  console.log(`Capturing ${site.name} traffic via Playwright...`);
  let cap;
  try {
    cap = await captureWithHar(site.urls, { headless: true, waitMs: 3000, crawl: false });
  } catch (e: any) {
    console.log(`  ✗ Capture failed: ${e.message}`);
    continue;
  }
  console.log(`Captured ${cap.requestCount} HAR entries`);

  let live = enrichApiData(parseHar(cap.har, site.seedUrl));
  const liveDir = mkdtempSync(join(tmpdir(), `unbrowse-${site.name.toLowerCase()}-`));
  liveDirs.push(liveDir);
  const liveResult = await gen.generate(live, liveDir);

  console.log(`Skill: ${liveResult.service} | ${liveResult.endpointCount} endpoints | Auth: ${liveResult.authMethod}`);

  if (live.endpointGroups) {
    console.log("\nEndpoint Groups:");
    for (const g of live.endpointGroups) {
      const schema = g.responseBodySchema ? ` → ${g.responseBodySchema.summary}` : "";
      const qp = g.queryParams?.length ? ` [${g.queryParams.map(p => p.name).join(",")}]` : "";
      console.log(`  ${g.method} ${g.normalizedPath}${qp} → ${g.methodName}()${schema}`);
    }
  }

  line(`scripts/api.ts (${site.name} — typed wrappers)`);
  console.log(readFileSync(join(liveResult.skillDir, "scripts", "api.ts"), "utf-8"));

  line(`EXECUTING ${site.name} endpoints`);
  for (const ep of site.replayEndpoints) {
    try {
      const url = `${live.baseUrl}${ep.p}`;
      const opts: RequestInit = { method: ep.m, headers: { "Accept": "application/json", "User-Agent": "unbrowse-test/1.0" } };
      if (ep.body) { (opts.headers as Record<string, string>)["Content-Type"] = "application/json"; opts.body = JSON.stringify(ep.body); }
      const r = await fetch(url, opts);
      const text = await r.text();
      let preview: string;
      try { preview = JSON.stringify(JSON.parse(text)).slice(0, 100); } catch { preview = text.slice(0, 100); }
      console.log(`  ${r.ok ? "✓" : "✗"} ${ep.m} ${ep.p} → ${r.status}  ${preview}…`);
    } catch (e: any) { console.log(`  ✗ ${ep.m} ${ep.p} → ${e.message}`); }
  }
}

rmSync(outDir, { recursive: true, force: true });
for (const d of liveDirs) rmSync(d, { recursive: true, force: true });
sep("DONE");
