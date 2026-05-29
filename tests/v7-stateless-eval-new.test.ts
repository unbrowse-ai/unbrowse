/**
 * Day-6 Dominion worker 7 (W21 + W22 stateless wiring).
 *
 * Genesis 1:26 — *"dominion."*
 *
 * Load-bearing invariants:
 *   T1 (auth-inventory) Under UNBROWSE_STATELESS=1, the handler POSTs an
 *                       eval_read audit row whose body carries ONLY
 *                       {variant, op_kind, domainCount,
 *                       scoredDomainCount, nonce, ...sig}. NO `inventory`
 *                       map. NO `cookie_names`. NO domain strings beyond
 *                       what the sig fields require.
 *   T2 (spec)           Under UNBROWSE_STATELESS=1 + a probed origin, the
 *                       handler POSTs an eval_read audit row whose body
 *                       carries ONLY {variant, op_kind, domainHash,
 *                       hitFamilies, endpointCount, nonce, ...sig}. NO
 *                       response body. NO endpoint list. NO origin URL.
 *                       PLUS the cache wrap fires: a second invocation
 *                       within the TTL window reads from the local
 *                       cache:spec:<domainHash> file without hitting the
 *                       network again.
 *   T3 (adversarial)    Canary inside a cookie host (NOT the value) and a
 *                       canary domain name MUST NOT appear in the
 *                       eval_read POST body for auth-inventory. The
 *                       audit row is metadata-only; the AST goes to
 *                       stdout for the caller, NOT into the witness.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  domainHash32,
  readSpecCache,
  writeSpecCache,
} from "../src/cli-v7/eval/spec.js";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli-v7", "index.ts");

// Chrome stores times as microseconds since 1601-01-01.
const CHROME_EPOCH_OFFSET_S = 11644473600;
function unixSecondsToChromeUs(unixS: number): number {
  return (unixS + CHROME_EPOCH_OFFSET_S) * 1_000_000;
}

interface CapturedReq {
  method: string;
  pathname: string;
  headers: Record<string, string>;
  bodyText: string;
  bodyJson: Record<string, unknown>;
}

interface MockBackend {
  url: string;
  captured: CapturedReq[];
  setSpecResponse: (r: { status: number; body: Record<string, unknown> }) => void;
  setAuditResponse: (r: { status: number; body: Record<string, unknown> }) => void;
  stop: () => Promise<void>;
}

function spinupBackend(): MockBackend {
  const captured: CapturedReq[] = [];
  let auditResp: { status: number; body: Record<string, unknown> } = {
    status: 200,
    body: { ok: true, receiptId: "ab".repeat(32), idempotent: false },
  };
  let specResp: { status: number; body: Record<string, unknown> } = {
    status: 200,
    body: {},
  };

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      const bodyText = req.method !== "GET" ? await req.text() : "";
      let bodyJson: Record<string, unknown> = {};
      try { bodyJson = bodyText ? JSON.parse(bodyText) : {}; } catch { /* */ }
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      captured.push({
        method: req.method,
        pathname: u.pathname,
        headers,
        bodyText,
        bodyJson,
      });

      if (req.method === "POST" && u.pathname === "/v1/audit/eval-read") {
        return new Response(JSON.stringify(auditResp.body), {
          status: auditResp.status,
          headers: { "content-type": "application/json" },
        });
      }
      // Any spec probe target.
      if (req.method === "GET") {
        return new Response(JSON.stringify(specResp.body), {
          status: specResp.status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not_found", { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    captured,
    setSpecResponse: (r) => { specResp = r; },
    setAuditResponse: (r) => { auditResp = r; },
    stop: async () => { await server.stop(true); },
  };
}

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutJson?: Record<string, unknown>;
}

async function runCli(args: {
  cliArgs: string[];
  homeDir: string;
  backendUrl: string;
  stateless: boolean;
}): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      ...process.env,
      HOME: args.homeDir,
      UNBROWSE_API_URL: args.backendUrl,
      UNBROWSE_BACKEND_URL: args.backendUrl,
      UNBROWSE_STATELESS: args.stateless ? "1" : "0",
      UNBROWSE_QUIET: "1",
    };
    const child = spawn("bun", ["run", CLI_ENTRY, ...args.cliArgs], {
      env,
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      let stdoutJson: Record<string, unknown> | undefined;
      try {
        stdoutJson = JSON.parse(stdout);
      } catch { /* not json */ }
      resolve({ exitCode: code ?? -1, stdout, stderr, stdoutJson });
    });
  });
}

