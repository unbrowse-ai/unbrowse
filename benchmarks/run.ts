#!/usr/bin/env npx tsx
/**
 * Unbrowse Benchmark Suite
 *
 * Measures live-capture vs marketplace skill execution across a set of
 * representative web tasks.  Each task is run twice:
 *   Pass 1 — may trigger live capture (slow path) or hit the marketplace.
 *   Pass 2 — should hit the marketplace or route cache (fast path).
 *
 * Usage:
 *   npx tsx benchmarks/run.ts                 # run all tasks
 *   npx tsx benchmarks/run.ts --filter news   # run tasks matching "news"
 *   npx tsx benchmarks/run.ts --passes 3      # run 3 passes per task
 *   npx tsx benchmarks/run.ts --out results/my-run.json
 */

const UNBROWSE_URL = process.env.UNBROWSE_URL ?? "http://localhost:6969";
const RESOLVE_ENDPOINT = `${UNBROWSE_URL}/v1/intent/resolve`;
const MAX_TIMEOUT_MS = 120_000;

interface Task {
  intent: string;
  url: string;
  category: string;
}

const TASKS: Task[] = [
  // News & Content
  { intent: "get top news headlines", url: "https://news.ycombinator.com", category: "news" },
  { intent: "get latest tech news", url: "https://techcrunch.com", category: "news" },
  { intent: "search for AI papers", url: "https://arxiv.org", category: "news" },

  // Developer Tools
  { intent: "get trending repositories", url: "https://github.com/trending", category: "dev" },
  { intent: "search for npm packages", url: "https://npmjs.com", category: "dev" },
  { intent: "get API documentation", url: "https://stripe.com/docs", category: "dev" },

  // Finance
  { intent: "get stock price for AAPL", url: "https://finance.yahoo.com/quote/AAPL", category: "finance" },
  { intent: "get bitcoin price", url: "https://coinbase.com", category: "finance" },
  { intent: "get cryptocurrency prices", url: "https://coinmarketcap.com", category: "finance" },
  { intent: "get market overview", url: "https://tradingview.com", category: "finance" },

  // E-commerce
  { intent: "search for running shoes", url: "https://nike.com", category: "ecommerce" },
  { intent: "search for laptops", url: "https://amazon.com", category: "ecommerce" },
  { intent: "get product reviews", url: "https://bestbuy.com", category: "ecommerce" },

  // Travel
  { intent: "get weather forecast for San Francisco", url: "https://weather.com", category: "travel" },
  { intent: "search for flights from SFO to LAX", url: "https://www.google.com/travel/flights", category: "travel" },
  { intent: "get hotel prices in Tokyo", url: "https://booking.com", category: "travel" },

  // Social
  { intent: "get trending topics", url: "https://twitter.com", category: "social" },
  { intent: "get latest posts", url: "https://reddit.com", category: "social" },

  // Local / Food
  { intent: "find coffee shops nearby", url: "https://google.com/maps", category: "local" },
  { intent: "get restaurant menu", url: "https://doordash.com", category: "local" },

  // Jobs
  { intent: "search for jobs in engineering", url: "https://indeed.com", category: "jobs" },
  { intent: "get event listings", url: "https://eventbrite.com", category: "jobs" },
];

interface PassResult {
  pass: number;
  source: string;
  resolve_ms: number;
  tokens_saved: number;
  tokens_saved_pct: number;
  time_saved_pct: number;
  skill_id: string | null;
  error: string | null;
  has_data: boolean;
}

interface TaskResult {
  intent: string;
  url: string;
  category: string;
  passes: PassResult[];
  speedup: number | null;
}

