/**
 * GATE: Chrome-free endpoint DISCOVERY + the opt-in SHARE boundary.
 *
 * Proves the three load-bearing claims of src/capture/obscura-index.ts with NO
 * network, NO Chrome, NO CDP, and an isolated HOME (the tests/_learned-route
 * fixture pattern: UNBROWSE_SKILL_SNAPSHOT_DIR / UNBROWSE_SKILL_CACHE_DIR are set
 * BEFORE the store-backed modules load, so a hermetic write lands in the temp
 * stores and nowhere else):
 *
 *   (i)   scanBundlesForRoutes on a fixture JS bundle yields a candidate /api
 *         route.
 *   (ii)  a discovered endpoint "called directly" (via an injected fetch against
 *         a fixture origin) passes the collection-shape + cardinality gate and,
 *         with shareToIndex=true, cacheBrowseRequests indexes it as a real skill.
 *   (iii) OPT-IN: shareToIndex=false writes NOTHING to the shared store
 *         (snapshot + client cache unchanged, findExistingSkillForDomain empty);
 *         shareToIndex=true writes it AND a resolve reuses it (the domain reader
 *         the resolve ladder consults returns the endpoint) with NO re-capture
 *         (the injected capture runner is invoked exactly once).
 *
 * The "fixture origin" is a made-up PUBLIC host (acme-*.com) served by an
 * injected fetch. A public host is required: the admission gate (isIndexableUrl)
 * rejects loopback/127.0.0.1 as non-replayable, so a real loopback server could
 * never be indexed — the injected-fetch public host both keeps the test off the
 * network and exercises the exact admission path a real capture would.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawRequest } from "../src/capture/index.js";
import type { RunObscuraCaptureResult } from "../src/capture/obscura-capture.js";
import type { BrowserSessionResult } from "../src/auth/browser-cookies.js";

// ---------------------------------------------------------------------------
// Hermetic HOME + isolated stores. Set BEFORE any store-backed module loads:
// the orchestrator resolves SKILL_SNAPSHOT_DIR into a module-level const at
// import time, so these must exist in process.env before the dynamic imports in
// beforeAll run. Top-level module code executes before any test hook.
// ---------------------------------------------------------------------------
const HOME = mkdtempSync(join(tmpdir(), "unbrowse-obscura-disco-"));
const SNAPSHOT_DIR = join(HOME, ".unbrowse", "skill-snapshots");
const CACHE_DIR = join(HOME, ".unbrowse", "skill-cache");
mkdirSync(SNAPSHOT_DIR, { recursive: true });
mkdirSync(CACHE_DIR, { recursive: true });

process.env.HOME = HOME;
process.env.UNBROWSE_SKILL_SNAPSHOT_DIR = SNAPSHOT_DIR;
process.env.UNBROWSE_SKILL_CACHE_DIR = CACHE_DIR;
process.env.UNBROWSE_LOCAL_ONLY = "1"; // revengServerFirst -> revengLocal, no egress
process.env.UNBROWSE_LOCAL_CACHES = "1"; // stores ON (default, made explicit)
process.env.UNBROWSE_NON_INTERACTIVE = "1";
process.env.UNBROWSE_SKIP_TOS_CHECK = "1";
process.env.UNBROWSE_SKIP_REHYDRATE = "1";
process.env.UNBROWSE_SKIP_DAEMON_PROBE = "1";
process.env.UNBROWSE_IMPORT_BROWSER_COOKIES = "0";
delete process.env.UNBROWSE_STATELESS; // must NOT be 1 or writes no-op
delete process.env.UNBROWSE_URL;
// No LLM augmentation over the wire — keep the index step fully offline.
delete process.env.OPENAI_API_KEY;
delete process.env.NEBIUS_API_KEY;

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/** A real JS bundle body carrying an internal API route as a string literal. */
const JS_BUNDLE =
  'var e=42;const API_BASE="/api/items";function load(p){return fetch(API_BASE+"?page="+p).then(r=>r.json())}export{load};';

/** 25 like-shaped records — a collection the admission gate accepts. */
function collectionBody(): string {
  return JSON.stringify({
    items: Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      title: `Item ${i + 1}`,
      price: 10 + i,
      body: "lorem ipsum dolor sit amet consectetur ".repeat(3),
    })),
  });
}