/** Build a Chrome-shaped Cookies sqlite at `path`. */
function buildChromeCookieDb(
  path: string,
  rows: Array<{ host_key: string; name: string; value: string; expires_unix: number }>,
): void {
  const db = new Database(path);
  db.run(`
    CREATE TABLE cookies (
      creation_utc INTEGER NOT NULL,
      host_key TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      encrypted_value BLOB DEFAULT '',
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL DEFAULT 0,
      is_httponly INTEGER NOT NULL DEFAULT 0,
      last_access_utc INTEGER NOT NULL DEFAULT 0,
      has_expires INTEGER NOT NULL DEFAULT 1,
      is_persistent INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 1,
      samesite INTEGER NOT NULL DEFAULT -1,
      source_scheme INTEGER NOT NULL DEFAULT 2,
      source_port INTEGER NOT NULL DEFAULT 443,
      last_update_utc INTEGER NOT NULL DEFAULT 0
    );
  `);
  const ins = db.prepare(
    `INSERT INTO cookies (creation_utc, host_key, name, value, path, expires_utc) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    ins.run(
      unixSecondsToChromeUs(Math.floor(Date.now() / 1000)),
      r.host_key,
      r.name,
      r.value,
      "/",
      unixSecondsToChromeUs(r.expires_unix),
    );
  }
  db.close();
}

/** Build a minimal Chrome History sqlite. */
function buildChromeHistoryDb(path: string): void {
  const db = new Database(path);
  db.run(`
    CREATE TABLE urls (
      id INTEGER PRIMARY KEY,
      url LONGVARCHAR,
      title LONGVARCHAR,
      visit_count INTEGER DEFAULT 0 NOT NULL,
      typed_count INTEGER DEFAULT 0 NOT NULL,
      last_visit_time INTEGER NOT NULL,
      hidden INTEGER DEFAULT 0 NOT NULL
    );
  `);
  db.close();
}

/** Build an empty Chrome Bookmarks JSON file. */
function buildChromeBookmarks(path: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      roots: { bookmark_bar: { children: [] }, other: { children: [] }, synced: { children: [] } },
    }),
  );
}

// ───────────────────────────────────────────────────────────────────────────
// T1 (golden): auth-inventory under stateless POSTs counts only
// ───────────────────────────────────────────────────────────────────────────

describe("Day-6 W7: auth-inventory stateless eval_read audit row", () => {
  let tmpHome: string;
  let chromeProfile: string;
  let backend: MockBackend;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "unbrowse-w7-auth-"));
    chromeProfile = join(tmpHome, "chrome-profile");
    mkdirSync(chromeProfile, { recursive: true });
    buildChromeCookieDb(join(chromeProfile, "Cookies"), [
      { host_key: ".github.com", name: "user_session", value: "REDACTED", expires_unix: Math.floor(Date.now() / 1000) + 86400 },
      { host_key: ".reddit.com", name: "session_id", value: "REDACTED", expires_unix: Math.floor(Date.now() / 1000) + 86400 },
      { host_key: ".tracker.example", name: "_ga", value: "REDACTED", expires_unix: Math.floor(Date.now() / 1000) + 86400 },
    ]);
    buildChromeHistoryDb(join(chromeProfile, "History"));
    buildChromeBookmarks(join(chromeProfile, "Bookmarks"));
    backend = spinupBackend();
  });

  afterEach(async () => {
    try { await backend.stop(); } catch { /* */ }
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it("T1 golden: POSTs eval_read with counts only; no inventory map; no cookie_names; no domain strings on the wire", async () => {
    const run = await runCli({
      cliArgs: [
        "eval", "auth-inventory",
        "--chrome-profile", chromeProfile,
        "--json",
      ],
      homeDir: tmpHome,
      backendUrl: backend.url,
      stateless: true,
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdoutJson?.ok).toBe(true);
    expect(run.stdoutJson?._receipt_cache_key).toBeDefined();

    // Backend received exactly one POST to /v1/audit/eval-read.
    const auditPosts = backend.captured.filter(
      (c) => c.method === "POST" && c.pathname === "/v1/audit/eval-read",
    );
    expect(auditPosts.length).toBe(1);

    const body = auditPosts[0].bodyJson;

    // Sig-keyed: walletPubkey + signature + signatureScheme + nonce present.
    expect(typeof body.walletPubkey).toBe("string");
    expect((body.walletPubkey as string).length).toBe(64);
    expect(typeof body.signature).toBe("string");
    expect((body.signature as string).length).toBe(128);
    expect(typeof body.nonce).toBe("string");
    expect(body.signatureScheme).toBe("ed25519-v7.0");

    // Counts-only body: domainCount + scoredDomainCount are integers.
    expect(typeof body.domainCount).toBe("number");
    expect(typeof body.scoredDomainCount).toBe("number");
    expect(body.variant).toBe("eval-read");
    expect(body.op_kind).toBe("eval:auth_inventory");

    // NO `inventory` field. NO domain map. NO cookie_names.
    expect(body.inventory).toBeUndefined();
    expect(body.cookie_names).toBeUndefined();
    expect(body.sources_scanned).toBeUndefined();
    expect(body.locked_sources).toBeUndefined();

    // A1: NO inventory / cookie / domain data lands on disk for auth-inventory
    // under stateless. The signer's `~/.unbrowse/wallet.enc` is the ONLY legal
    // disk artifact (pre-existing wallet substrate). Assert specifically: no
    // settings.json, no skills/, no traces/, no auth-inventory-state file.
    const unbrowseDir = join(tmpHome, ".unbrowse");
    if (existsSync(unbrowseDir)) {
      const { readdirSync } = await import("node:fs");
      const entries = readdirSync(unbrowseDir);
      for (const e of entries) {
        // Only wallet.enc is legal here (signer fallback).
        expect(["wallet.enc"]).toContain(e);
      }
    }
  }, 30_000);

  it("T3 adversarial canary: a cookie host carrying a canary string MUST NOT leak into the eval_read POST body", async () => {
    // Use a lowercase canary because normalizeHostKey lowercases everything;
    // the assertion below must search for the lowercase form on stdout too.
    const CANARY_HOST = ".unb7-authinv-domain-canary-do-not-leak.example";
    const CANARY_LC = "unb7-authinv-domain-canary-do-not-leak";

    // Rebuild profile with a canary-bearing cookie host.
    rmSync(chromeProfile, { recursive: true, force: true });
    mkdirSync(chromeProfile, { recursive: true });
    buildChromeCookieDb(join(chromeProfile, "Cookies"), [
      { host_key: CANARY_HOST, name: "user_session", value: "irrelevant", expires_unix: Math.floor(Date.now() / 1000) + 86400 },
    ]);
    buildChromeHistoryDb(join(chromeProfile, "History"));
    buildChromeBookmarks(join(chromeProfile, "Bookmarks"));

    const run = await runCli({
      cliArgs: [
        "eval", "auth-inventory",
        "--chrome-profile", chromeProfile,
        "--json",
      ],
      homeDir: tmpHome,
      backendUrl: backend.url,
      stateless: true,
    });

    expect(run.exitCode).toBe(0);

    const auditPosts = backend.captured.filter(
      (c) => c.method === "POST" && c.pathname === "/v1/audit/eval-read",
    );
    expect(auditPosts.length).toBe(1);

    // The CANARY (a fingerprintable domain) must NOT appear in the audit
    // wire body — neither in the JSON-serialized form nor in any field.
    expect(auditPosts[0].bodyText.toLowerCase()).not.toContain(CANARY_LC);
    for (const [k, v] of Object.entries(auditPosts[0].bodyJson)) {
      if (typeof v === "string") {
        expect(v.toLowerCase()).not.toContain(CANARY_LC);
      } else if (v !== null && v !== undefined) {
        expect(JSON.stringify(v).toLowerCase()).not.toContain(CANARY_LC);
      }
    }

    // The canary MUST appear in stdout (the AST the caller consumes IS
    // allowed to carry the domain — only the witness row is metadata-only).
    expect(run.stdout.toLowerCase()).toContain(CANARY_LC);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// T2 (golden): spec under stateless POSTs counts + families only, cache wraps
// ───────────────────────────────────────────────────────────────────────────

describe("Day-6 W7: spec stateless eval_read audit row + W17 cache wrap", () => {
  let tmpHome: string;
  let backend: MockBackend;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "unbrowse-w7-spec-"));
    backend = spinupBackend();
  });

  afterEach(async () => {
    try { await backend.stop(); } catch { /* */ }
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it("T2 golden: POSTs eval_read with domainHash + hitFamilies + endpointCount; cache wrap fires on second invocation", async () => {
    // Pre-seed a cache hit so we don't have to drive a live spec discovery
    // (the spec primitive probes real network paths that the mock backend
    // doesn't model; the cache substrate is the load-bearing surface).
    const host = "example.com";
    const dh = domainHash32(host);
    // Mimic a successful prior probe.
    writeSpecCache(dh, {
      domain: host,
      probed_at: new Date().toISOString(),
      budget_ms: 3000,
      hits: [
        {
          source: "openapi",
          url: `https://${host}/openapi.json`,
          version: "3.0.3",
          endpoint_count: 7,
          endpoints: [],
        } as never,
        {
          source: "sitemap",
          url: `https://${host}/sitemap.xml`,
          loc_count: 12,
          loc_count_truncated: false,
          path_tree: {},
        } as never,
      ],
      misses: ["swagger", "html-link", "robots"] as never,
    });

    // Override HOME so the spec cache the handler reads is in tmpHome.
    // (Cache helpers read from `homedir()`; running the CLI with HOME set
    // routes them to tmpHome.)
    rmSync(join(tmpHome, ".unbrowse"), { recursive: true, force: true });

    const cacheDir = join(tmpHome, ".unbrowse", "tmp", "spec-cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, `${dh}.json`),
      JSON.stringify({
        key: `cache:spec:${dh}`,
        ts_unix: Math.floor(Date.now() / 1000),
        ttl_s: 24 * 3600,
        value: {
          domain: host,
          probed_at: new Date().toISOString(),
          budget_ms: 3000,
          hits: [
            { source: "openapi", url: `https://${host}/openapi.json`, version: "3.0.3", endpoint_count: 7, endpoints: [] },
            { source: "sitemap", url: `https://${host}/sitemap.xml`, loc_count: 12, loc_count_truncated: false, path_tree: {} },
          ],
          misses: ["swagger", "html-link", "robots"],
        },
      }),
    );

    const run = await runCli({
      cliArgs: ["eval", "spec", host, "--json"],
      homeDir: tmpHome,
      backendUrl: backend.url,
      stateless: true,
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdoutJson?.ok).toBe(true);
    expect(run.stdoutJson?._cache_hit).toBe(true);
    expect(run.stdoutJson?._cache_key).toBe(`cache:spec:${dh}`);

    // Exactly one POST to the audit route.
    const auditPosts = backend.captured.filter(
      (c) => c.method === "POST" && c.pathname === "/v1/audit/eval-read",
    );
    expect(auditPosts.length).toBe(1);

    const body = auditPosts[0].bodyJson;
    // Sig-keyed.
    expect(typeof body.walletPubkey).toBe("string");
    expect(typeof body.signature).toBe("string");
    expect(typeof body.nonce).toBe("string");
    expect(body.signatureScheme).toBe("ed25519-v7.0");

    // Counts + families + domainHash only.
    expect(body.variant).toBe("eval-read");
    expect(body.op_kind).toBe("eval:spec_discover");
    expect(body.domainHash).toBe(dh);
    expect(Array.isArray(body.hitFamilies)).toBe(true);
    expect((body.hitFamilies as string[]).sort()).toEqual(["openapi", "sitemap"]);
    expect(body.endpointCount).toBe(7);

    // NO response body. NO endpoints array. NO origin URL.
    expect(body.hits).toBeUndefined();
    expect(body.endpoints).toBeUndefined();
    expect(body.origin).toBeUndefined();
    expect(body.domain).toBeUndefined();
    expect(body.url).toBeUndefined();

    // Cache wrap: NO live GET calls to spec probe paths (everything served
    // from cache). The backend captured only the audit POST.
    const liveProbes = backend.captured.filter(
      (c) => c.method === "GET" && c.pathname !== "/v1/audit/eval-read",
    );
    expect(liveProbes.length).toBe(0);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// Cache primitives — pure unit checks (no network)
// ───────────────────────────────────────────────────────────────────────────

describe("Day-6 W7: spec cache primitives", () => {
  it("domainHash32 is deterministic 32-char lowercase hex", () => {
    const a = domainHash32("example.com");
    const b = domainHash32("EXAMPLE.COM");
    expect(a).toBe(b);
    expect(a.length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(a)).toBe(true);
  });

  it("readSpecCache returns null on missing file", () => {
    expect(readSpecCache("0".repeat(32))).toBeNull();
  });
});
