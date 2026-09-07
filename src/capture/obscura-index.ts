/**
 * obscura-index — Chrome-free endpoint DISCOVERY + opt-in SHARE.
 *
 * The north star (Obscura, no Chrome): learn a site's internal endpoints three
 * ways — (a) passive capture, (b) interaction, (c) JS-bundle scan — then CALL
 * each discovered endpoint DIRECTLY over HTTP (with the injected auth jar) to
 * confirm a 2xx collection response, and index it. This module wires those
 * existing unbrowse primitives together and adds ONE new policy boundary:
 *
 *   discovery is LOCAL by default. The shared skill store (writeSkillSnapshot +
 *   cachePublishedSkill, via cacheBrowseRequests) is written ONLY when the caller
 *   passes `shareToIndex: true`. Absent the flag, `captureAndIndexViaObscura`
 *   returns the discovered routes and writes NOTHING to the shared index.
 *
 * Nothing here re-implements capture, RE, admission, or indexing — it reuses
 * runObscuraCapture, scanBundlesForRoutes, decodeJsonBody/findRecordCollection
 * (the same collection-shape test admitCandidate uses), isIndexableUrl,
 * cardinalityMatches, findBestBrowserSession/writeObscuraJar, and
 * cacheBrowseRequests. The direct endpoint call is the one primitive it drives
 * itself (a GET carrying the injected auth), because that is the act that turns
 * a bundle-scanned CANDIDATE into a confirmed, indexable RawRequest row.
 */

import { log } from "../logger.js";
import type { RawRequest } from "./index.js";
import { scanBundlesForRoutes } from "./bundle-scanner.js";
import { decodeJsonBody, findRecordCollection } from "./reveng-local.js";
import { isIndexableUrl } from "./indexable.js";
import { cardinalityMatches } from "../values/cardinality.js";
import { findBestBrowserSession, type BrowserSessionResult } from "../auth/browser-cookies.js";
import { writeObscuraJar } from "../auth/obscura-jar.js";
import {
  runObscuraCapture,
  partitionBlockedRequests,
  type RunObscuraCaptureOptions,
  type RunObscuraCaptureResult,
  type BlockedRequest,
} from "./obscura-capture.js";
import { cacheBrowseRequests, type BrowseIndexResult } from "../api/browse-index.js";
import { resolveEgress, type EgressIdentity } from "../execution/egress-binding.js";

/** Case-insensitive content-type lookup on a RawRequest's response headers. */
function responseContentType(r: RawRequest): string {
  const h = r.response_headers ?? {};
  return (h["content-type"] ?? h["Content-Type"] ?? "").toLowerCase();
}

/**
 * The JS bundle bodies carried by a capture — the input scanBundlesForRoutes
 * reads. obscura's on_response captures script/JS bundle bodies (is_textual
 * includes javascript), so the bundles are already in `capture.requests`; we
 * just select the rows whose body is JavaScript. Recognized by SHAPE (JS
 * content-type or a `.js`/`.mjs` URL, plus HTML docs that INLINE JS fetch
 * literals — e.g. Next.js SSR __NEXT_DATA__ — so a host that inlines its
 * API routes is not invisible), never a per-host list.
 *
 * Invariant cited: src/capture/DESIGN_NOTES.md — "Only structure leaves the
 * machine." This widening only changes which LOCAL bodies are scanned; no
 * values cross the boundary differently (obfuscate.ts -> commitments still holds).
 */