/** A single-cookie session, so the direct call carries injected auth. */
function fakeSession(domain: string): BrowserSessionResult {
  return {
    browser: "Chrome",
    cookies: [
      { name: "sid", value: "SECRET_SESSION_1", domain, path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: 9999999999 },
    ],
    sessionCookies: 1,
    quality: 3,
    source: "fixture",
  };
}

/** A capture whose passive rows are the page HTML + one JS bundle (no API yet). */
function fakeCapture(origin: string): RunObscuraCaptureResult {
  const ts = new Date(1785853139900).toISOString();
  const requests: RawRequest[] = [
    {
      url: `${origin}/`,
      method: "GET",
      request_headers: {},
      response_status: 200,
      response_headers: { "content-type": "text/html" },
      response_body: "<html><head><title>Fixture</title></head><body><div id=app></div></body></html>",
      timestamp: ts,
    },
    {
      url: `${origin}/static/app.js`,
      method: "GET",
      request_headers: {},
      response_status: 200,
      response_headers: { "content-type": "application/javascript" },
      response_body: JS_BUNDLE,
      timestamp: ts,
    },
  ];
  return { requests, final_url: `${origin}/`, html_len: 120, cookies: [], domain: new URL(origin).hostname };
}

interface FetchProbe {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; cookie: string | null }>;
}

