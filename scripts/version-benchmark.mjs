#!/usr/bin/env node
/**
 * version-benchmark.mjs — compare Unbrowse across npm versions
 *
 * For each version: install in temp dir, start server, run a set of sites,
 * record capture success + endpoint count. Save results for comparison.
 *
 * Usage:
 *   node scripts/version-benchmark.mjs --versions "2.0.0,2.9.0,3.0.0,3.2.0,3.4.1" \
 *     --sites "shein,g2,realtor,target" --out evals/version-benchmark.json
 *
 *   node scripts/version-benchmark.mjs --versions "staging" \
 *     --sites "shein,g2,realtor,target" --out evals/version-benchmark.json
 *     (staging = run from local source)
 */

import { execSync, spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// Parse args
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

const versionsArg = getArg("versions") ?? "3.4.1";
const versions = versionsArg.split(",").map((v) => v.trim());
const outPath = getArg("out") ?? join(REPO_ROOT, "evals", "version-benchmark.json");

// Benchmark sites — the impossible tier + a few hard ones
const BENCHMARK_SITES = [
  { id: "shein", url: "https://www.shein.com/recommend/Women-New-in-sc-100161222.html", intent: "get product prices" },
  { id: "g2", url: "https://www.g2.com/products/salesforce-crm/reviews", intent: "get software reviews" },
  { id: "realtor", url: "https://www.realtor.com/realestateandhomes-search/San-Francisco_CA", intent: "get property listings" },
  { id: "target", url: "https://www.target.com/s?searchTerm=headphones", intent: "get product prices" },
  { id: "tiktok", url: "https://www.tiktok.com/@nasa", intent: "get profile videos" },
  { id: "nike", url: "https://www.nike.com/w/mens-shoes-nik1zy7ok", intent: "search shoes" },
  { id: "coinmarketcap", url: "https://coinmarketcap.com/currencies/ethereum/", intent: "get token info" },
  { id: "amazon", url: "https://www.amazon.com/s?k=mechanical+keyboard", intent: "search products" },
];

const sitesFilter = getArg("sites")?.split(",").map((s) => s.trim());
const sites = sitesFilter
  ? BENCHMARK_SITES.filter((s) => sitesFilter.includes(s.id))
  : BENCHMARK_SITES;

console.log(`Version benchmark: ${versions.join(", ")} × ${sites.length} sites`);

const results = {
  timestamp: new Date().toISOString(),
  versions: {},
};

for (const version of versions) {
  console.log(`\n=== VERSION ${version} ===`);
  const versionResults = [];

  // Install version in temp dir
  const tmpDir = join(tmpdir(), `unbrowse-bench-${version}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  let binPath;
  if (version === "staging") {
    // Use local source
    binPath = null; // will use bun src/cli.ts
    console.log(`  using local source`);
  } else {
    try {
      execSync(`npm install unbrowse@${version} --prefix "${tmpDir}" --no-save 2>/dev/null`, {
        timeout: 60_000,
        stdio: "pipe",
      });
      binPath = join(tmpDir, "node_modules", ".bin", "unbrowse");
      if (!existsSync(binPath)) {
        // Try the package bin directly
        binPath = join(tmpDir, "node_modules", "unbrowse", "dist", "cli.js");
      }
      console.log(`  installed at ${binPath}`);
    } catch (err) {
      console.log(`  SKIP: failed to install v${version}: ${err.message?.slice(0, 80)}`);
      results.versions[version] = { error: "install_failed", sites: [] };
      continue;
    }
  }

  for (const site of sites) {
    console.log(`  ${site.id}...`);

    // Kill any stale processes
    try { execSync("pkill -9 -f 'unbrowse|kuri|chrome' 2>/dev/null", { stdio: "pipe" }); } catch {}
    await new Promise((r) => setTimeout(r, 3000));

    try {
      // Start server
      let serverProc;
      let apiUrl;
      if (version === "staging") {
        serverProc = spawn("bun", ["src/index.ts"], {
          cwd: REPO_ROOT,
          env: { ...process.env, PORT: "6969" },
          stdio: "pipe",
        });
        apiUrl = "http://127.0.0.1:6969";
      } else {
        // Start the version's server
        serverProc = spawn("node", [binPath, "health"], {
          cwd: tmpDir,
          stdio: "pipe",
        });
        apiUrl = "http://127.0.0.1:6969"; // default port
      }

      await new Promise((r) => setTimeout(r, 5000));

      // Capture
      const goRes = await fetch(`${apiUrl}/v1/browse/go`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: site.url }),
      }).then((r) => r.json()).catch(() => ({ error: "go_failed" }));

      if (!goRes.ok) {
        versionResults.push({ id: site.id, capture: "error", endpoints: 0, requests: 0 });
        serverProc.kill("SIGKILL");
        continue;
      }

      await new Promise((r) => setTimeout(r, 5000));

      // Close
      const closeRes = await fetch(`${apiUrl}/v1/browse/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then((r) => r.json()).catch(() => ({ error: "close_failed" }));

      const ep = closeRes.endpoint_count ?? 0;
      const req = closeRes.request_count ?? 0;
      console.log(`    ep=${ep} req=${req}`);
      versionResults.push({ id: site.id, capture: "ok", endpoints: ep, requests: req });

      serverProc.kill("SIGKILL");
    } catch (err) {
      console.log(`    ERROR: ${err.message?.slice(0, 80)}`);
      versionResults.push({ id: site.id, capture: "error", endpoints: 0, requests: 0, error: err.message?.slice(0, 100) });
    }
  }

  results.versions[version] = {
    sites: versionResults,
    total_endpoints: versionResults.reduce((s, r) => s + r.endpoints, 0),
    capture_rate: versionResults.filter((r) => r.capture === "ok").length / versionResults.length,
  };

  // Cleanup
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// Save results
writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
console.log(`\n=== RESULTS ===`);
console.log(`Saved to ${outPath}`);

// Print comparison table
console.log(`\n${"Site".padEnd(20)} ${versions.map((v) => v.padStart(10)).join("")}`);
console.log("-".repeat(20 + versions.length * 10));
for (const site of sites) {
  const row = versions.map((v) => {
    const vr = results.versions[v]?.sites?.find((s) => s.id === site.id);
    return vr ? String(vr.endpoints).padStart(10) : "    -".padStart(10);
  });
  console.log(`${site.id.padEnd(20)} ${row.join("")}`);
}
console.log("-".repeat(20 + versions.length * 10));
const totals = versions.map((v) => {
  return String(results.versions[v]?.total_endpoints ?? 0).padStart(10);
});
console.log(`${"TOTAL".padEnd(20)} ${totals.join("")}`);
