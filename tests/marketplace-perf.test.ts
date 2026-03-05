/**
 * Marketplace pipeline performance diagnostics.
 * Tests each step independently to isolate where the 39s latency comes from.
 *
 * Run: bun test tests/marketplace-perf.test.ts
 */
import { describe, it, expect } from "bun:test";

const API_URL = "https://beta-api.unbrowse.ai";

// Load API key from config
function getApiKey(): string {
  if (process.env.UNBROWSE_API_KEY) return process.env.UNBROWSE_API_KEY;
  try {
    const config = JSON.parse(
      require("fs").readFileSync(
        require("path").join(require("os").homedir(), ".unbrowse", "config.json"),
        "utf-8"
      )
    );
    return config.api_key ?? "";
  } catch {
    return "";
  }
}

async function timedFetch(
  label: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ data: unknown; ms: number; status: number }> {
  const key = getApiKey();
  const t0 = performance.now();
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  const ms = Math.round(performance.now() - t0);
  console.log(`  [${label}] ${method} ${path} → ${res.status} in ${ms}ms`);
  return { data, ms, status: res.status };
}

describe("Marketplace Pipeline Perf", () => {
  // Step 0: Basic connectivity
  it("health check to beta-api", async () => {
    const t0 = performance.now();
    const res = await fetch(`${API_URL}/health`);
    const ms = Math.round(performance.now() - t0);
    console.log(`  [health] ${res.status} in ${ms}ms`);
    expect(res.ok).toBe(true);
    expect(ms).toBeLessThan(5000);
  }, 10_000);

  // Step 1a: Domain-scoped search
  it("search/domain latency (linkedin)", async () => {
    const { ms, data, status } = await timedFetch(
      "search/domain",
      "POST",
      "/v1/search/domain",
      { intent: "get linkedin feed posts", domain: "linkedin.com", k: 5 }
    );
    console.log(`  results: ${(data as any).results?.length ?? 0}`);
    expect(status).toBe(200);
    expect(ms).toBeLessThan(10_000); // should be <5s, flagging at 10s
  }, 60_000);

  // Step 1b: Global search
  it("search intent latency (global)", async () => {
    const { ms, data, status } = await timedFetch(
      "search/global",
      "POST",
      "/v1/search",
      { intent: "get linkedin feed posts", k: 10 }
    );
    console.log(`  results: ${(data as any).results?.length ?? 0}`);
    expect(status).toBe(200);
    expect(ms).toBeLessThan(10_000);
  }, 60_000);

  // Step 1c: Both in parallel (mirrors orchestrator)
  it("parallel search (domain + global) latency", async () => {
    const t0 = performance.now();
    const [domain, global_] = await Promise.all([
      timedFetch("search/domain", "POST", "/v1/search/domain", {
        intent: "get linkedin feed posts",
        domain: "linkedin.com",
        k: 5,
      }),
      timedFetch("search/global", "POST", "/v1/search", {
        intent: "get linkedin feed posts",
        k: 10,
      }),
    ]);
    const totalMs = Math.round(performance.now() - t0);
    console.log(`  [parallel] total wall-clock: ${totalMs}ms`);
    console.log(`  domain results: ${(domain.data as any).results?.length ?? 0}`);
    console.log(`  global results: ${(global_.data as any).results?.length ?? 0}`);
    expect(totalMs).toBeLessThan(15_000);
  }, 60_000);

  // Step 2: getSkill latency for marketplace candidates
  it("getSkill latency (single skill)", async () => {
    // First find a skill via search
    const { data: searchData } = await timedFetch(
      "search",
      "POST",
      "/v1/search/domain",
      { intent: "get feed posts", domain: "linkedin.com", k: 1 }
    );
    const results = (searchData as any).results ?? [];
    if (results.length === 0) {
      console.log("  [skip] no marketplace results to test getSkill");
      return;
    }

    const metadata = results[0].metadata;
    let skillId: string;
    try {
      skillId = JSON.parse(metadata.content).skill_id;
    } catch {
      console.log("  [skip] could not extract skill_id from metadata");
      return;
    }

    const { ms, status } = await timedFetch(
      "getSkill",
      "GET",
      `/v1/skills/${skillId}`,
      undefined
    );
    expect(status).toBe(200);
    expect(ms).toBeLessThan(5_000);
  }, 60_000);

  // Step 2b: getSkill for N candidates in parallel
  it("getSkill latency (5 candidates in parallel)", async () => {
    const { data: searchData } = await timedFetch(
      "search",
      "POST",
      "/v1/search",
      { intent: "get feed posts", k: 5 }
    );
    const results = (searchData as any).results ?? [];
    if (results.length === 0) {
      console.log("  [skip] no marketplace results");
      return;
    }

    const skillIds: string[] = [];
    for (const r of results) {
      try {
        const sid = JSON.parse(r.metadata.content).skill_id;
        if (sid && !skillIds.includes(sid)) skillIds.push(sid);
      } catch {}
    }
    console.log(`  fetching ${skillIds.length} skills in parallel`);

    const t0 = performance.now();
    const fetches = await Promise.all(
      skillIds.map((id) =>
        timedFetch(`getSkill-${id.slice(0, 8)}`, "GET", `/v1/skills/${id}`)
      )
    );
    const totalMs = Math.round(performance.now() - t0);
    console.log(`  [parallel getSkill] wall-clock: ${totalMs}ms`);

    for (const f of fetches) {
      console.log(`    ${f.status} in ${f.ms}ms`);
    }
    expect(totalMs).toBeLessThan(10_000);
  }, 60_000);

  // Step 3: Local disk cache read performance
  it("disk cache read latency", async () => {
    const { readFileSync, readdirSync, existsSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");
    const cacheDir = join(homedir(), ".unbrowse", "skill-cache");

    if (!existsSync(cacheDir)) {
      console.log("  [skip] no skill cache dir");
      return;
    }

    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
    console.log(`  ${files.length} cached skills on disk`);

    const t0 = performance.now();
    let parsed = 0;
    for (const f of files) {
      try {
        JSON.parse(readFileSync(join(cacheDir, f), "utf-8"));
        parsed++;
      } catch {}
    }
    const ms = Math.round(performance.now() - t0);
    console.log(`  read+parse ${parsed}/${files.length} skills in ${ms}ms`);
    expect(ms).toBeLessThan(1000); // should be <100ms for local I/O
  }, 10_000);

  // Step 4: findExistingSkillForDomain performance
  it("findExistingSkillForDomain latency", async () => {
    const { readFileSync, readdirSync, existsSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");
    const cacheDir = join(homedir(), ".unbrowse", "skill-cache");

    if (!existsSync(cacheDir)) {
      console.log("  [skip] no cache");
      return;
    }

    const t0 = performance.now();
    const files = readdirSync(cacheDir);
    let found = false;
    for (const f of files) {
      if (!f.endsWith(".json") || f === "browser-capture.json") continue;
      try {
        const skill = JSON.parse(readFileSync(join(cacheDir, f), "utf-8"));
        if (skill.domain === "www.linkedin.com" && skill.execution_type === "http") {
          found = true;
          console.log(`  found: ${skill.skill_id} with ${skill.endpoints?.length} endpoints`);
          // Check trigger_url matching
          for (const ep of skill.endpoints ?? []) {
            if (ep.trigger_url) {
              console.log(`    endpoint ${ep.endpoint_id}: trigger_url=${ep.trigger_url}`);
            }
          }
          break;
        }
      } catch {}
    }
    const ms = Math.round(performance.now() - t0);
    console.log(`  scan completed in ${ms}ms, found=${found}`);
    expect(ms).toBeLessThan(500);
  }, 10_000);

  // Step 5: DNS + TLS overhead to beta-api
  it("DNS + TLS overhead (3 sequential fetches)", async () => {
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await fetch(`${API_URL}/health`);
      times.push(Math.round(performance.now() - t0));
    }
    console.log(`  sequential health checks: ${times.join("ms, ")}ms`);
    console.log(`  1st call (cold): ${times[0]}ms, 2nd+ (warm): ${times.slice(1).join("ms, ")}ms`);
    // First call includes DNS+TLS, subsequent should be faster
    expect(times[1]).toBeLessThan(times[0] * 2); // warm shouldn't be worse
  }, 30_000);

  // Step 6: End-to-end orchestrator timing via local server
  it("local intent/resolve timing breakdown", async () => {
    const t0 = performance.now();
    const res = await fetch("http://localhost:6969/v1/intent/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "get linkedin feed posts",
        params: { url: "https://www.linkedin.com/feed" },
        context: { url: "https://www.linkedin.com/feed" },
      }),
    });
    const totalMs = Math.round(performance.now() - t0);

    if (!res.ok) {
      console.log(`  [error] ${res.status} in ${totalMs}ms`);
      const text = await res.text();
      console.log(`  ${text.slice(0, 500)}`);
      return;
    }

    const data = (await res.json()) as any;
    console.log(`  [e2e] total: ${totalMs}ms`);
    console.log(`  timing from server:`, JSON.stringify(data.timing, null, 2));
    console.log(`  source: ${data.source}`);
    console.log(`  cache_hit: ${data.timing?.cache_hit}`);

    // After the first run, route-cache should kick in — expect <5s
    if (data.timing?.cache_hit) {
      expect(totalMs).toBeLessThan(5_000);
    }
  }, 120_000);
});