export function jsBundleBodies(requests: RawRequest[]): Map<string, string> {
  const bundles = new Map<string, string>();
  for (const r of requests) {
    const body = r.response_body;
    if (!body) continue;
    const ct = responseContentType(r);
    const looksJs =
      ct.includes("javascript") || ct.includes("ecmascript") || /\.m?js(?:\?|$)/i.test(r.url);
    // Structural enrichment: HTML docs that inline API routes (e.g. fetch("/api/…")
    // inside a <script> tag) would otherwise be invisible to bundle-scan. Treat
    // html bodies that CONTAIN a JS fetch literal as an inline bundle — by shape,
    // never a per-host list. Bounded: at most one synthetic entry per HTML doc.
    const htmlInlineJs =
      ct.includes("html") && /fetch\s*\(|\/api\//i.test(body) && body.length < 2_000_000;
    if (looksJs || htmlInlineJs) bundles.set(r.url, body);
  }
  return bundles;
}

/** Path (no query) of a URL, for de-duping a candidate against passive rows. */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

export interface DiscoverEndpointsOptions {
  /** Intent text — drives the cardinality gate (a list intent wants a net). */
  intent?: string;
  /** Auth headers injected on each direct endpoint call (e.g. authorization). */
  authHeaders?: Record<string, string>;
  /** Cookie header injected on each direct call (from the sourced browser jar). */
  cookieHeader?: string;
  /** Injected fetch (tests drive a hermetic origin); defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-call timeout for a direct endpoint probe (ms). */
  timeoutMs?: number;
  /** Cap on how many bundle candidates are called directly. */
  maxProbe?: number;
}

export interface DiscoverEndpointsResult {
  /** Rows the passive capture already observed. */
  passive: RawRequest[];
  /** Bundle-scanned candidate URLs (before the direct-call confirmation). */
  candidates: string[];
  /** Candidates that were called DIRECTLY and returned a 2xx collection. */
  probed: RawRequest[];
  /** passive ∪ probed — the RawRequest[] the indexer consumes. */
  requests: RawRequest[];
}

/**
 * A directly-called endpoint is admissible when it is a real, replayable HTTP
 * endpoint (isIndexableUrl), returned 2xx, its body decodes to a record
 * collection (the exact test admitCandidate applies), and its route cardinality
 * matches the intent (a net wants many fish). This is the collection-shape gate
 * a called endpoint must pass to be indexable — the shared structural interface,
 * not a per-site rule.
 */
export function probePassesGate(
  row: RawRequest,
  intent: string | undefined,
  contextUrl: string | undefined,
): boolean {
  const status = Number(row.response_status ?? 0);
  if (!(status >= 200 && status < 300)) return false;
  if (!isIndexableUrl(row.url)) return false;
  const decoded = decodeJsonBody(row.response_body);
  const collection = decoded === undefined ? null : findRecordCollection(decoded);
  if (!collection) return false;
  return cardinalityMatches(intent, { kind: "route", route: { url_template: row.url } }, { contextUrl });
}

/** GET a candidate directly, carrying the injected auth, into a RawRequest row. */
async function callDirect(
  url: string,
  opts: DiscoverEndpointsOptions,
  fetchImpl: typeof fetch,
): Promise<RawRequest | null> {
  const headers: Record<string, string> = { accept: "application/json", ...(opts.authHeaders ?? {}) };
  if (opts.cookieHeader) headers.cookie = opts.cookieHeader;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const body = await res.text();
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    return {
      url,
      method: "GET",
      request_headers: headers,
      response_status: res.status,
      response_headers: respHeaders,
      response_body: body,
      timestamp: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Discover a site's internal endpoints from ONE obscura capture, by unioning:
 *   1. passive RawRequest[] the capture already observed;
 *   2. JS-bundle candidates via scanBundlesForRoutes over the captured script
 *      bodies, each CALLED DIRECTLY over HTTP (with the injected auth) and kept
 *      only when it returns a 2xx collection that clears the cardinality gate.
 * Pure of any store write — indexing is a separate, opt-in step.
 */
export async function discoverEndpoints(
  capture: RunObscuraCaptureResult,
  opts: DiscoverEndpointsOptions = {},
): Promise<DiscoverEndpointsResult> {
  const passive = capture.requests ?? [];
  let origin = "";
  try {
    origin = new URL(capture.final_url).origin;
  } catch {
    /* no origin — bundle scan is skipped below */
  }

  const bundles = jsBundleBodies(passive);
  const bundleRoutes = origin ? scanBundlesForRoutes(bundles, origin) : [];

  // De-dupe candidate URLs, and drop any the passive capture already carries so
  // we never re-call an endpoint we already have evidence for.
  const passivePaths = new Set(passive.map((r) => pathOf(r.url)));
  const candidateUrls: string[] = [];
  const seen = new Set<string>();
  for (const route of bundleRoutes) {
    const key = pathOf(route.url);
    if (seen.has(key) || passivePaths.has(key)) continue;
    seen.add(key);
    candidateUrls.push(route.url);
  }

  // Structural: Twitter/X signs GraphQL with `x-csrf-token: <ct0>` alongside `Cookie: ct0=...`. The same
  // pattern (cookie value mirrored to header) recurs across X-guarded platforms; synthesize it
  // from the jar we already have so the bundle-scan probe POSTs with the right header.
  if (opts.cookieHeader && !opts.authHeaders?.["x-csrf-token"] && !opts.authHeaders?.["x-csrf-token".toLowerCase()]) {
    const ct0 = /(?:^|;\s*)ct0=([^;]+)/.exec(opts.cookieHeader)?.[1];
    if (ct0) opts.authHeaders = { ...(opts.authHeaders ?? {}), "x-csrf-token": ct0 };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cap = opts.maxProbe ?? 12;
  const probed: RawRequest[] = [];
  for (const url of candidateUrls.slice(0, cap)) {
    if (!isIndexableUrl(url)) continue;
    const row = await callDirect(url, opts, fetchImpl);
    if (!row) continue;
    if (!probePassesGate(row, opts.intent, capture.final_url)) continue;
    probed.push(row);
  }

  log(
    "obscura-index",
    `discover: ${passive.length} passive, ${candidateUrls.length} bundle candidates, ${probed.length} confirmed by direct call`,
  );
  return { passive, candidates: candidateUrls, probed, requests: [...passive, ...probed] };
}

const ASSET_EXT = /\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map|json)(?:\?|$)/i;

/**
 * Same-origin candidate PAGE urls discovered in a capture's HTML and JS bodies:
 * `<a href>` targets and path-shaped string literals. This is the input to the
 * navigate-discovery means — a headless-working alternative to SPA scroll (which
 * obscura v0.1.11 does not fire): navigating to a page IS captured, so following
 * a discovered list/pagination link surfaces the endpoints that page fires.
 * Complements --scroll rather than replacing it: scroll DOES drive lazy-load on
 * sites whose handler runs under obscura (measured: scrapingcourse's
 * infinite-scroll walked offset=0->10->20->30), but it is silent on sites whose
 * handler does not fire, so link-following is the means that always works.
 * Recognized by SHAPE (same origin, non-asset), never a per-host list.
 */
export function extractSameOriginLinks(capture: RunObscuraCaptureResult): string[] {
  let origin = "";
  try {
    origin = new URL(capture.final_url).origin;
  } catch {
    return [];
  }
  const href = /href\s*=\s*["']([^"'#]+)["']/gi;
  const literal = /["'`](\/[A-Za-z0-9/_?=&.%-]{1,160})["'`]/g;
  // Compare on path+query, not path alone: a ?page=2 pagination link must NOT
  // dedupe against page 1 (pathOf strips the query, which would drop it).
  const pathQ = (u: string) => {
    try {
      const x = new URL(u);
      return `${x.origin}${x.pathname}${x.search}`;
    } catch {
      return u;
    }
  };
  const captured = new Set((capture.requests ?? []).map((r) => pathQ(r.url)));
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    let abs: URL;
    try {
      abs = new URL(raw, origin);
    } catch {
      return;
    }
    if (abs.origin !== origin) return; // same-origin only
    if (ASSET_EXT.test(abs.pathname)) return;
    const key = `${abs.origin}${abs.pathname}${abs.search}`;
    if (seen.has(key)) return;
    if (captured.has(key)) return; // already captured (path+query)
    seen.add(key);
    out.push(abs.href);
  };
  for (const r of capture.requests ?? []) {
    const body = r.response_body;
    if (!body) continue;
    const ct = responseContentType(r);
    if (ct.includes("html")) {
      for (const m of body.matchAll(href)) add(m[1]);
    }
    if (ct.includes("html") || ct.includes("javascript") || ct.includes("ecmascript")) {
      for (const m of body.matchAll(literal)) add(m[1]);
    }
  }
  return out;
}

export interface NavigationDiscoveryOptions {
  intent?: string;
  /** How many discovered links to actually navigate (bounded; default 2). */
  maxFollow?: number;
  /** obscura options forwarded to each follow capture (auth jar, settle, …). */
  captureOpts?: RunObscuraCaptureOptions;
}

/**
 * Follow a bounded set of discovered same-origin links by NAVIGATING obscura to
 * each and unioning the endpoints that navigation captures. A link is worth
 * following only when its route shape is list-like (the shared cardinality gate:
 * a net wants many fish) or it carries a pagination param — so we chase
 * lists/next-pages, not every nav item. Returns the newly-captured RawRequest
 * rows (deduped against the seed capture).
 */
export async function discoverViaNavigation(
  seed: RunObscuraCaptureResult,
  runCapture: (url: string, opts: RunObscuraCaptureOptions) => Promise<RunObscuraCaptureResult>,
  opts: NavigationDiscoveryOptions = {},
): Promise<RawRequest[]> {
  const maxFollow = opts.maxFollow ?? 2;
  if (maxFollow <= 0) return [];
  const links = extractSameOriginLinks(seed);
  const paginationLike = (u: string) => /[?&](page|p|offset|start|cursor)=|\/page\/\d|\/p\/\d/i.test(u);
  const worthFollowing = links.filter(
    (u) =>
      paginationLike(u) ||
      cardinalityMatches(opts.intent, { kind: "route", route: { url_template: u } }, { contextUrl: seed.final_url }),
  );

  const seedPaths = new Set((seed.requests ?? []).map((r) => pathOf(r.url)));
  const found: RawRequest[] = [];
  for (const url of worthFollowing.slice(0, maxFollow)) {
    let cap: RunObscuraCaptureResult;
    try {
      cap = await runCapture(url, opts.captureOpts ?? {});
    } catch {
      continue;
    }
    for (const r of cap.requests ?? []) {
      if (!seedPaths.has(pathOf(r.url))) found.push(r);
    }
  }
  log("obscura-index", `navigate-discovery: ${links.length} links, ${worthFollowing.length} list-like, followed ${Math.min(worthFollowing.length, maxFollow)}, +${found.length} rows`);
  return found;
}

export interface CaptureAndIndexOptions {
  /**
   * SHARE the discovered routes to the shared skill index. Default FALSE —
   * discovery stays local and the shared store is left untouched.
   */
  shareToIndex?: boolean;
  /** Dir to write the sourced obscura cookie jar into (--storage-dir / --cookies). */
  cookiesDir?: string;
  /** Extra options forwarded to runObscuraCapture. */
  captureOpts?: RunObscuraCaptureOptions;
  /** Auth headers injected on each direct endpoint call. */
  authHeaders?: Record<string, string>;
  /** Cap on how many bundle candidates are called directly. */
  maxProbe?: number;
  /**
   * How many discovered same-origin list/pagination links to NAVIGATE (the
   * headless-working discovery means). Default 2; 0 disables link-following.
   */
  maxFollow?: number;
  /**
   * Auth session for the target domain. `undefined` => source it from the user's
   * other browsers via findBestBrowserSession(domain); `null` => skip sourcing.
   */
  session?: BrowserSessionResult | null;
  /** Injected capture runner (tests avoid spawning the sidecar). */
  runCapture?: (url: string, opts: RunObscuraCaptureOptions) => Promise<RunObscuraCaptureResult>;
  /** Injected fetch for the direct endpoint calls. */
  fetchImpl?: typeof fetch;
}

export interface CaptureAndIndexResult {
  /** The raw obscura capture. */
  capture: RunObscuraCaptureResult;
  /** The union of passive + directly-confirmed endpoints. */
  discovery: DiscoverEndpointsResult;
  /** Rows captured by NAVIGATING to discovered same-origin list/pagination links. */
  navigated: RawRequest[];
  /** Deduped union of discovery.requests ∪ navigated — the routes indexed. */
  routes: RawRequest[];
  /**
   * Rows a bot wall answered instead of the origin, with the vendor that did it.
   *
   * Deliberately NOT merged into `routes`: a challenge page would become the
   * endpoint's evidence and response contract. Equally deliberately not
   * discarded — "this route exists and was refused" is a different fact from
   * "no such route", and only the first one is worth escalating.
   */
  blocked: BlockedRequest[];
  /** The shared-index result — null unless shareToIndex was set and rows existed. */
  index: BrowseIndexResult | null;
  /** True iff the shared store was written this call. */
  shared: boolean;
  /**
   * The public egress this capture went out from. Recorded because the origin's
   * session cookies are bound to it — measured, not assumed (see
   * bench/sites100/CHALLENGE-RATE-FINDINGS.md). A later replay from a different
   * egress must treat the harvested session as invalid; `egressAllowsReplay`
   * is the check. `{ip: null}` when the lookup could not resolve, which never
   * invalidates anything.
   */
  egress: EgressIdentity;
}

/**
 * Capture a URL with the Chrome-free obscura backend, discover its internal
 * endpoints, and — ONLY when `opts.shareToIndex === true` — SHARE them to the
 * reusable skill index via cacheBrowseRequests. Returns the discovered routes
 * plus a BrowseIndexResult (or null when nothing was shared).
 */
export async function captureAndIndexViaObscura(
  url: string,
  intent: string | undefined,
  opts: CaptureAndIndexOptions = {},
): Promise<CaptureAndIndexResult> {
  let domain = "";
  try {
    domain = new URL(url).hostname;
  } catch {
    /* leave empty */
  }

  // 1. Source auth: the best jar from the user's OTHER browsers, written into
  //    obscura's cookies.json shape for injection, and as a cookie header for
  //    the direct endpoint calls. Skippable / injectable for hermetic runs.
  let cookiesFile: string | undefined;
  let cookieHeader: string | undefined;
  // Prefer caller's explicit cookiesDir (tests) → persistent per-domain dir (harness, reused across runs) → ephemeral fallback.
  // Persistent is ~/.unbrowse/obscura/<domain>/cookies.json — `obscura --storage-dir` loads it and writes it back.
  const artifact = (() => {
    try {
      const { buildAuthArtifact } = require("../auth/artifact-bridge.js") as typeof import("../auth/artifact-bridge.js");
      return buildAuthArtifact(domain, opts.cookiesDir ? { cookiesDir: opts.cookiesDir } : undefined);
    } catch { return null; }
  })();
  let storageDirForCapture: string | undefined;
  let ephemeralCookiesDir: string | undefined;
  if (artifact) {
    cookieHeader = artifact.header;
    // `buildAuthArtifact` already seeded the persistent jar (0600). Use its storageDir as --storage-dir.
    cookiesFile = artifact.jarFile;
    storageDirForCapture = artifact.storageDir;
  } else {
    const session = opts.session === undefined ? findBestBrowserSession(domain) : opts.session;
    if (session && session.cookies.length > 0) {
      cookieHeader = session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const targetDir = opts.cookiesDir ?? (() => {
        try { const { mkdtempSync } = require("node:fs"); const { tmpdir } = require("node:os"); const { join } = require("node:path"); ephemeralCookiesDir = mkdtempSync(join(tmpdir(), "unbrowse-jar-")); return ephemeralCookiesDir; } catch { return undefined; }
      })();
      if (targetDir) {
        try { cookiesFile = writeObscuraJar(targetDir, session.cookies).cookiesFile; } catch { /* unauthenticated */ }
      }
    }
  }

  // 2. Capture (no Chrome, no CDP).
  const runCapture = opts.runCapture ?? runObscuraCapture;
  const capture = await runCapture(url, {
    ...(opts.captureOpts ?? {}),
    ...(cookiesFile ? { cookiesFile } : {}),
    ...(storageDirForCapture ? { storageDir: storageDirForCapture } : {}),
  });
  // Persist dir reused across runs: cookies + localStorage survive, so the next capture starts logged in.

  // 3. Discover — passive ∪ (bundle-scanned candidates confirmed by direct call).
  const discovery = await discoverEndpoints(capture, {
    intent,
    authHeaders: opts.authHeaders,
    cookieHeader,
    fetchImpl: opts.fetchImpl,
    maxProbe: opts.maxProbe,
  });

  // 3b. Navigate-discovery — follow discovered same-origin list/pagination links
  //     (the headless-working means; obscura v0.1.11 does not fire SPA scroll).
  // Navigation is an explicit escalation: default 0 (off) so the core's cost and
  // call-count are unchanged; the server backend and callers opt in with maxFollow.
  // Same-origin budget (generalized, not per-host): when the bundle scan
  // produced no probes (common on SSR/Next hosts) but same-origin links exist,
  // a bounded navigate (maxFollow=1) surfaces endpoints the seed page never fired.
  // Cost is opt-in bounded (1 navigation) and same-origin only.
  const effectiveMaxFollow = opts.maxFollow ?? (discovery.probed.length === 0 ? 1 : 0);
  const navigated = await discoverViaNavigation(capture, runCapture, {
    intent,
    maxFollow: effectiveMaxFollow,
    captureOpts: { ...(opts.captureOpts ?? {}), ...(cookiesFile ? { cookiesFile } : {}) },
  });

  // A bot wall is not the endpoint's answer. Partition BEFORE dedup, not after.
  //
  // Order is load-bearing and I got it wrong first: dedup is FIRST-WINS by
  // `${method} ${path}`, so when the same endpoint is seen once as a challenge
  // and again as a successful retry, the challenge wins the key — and the
  // partition then removes it, deleting the endpoint outright. That turns
  // "refused" into "absent", which is the exact confusion this partition was
  // added to prevent. Partitioning first lets the successful row survive dedup.
  const { ok: admissibleRaw, blocked: blockedRaw } = partitionBlockedRequests([
    ...discovery.requests,
    ...navigated,
  ]);
  const dedup = new Map<string, RawRequest>();
  for (const r of admissibleRaw) {
    const key = `${r.method} ${pathOf(r.url)}`;
    if (!dedup.has(key)) dedup.set(key, r);
  }
  const routes = [...dedup.values()];
  // An endpoint that ALSO answered for real is not a refusal. Reporting it as
  // blocked would send the caller escalating something they already have.
  const answered = new Set(routes.map((r) => `${r.method} ${pathOf(r.url)}`));
  const blocked = blockedRaw.filter(
    (b) => !answered.has(`${b.request.method} ${pathOf(b.request.url)}`),
  );
  if (blocked.length > 0) {
    const vendors = [...new Set(blocked.map((b) => b.vendor))].join(",");
    console.log(`[obscura-index] ${blocked.length} route(s) refused by ${vendors} — reported, not indexed`);
  }

  // 4. SHARE — opt-in only. Default path writes nothing to the shared store.
  let index: BrowseIndexResult | null = null;
  if (opts.shareToIndex === true && routes.length > 0) {
    index = await cacheBrowseRequests({
      sessionUrl: capture.final_url || url,
      sessionDomain: capture.domain || domain,
      requests: routes,
      intent,
      jsBundles: jsBundleBodies(capture.requests),
    });
  }

  // Record the egress this capture went out from: the origin binds its session
  // cookies to it, so a later replay from elsewhere must not reuse them.
  const egress = await resolveEgress();

  return { capture, discovery, navigated, routes, blocked, index, shared: index !== null, egress };
}
