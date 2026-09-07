// Witness for Wave 2 gap A: the CLI now POSTs a deploy to the server graph
// (/v1/contract/mirror). The gap was "the server route exists but is never called
// from the CLI". Hermetic — a mock fetch captures the POST; no live beta-api.
import { createThinClient } from "../src/lib/contract-thin-client.js";
import { recordDeploy, type DeployManifest } from "../src/values/contract-deploy.js";

type Captured = { url: string; method: string; auth: string | null; body: any };
function mockFetch(captured: Captured[]): typeof fetch {
  return (async (url: string, init: any) => {
    captured.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: (init?.headers?.Authorization ?? init?.headers?.authorization) ?? null,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ mirrored: true, mirrored_at: "2026-06-23T00:00:00.000Z" }),
      text: async () => "",
    } as any;
  }) as unknown as typeof fetch;
}

let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fail++; };

// 1. The thin-client mirror method POSTs {row} to /v1/contract/mirror with Bearer auth.
{
  const cap: Captured[] = [];
  const client = createThinClient({ apiKey: "test-key", fetchImpl: mockFetch(cap) });
  const res = await client.mirror({ event: "declared", id: "deploy:test:1", ts: "2026-06-23T00:00:00.000Z", plan: "p", action: "deploy:cli" });
  const hit = cap[0];
  ok(hit?.url.endsWith("/v1/contract/mirror"), `mirror() hits /v1/contract/mirror (got ${hit?.url})`);
  ok(hit?.method === "POST", "mirror() is a POST");
  ok(hit?.auth === "Bearer test-key", `mirror() carries Bearer auth (got ${hit?.auth})`);
  ok(hit?.body?.row?.id === "deploy:test:1", "mirror() body is { row } with the row id");
  ok(res.mirrored === true, "mirror() returns the server's mirrored=true");
}

// 2. recordDeploy WITH an apiKey fires the mirror POST (the integration wire).
const m: DeployManifest = { kind: "cli", release_version: "10.0.0", git_sha: "deadbeef1234", target: "npm", ts: 1782000000000 };
{
  const cap: Captured[] = [];
  const rec = await recordDeploy(m, { apiKey: "test-key", fetchImpl: mockFetch(cap) });
  const mirrorCall = cap.find((c) => c.url.endsWith("/v1/contract/mirror"));
  ok(!!mirrorCall, "recordDeploy() POSTs the deploy to /v1/contract/mirror");
  ok(mirrorCall?.body?.row?.action === "deploy:cli", "recordDeploy() row action = deploy:<kind>");
  ok(rec.mirrored.state === "mirrored", `recordDeploy().mirrored.state === 'mirrored' (got ${rec.mirrored.state})`);
}

// 3. recordDeploy WITHOUT an apiKey skips the mirror — fail-open, never blocks (offline-first).
{
  const prev = { k: process.env.UNBROWSE_API_KEY, a: process.env.UNBROWSE_ADMIN_KEY };
  delete process.env.UNBROWSE_API_KEY; delete process.env.UNBROWSE_ADMIN_KEY;
  const cap: Captured[] = [];
  const rec = await recordDeploy(m, { fetchImpl: mockFetch(cap) });
  ok(rec.mirrored.state === "skipped", `no-key → mirror skipped, deploy not blocked (got ${rec.mirrored.state})`);
  ok(!cap.some((c) => c.url.endsWith("/v1/contract/mirror")), "no-key → NO mirror POST fired (fail-open)");
  if (prev.k) process.env.UNBROWSE_API_KEY = prev.k;
  if (prev.a) process.env.UNBROWSE_ADMIN_KEY = prev.a;
}

if (fail === 0) { console.log("CONTRACT_DEPLOY_MIRROR_OK — Wave 2 gap A: CLI→server mirror wired"); process.exit(0); }
console.error(`CONTRACT_DEPLOY_MIRROR_FAIL — ${fail} check(s) failed`); process.exit(1);