/** Injected fetch: serves the collection at /api/items for `origin`, records calls. */
function makeFetchProbe(origin: string): FetchProbe {
  const calls: Array<{ url: string; cookie: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, cookie: headers.cookie ?? null });
    if (url.startsWith(`${origin}/api/items`)) {
      return new Response(collectionBody(), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Count .json files a store dir currently holds. */
function fileCount(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Modules under test (dynamic — env is already set above).
// ---------------------------------------------------------------------------
type ObscuraIndex = typeof import("../src/capture/obscura-index.js");
type BundleScanner = typeof import("../src/capture/bundle-scanner.js");
type ClientMod = typeof import("../src/client/index.js");
type OrchestratorMod = typeof import("../src/orchestrator/index.js");

let obscuraIndex: ObscuraIndex;
let bundleScanner: BundleScanner;
let client: ClientMod;
let orchestrator: OrchestratorMod;

beforeAll(async () => {
  obscuraIndex = await import("../src/capture/obscura-index.js");
  bundleScanner = await import("../src/capture/bundle-scanner.js");
  client = await import("../src/client/index.js");
  orchestrator = await import("../src/orchestrator/index.js");
});

afterEach(() => {
  // Snapshot store is a shared dir keyed by content-hash; tests use DISTINCT
  // domains so a stale entry from one test can never satisfy another's read.
});

describe("(i) bundle scan surfaces an /api candidate", () => {
  test("scanBundlesForRoutes finds /api/items in the JS bundle", () => {
    const origin = "https://acme-scan.com";
    const routes = bundleScanner.scanBundlesForRoutes(
      new Map([[`${origin}/static/app.js`, JS_BUNDLE]]),
      origin,
    );
    const hit = routes.find((r) => r.path === "/api/items");
    expect(hit, `no /api/items candidate; saw ${JSON.stringify(routes)}`).toBeDefined();
    expect(hit!.url).toBe(`${origin}/api/items`);
  });
});

describe("(ii) direct call passes the gate and cacheBrowseRequests indexes it", () => {
  test("bundle candidate -> direct GET (with auth) -> 2xx collection -> indexed skill", async () => {
    const origin = "https://acme-shop.com";
    const domain = "acme-shop.com";
    const intent = "list the shop items";
    const cookiesDir = join(HOME, "jar-shop");
    const probe = makeFetchProbe(origin);

    const result = await obscuraIndex.captureAndIndexViaObscura(`${origin}/`, intent, {
      shareToIndex: true,
      session: fakeSession(domain),
      cookiesDir,
      runCapture: async () => fakeCapture(origin),
      fetchImpl: probe.fetchImpl,
    });

    // The candidate was actually called DIRECTLY over HTTP, carrying the jar.
    const apiCall = probe.calls.find((c) => c.url.startsWith(`${origin}/api/items`));
    expect(apiCall, `direct call to /api/items never happened; calls=${JSON.stringify(probe.calls)}`).toBeDefined();
    expect(apiCall!.cookie, "injected auth cookie missing from the direct call").toContain("sid=SECRET_SESSION_1");

    // The obscura jar was written for the sidecar (auth sourcing path).
    expect(existsSync(join(cookiesDir, "cookies.json")), "obscura cookie jar was not written").toBe(true);

    // Discovery kept exactly the collection endpoint (passive HTML/JS did not admit).
    expect(result.discovery.probed.map((r) => r.url)).toEqual([`${origin}/api/items`]);

    // cacheBrowseRequests indexed it as a real HTTP skill.
    expect(result.shared).toBe(true);
    expect(result.index?.indexed, `index result: ${JSON.stringify(result.index)}`).toBe(true);
    expect(result.index?.mode).toBe("http");

    // The learned route is in the shared client store, keyed by domain.
    const learned = client.findExistingSkillForDomain(domain);
    expect(learned, "findExistingSkillForDomain returned nothing").not.toBeNull();
    expect(
      learned!.endpoints.some((e) => String(e.url_template).includes("/api/items")),
      `no /api/items endpoint in learned skill: ${JSON.stringify(learned!.endpoints.map((e) => e.url_template))}`,
    ).toBe(true);
  }, 60_000);
});

describe("(iii) opt-in gate: local by default, shared only on flag, reuse without re-capture", () => {
  test("shareToIndex=false writes NOTHING to the shared store", async () => {
    const origin = "https://noshare-shop.com";
    const domain = "noshare-shop.com";
    const probe = makeFetchProbe(origin);

    const snapBefore = fileCount(SNAPSHOT_DIR);
    const cacheBefore = fileCount(CACHE_DIR);

    const result = await obscuraIndex.captureAndIndexViaObscura(`${origin}/`, "list the items", {
      shareToIndex: false,
      session: fakeSession(domain),
      cookiesDir: join(HOME, "jar-noshare"),
      runCapture: async () => fakeCapture(origin),
      fetchImpl: probe.fetchImpl,
    });

    // Discovery still ran (the endpoint WAS found + called) ...
    expect(result.discovery.probed.map((r) => r.url)).toEqual([`${origin}/api/items`]);
    // ... but NOTHING was shared.
    expect(result.shared).toBe(false);
    expect(result.index).toBeNull();

    // The shared stores are byte-for-byte unchanged, and the domain is unknown.
    expect(fileCount(SNAPSHOT_DIR)).toBe(snapBefore);
    expect(fileCount(CACHE_DIR)).toBe(cacheBefore);
    expect(client.findExistingSkillForDomain(domain)).toBeNull();
  }, 60_000);

  test("shareToIndex=true writes it AND a resolve reuses it with no re-capture", async () => {
    const origin = "https://reuse-shop.com";
    const domain = "reuse-shop.com";
    const intent = "list the reuse items";
    const probe = makeFetchProbe(origin);

    let captureCalls = 0;
    const runCapture = async (): Promise<RunObscuraCaptureResult> => {
      captureCalls += 1;
      return fakeCapture(origin);
    };

    const result = await obscuraIndex.captureAndIndexViaObscura(`${origin}/`, intent, {
      shareToIndex: true,
      session: fakeSession(domain),
      cookiesDir: join(HOME, "jar-reuse"),
      runCapture,
      fetchImpl: probe.fetchImpl,
    });
    expect(result.index?.indexed).toBe(true);
    expect(captureCalls).toBe(1);

    // Witness A (client store): the resolve ladder's by-domain reader returns it.
    const learned = client.findExistingSkillForDomain(domain);
    expect(learned, "reuse: client store empty").not.toBeNull();
    const endpoint = learned!.endpoints.find((e) => String(e.url_template).includes("/api/items"));
    expect(endpoint, "reuse: /api/items endpoint missing").toBeDefined();

    // Witness B (orchestrator store): the by-domain snapshot reader the resolve
    // ladder consults (findBestLocalDomainSnapshot) returns the same route.
    const snapshot = orchestrator.findBestLocalDomainSnapshot(domain, intent, `${origin}/`);
    expect(snapshot, "reuse: orchestrator snapshot empty").toBeDefined();
    expect(
      snapshot!.endpoints.some((e) => String(e.url_template).includes("/api/items")),
      "reuse: orchestrator snapshot missing /api/items endpoint",
    ).toBe(true);

    // The reuse read triggered NO second capture — replay, not re-drive.
    expect(captureCalls, "a re-capture was triggered during reuse").toBe(1);
  }, 60_000);
});
