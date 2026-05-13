#!/usr/bin/env bun
// Day-9 follow-up — sibling bench for the four B-fixes landed during the
// 2026-05-13 Jesus Loop. Closes AC7 (spirit): projection-bench.mjs gates the
// AC3 wire-budget surface; this bench gates B1/B2/B3/probe-Retry-After so any
// future regression on those helpers shows up as a bench-delta failure.
//
// Scenarios:
//   B1.free           - probePortOwnership on an unbound high port -> kind:"free"
//   B1.foreign        - probePortOwnership on a port held by net.createServer -> kind:"foreign"
//   B2.status_changed - deriveRecipeReplayNextStep(reason="status_changed: 200 -> 404") yields concrete hint + suffix
//   B2.missing_keys   - deriveRecipeReplayNextStep(reason="missing_top_keys: data,error") yields hint that mentions schema or force-capture
//   B2.body_shrunk    - deriveRecipeReplayNextStep(reason="body_shrunk: 12B < min 100B") yields hint that mentions byte-length window
//   B3.delta-seconds  - parseRetryAfter({"retry-after":"30"}) -> 30000
//   B3.http-date      - parseRetryAfter({"retry-after": "<+60s UTC>"}) -> ~60000
//   B3.array-valued   - parseRetryAfter({"retry-after":["45","60"]}) -> 45000
//   probe.retry_after - real http 429 + Retry-After:30 -> probe.retry_after === "30"
//
// Each scenario PASS/FAIL is decided here; aggregate exit code is 0 iff all
// scenarios pass. No mocks: real net.createServer, real http server, real
// helper imports per CLAUDE.md.
//
// Usage: bun .harness-out/b-fixes-bench.mjs

import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

async function runScenario(name, fn) {
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    console.log(`PASS  ${name.padEnd(28)} ${ms}ms`);
    return true;
  } catch (err) {
    const ms = Date.now() - start;
    console.log(`FAIL  ${name.padEnd(28)} ${ms}ms  ${err && err.message ? err.message : String(err)}`);
    return false;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

async function bindForeignPort() {
  const server = net.createServer();
  const port = await new Promise((res, rej) => {
    server.once("listening", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") res(addr.port);
      else rej(new Error("no addr"));
    });
    server.once("error", rej);
    server.listen(0, "127.0.0.1");
  });
  return { port, close: () => new Promise(r => server.close(() => r())) };
}

async function startHttp429(retryAfter) {
  const server = http.createServer((req, res) => {
    const headers = { "Content-Type": "text/plain" };
    if (retryAfter !== null) headers["Retry-After"] = retryAfter;
    res.writeHead(429, headers);
    res.end("rate limited");
  });
  const port = await new Promise((res, rej) => {
    server.once("listening", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") res(addr.port);
      else rej(new Error("no addr"));
    });
    server.once("error", rej);
    server.listen(0, "127.0.0.1");
  });
  return { port, close: () => new Promise(r => server.close(() => r())) };
}

const results = [];

// B1.free
results.push(await runScenario("B1.free", async () => {
  const { probePortOwnership } = await import(path.join(REPO, "src", "runtime", "local-server.ts"));
  const r = await probePortOwnership("http://127.0.0.1:54983");
  assert(r.kind === "free", `expected kind:free, got ${r.kind}`);
}));

// B1.foreign
results.push(await runScenario("B1.foreign", async () => {
  const { probePortOwnership } = await import(path.join(REPO, "src", "runtime", "local-server.ts"));
  const srv = await bindForeignPort();
  try {
    const r = await probePortOwnership(`http://127.0.0.1:${srv.port}`);
    assert(r.kind === "foreign", `expected kind:foreign, got ${r.kind}`);
  } finally {
    await srv.close();
  }
}));

// B2.status_changed
results.push(await runScenario("B2.status_changed", async () => {
  const { deriveRecipeReplayNextStep } = await import(path.join(REPO, "src", "execution", "recipe-replay-hints.ts"));
  const hint = deriveRecipeReplayNextStep("status_changed: 200 -> 404", {
    url: "https://example.com/x", status: 404, endpointId: "ep_bench_1",
  });
  assert(typeof hint === "string" && hint.length > 20, "hint too short");
  assert(hint.includes("ep_bench_1"), "hint missing endpoint id");
  assert(/force-capture|contract|status/i.test(hint), "hint not actionable for status_changed");
}));

// B2.missing_keys
results.push(await runScenario("B2.missing_keys", async () => {
  const { deriveRecipeReplayNextStep } = await import(path.join(REPO, "src", "execution", "recipe-replay-hints.ts"));
  const hint = deriveRecipeReplayNextStep("missing_top_keys: data,error", {
    url: "https://example.com/y", status: 200, endpointId: "ep_bench_2",
  });
  assert(typeof hint === "string" && hint.length > 20, "hint too short");
  assert(/schema|missing|force-capture/i.test(hint), "hint not actionable for missing_top_keys");
  assert(hint.includes("ep_bench_2"), "hint missing endpoint id");
}));

// B2.body_shrunk
results.push(await runScenario("B2.body_shrunk", async () => {
  const { deriveRecipeReplayNextStep } = await import(path.join(REPO, "src", "execution", "recipe-replay-hints.ts"));
  const hint = deriveRecipeReplayNextStep("body_shrunk: 12B < min 100B", {
    url: "https://example.com/z", status: 200, endpointId: "ep_bench_3",
  });
  assert(typeof hint === "string" && hint.length > 20, "hint too short");
  assert(/byte|window|stub|error page|paginat/i.test(hint), "hint not actionable for body_shrunk");
}));

// B3.delta-seconds
results.push(await runScenario("B3.delta-seconds", async () => {
  const { parseRetryAfter } = await import(path.join(REPO, "src", "execution", "retry.ts"));
  const ms = parseRetryAfter({ "retry-after": "30" });
  assert(ms === 30_000, `expected 30000, got ${ms}`);
}));

// B3.http-date
results.push(await runScenario("B3.http-date", async () => {
  const { parseRetryAfter } = await import(path.join(REPO, "src", "execution", "retry.ts"));
  const future = new Date(Date.now() + 60_000).toUTCString();
  const ms = parseRetryAfter({ "retry-after": future });
  assert(typeof ms === "number" && ms > 55_000 && ms < 65_000, `expected ~60000, got ${ms}`);
}));

// B3.array-valued
results.push(await runScenario("B3.array-valued", async () => {
  const { parseRetryAfter } = await import(path.join(REPO, "src", "execution", "retry.ts"));
  const ms = parseRetryAfter({ "retry-after": ["45", "60"] });
  assert(ms === 45_000, `expected 45000, got ${ms}`);
}));

// probe.retry_after
results.push(await runScenario("probe.retry_after", async () => {
  process.env.UNBROWSE_ALLOW_PRIVATE_IPS = "1";
  const srv = await startHttp429("30");
  try {
    const { probeUrl } = await import(path.join(REPO, "src", "execution", "probe.ts"));
    const probe = await probeUrl(`http://127.0.0.1:${srv.port}/`);
    assert(probe.status === 429, `expected status 429, got ${probe.status}`);
    assert(probe.retry_after === "30", `expected retry_after '30', got '${probe.retry_after}'`);
  } finally {
    await srv.close();
  }
}));

const passed = results.filter(Boolean).length;
const total = results.length;
console.log(`\n${passed}/${total} scenarios passed.`);
process.exit(passed === total ? 0 : 1);