async function resolveOnce(task: Task): Promise<PassResult> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MAX_TIMEOUT_MS);

    const res = await fetch(RESOLVE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: task.intent, context: { url: task.url } }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const body = await res.json();
    const wall = Date.now() - start;
    const timing = body.timing ?? {};

    return {
      pass: 0,
      source: timing.source ?? "unknown",
      resolve_ms: timing.total_ms ?? wall,
      tokens_saved: timing.tokens_saved ?? 0,
      tokens_saved_pct: timing.tokens_saved_pct ?? 0,
      time_saved_pct: timing.time_saved_pct ?? 0,
      skill_id: timing.skill_id ?? null,
      error: body.error ?? null,
      has_data: body.data != null,
    };
  } catch (err: any) {
    return {
      pass: 0,
      source: "error",
      resolve_ms: Date.now() - start,
      tokens_saved: 0,
      tokens_saved_pct: 0,
      time_saved_pct: 0,
      skill_id: null,
      error: err.message?.slice(0, 120) ?? "unknown error",
      has_data: false,
    };
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const filterIdx = args.indexOf("--filter");
  const filter = filterIdx >= 0 ? args[filterIdx + 1] : null;
  const passesIdx = args.indexOf("--passes");
  const numPasses = passesIdx >= 0 ? parseInt(args[passesIdx + 1], 10) : 2;
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : `benchmarks/results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

  const tasks = filter
    ? TASKS.filter((t) => t.intent.includes(filter) || t.category.includes(filter) || t.url.includes(filter))
    : TASKS;

  console.log(`\nUnbrowse Benchmark Suite`);
  console.log(`Tasks: ${tasks.length} | Passes: ${numPasses} | Output: ${outPath}`);
  console.log(`Server: ${UNBROWSE_URL}`);
  console.log("=".repeat(120));

  const header = `${"Task".padEnd(45)} ${"Category".padEnd(12)}`;
  const passHeaders = Array.from({ length: numPasses }, (_, i) => `P${i + 1} Source`.padEnd(16) + `P${i + 1} ms`.padEnd(10)).join(" ");
  console.log(`${header} ${passHeaders} ${"Speedup".padEnd(10)} ${"Tokens".padEnd(10)}`);
  console.log("-".repeat(120));

  const results: TaskResult[] = [];

  for (const task of tasks) {
    const passes: PassResult[] = [];

    for (let p = 0; p < numPasses; p++) {
      const result = await resolveOnce(task);
      result.pass = p + 1;
      passes.push(result);
      if (p < numPasses - 1) await sleep(1000);
    }

    const first = passes[0];
    const last = passes[passes.length - 1];
    const speedup = last.resolve_ms > 0 ? first.resolve_ms / last.resolve_ms : null;
    const tokens = last.tokens_saved || first.tokens_saved;

    const passStr = passes
      .map((p) => `${p.source.padEnd(16)} ${String(p.resolve_ms).padEnd(10)}`)
      .join(" ");

    const speedupStr = speedup != null ? `${speedup.toFixed(1)}x` : "N/A";
    console.log(`${task.intent.slice(0, 44).padEnd(45)} ${task.category.padEnd(12)} ${passStr} ${speedupStr.padEnd(10)} ${tokens}`);

    results.push({ ...task, passes, speedup });
  }

  // Summary
  console.log("\n" + "=".repeat(80));
  const successful = results.filter(
    (r) => r.passes.length >= 2 && r.passes[r.passes.length - 1].source !== "error" && r.passes[0].source !== "error"
  );

  const liveToMkt = successful.filter(
    (r) => r.passes[0].source === "live-capture" && r.passes[r.passes.length - 1].source === "marketplace"
  );

  const mktToMkt = successful.filter(
    (r) => r.passes[0].source === "marketplace"
  );

  console.log(`\nTotal tasks: ${results.length}`);
  console.log(`Successful: ${successful.length}`);
  console.log(`  Live -> Marketplace: ${liveToMkt.length}`);
  console.log(`  Marketplace -> Marketplace: ${mktToMkt.length}`);
  console.log(`  Errors: ${results.length - successful.length}`);

  if (liveToMkt.length > 0) {
    const avgLive = liveToMkt.reduce((s, r) => s + r.passes[0].resolve_ms, 0) / liveToMkt.length;
    const avgMkt = liveToMkt.reduce((s, r) => s + r.passes[r.passes.length - 1].resolve_ms, 0) / liveToMkt.length;
    const avgTokens = liveToMkt.reduce((s, r) => s + (r.passes[r.passes.length - 1].tokens_saved || 0), 0) / liveToMkt.length;
    console.log(`\nLive -> Marketplace:`);
    console.log(`  Avg live capture: ${(avgLive / 1000).toFixed(1)}s`);
    console.log(`  Avg marketplace:  ${(avgMkt / 1000).toFixed(1)}s`);
    console.log(`  Avg speedup:      ${(avgLive / avgMkt).toFixed(1)}x`);
    console.log(`  Avg tokens saved: ${avgTokens.toFixed(0)}`);
  }

  if (mktToMkt.length > 0) {
    const avgMs = mktToMkt.reduce((s, r) => s + r.passes[r.passes.length - 1].resolve_ms, 0) / mktToMkt.length;
    console.log(`\nMarketplace (warm):`);
    console.log(`  Avg resolve: ${(avgMs / 1000).toFixed(1)}s`);
  }

  // Write results
  const { mkdirSync, writeFileSync } = await import("fs");
  const { dirname } = await import("path");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        server: UNBROWSE_URL,
        num_passes: numPasses,
        tasks: results,
        summary: {
          total: results.length,
          successful: successful.length,
          live_to_marketplace: liveToMkt.length,
          marketplace_warm: mktToMkt.length,
          errors: results.length - successful.length,
        },
      },
      null,
      2
    )
  );
  console.log(`\nResults written to ${outPath}`);
}

main().catch(console.error);
