/**
 * The Chrome-free capture engine.
 *
 * `src/capture/index.ts` (`captureSession`) learns a site's internal API routes
 * by driving Chrome and reading four CDP primitives:
 *   Page.addScriptToEvaluateOnNewDocument, Network.requestWillBeSent,
 *   Network.responseReceived, Network.getResponseBody.
 *
 * This module gets the same data from obscura's native primitives — `on_request`
 * / `on_response` (with response bodies) inside the `obscura-capture` sidecar —
 * with no Chrome and no CDP socket. It parses the sidecar's NDJSON into the
 * exact `RawRequest[]` shape the reverse-engineering pipeline consumes
 * (`revengLocal` / `revengServerFirst` / `cacheBrowseRequests`), so captured
 * routes flow downstream unchanged.
 *
 * Known gap vs the CDP path: obscura's passive callbacks expose the response
 * body but not the request body, so `request_body` is undefined here. That only
 * affects POST-with-payload endpoints; GET/collection routes — what the
 * admission gate (`admitCandidate`: GET/2xx/collection) actually indexes — are
 * fully captured. Request-body capture is available via obscura's
 * `enable_interception()` channel and can be layered in later.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { RawRequest } from "./index.js";
import { classifyExecuteFailure } from "../values/blocker-classification.js";
import {
  firstExisting,
  obscuraVendorCandidatePaths,
  type ObscuraBin,
} from "../obscura/resolve-bin.js";

/** One `{"kind":"response",...}` line emitted by the sidecar. */
export interface ObscuraResponseRecord {
  kind: "response";
  url: string;
  method: string;
  resourceType: string;
  reqHeaders: Record<string, string>;
  status: number;
  respHeaders: Record<string, string>;
  contentType: string | null;
  bodyText: string | null;
  bodyLen: number;
  bodyTruncated: boolean;
  ts: number;
}

/** The final `{"kind":"page",...}` line: settled URL, HTML size, cookie jar. */
export interface ObscuraPageRecord {
  kind: "page";
  url: string;
  requestedUrl: string;
  htmlLen: number;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
  }>;
}

/** Parsed capture: RawRequest rows for the pipeline plus the page summary. */
export interface ObscuraCapture {
  requests: RawRequest[];
  page?: ObscuraPageRecord;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
    && value >= -8_640_000_000_000_000 && value <= 8_640_000_000_000_000;
}

function isObscuraResponseRecord(value: unknown): value is ObscuraResponseRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<ObscuraResponseRecord>;
  return r.kind === "response"
    && typeof r.url === "string"
    && typeof r.method === "string"
    && typeof r.resourceType === "string"
    && typeof r.status === "number"
    && Number.isSafeInteger(r.status)
    && r.status >= 0
    && r.status <= 999
    && isValidTimestamp(r.ts)
    && isStringRecord(r.reqHeaders)
    && isStringRecord(r.respHeaders)
    && (r.contentType === null || typeof r.contentType === "string")
    && (r.bodyText === null || typeof r.bodyText === "string")
    && typeof r.bodyLen === "number"
    && Number.isSafeInteger(r.bodyLen)
    && r.bodyLen >= 0
    && typeof r.bodyTruncated === "boolean";
}

function isObscuraPageRecord(value: unknown): value is ObscuraPageRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<ObscuraPageRecord>;
  if (r.kind !== "page" || typeof r.url !== "string" || typeof r.requestedUrl !== "string"
      || typeof r.htmlLen !== "number" || !Number.isSafeInteger(r.htmlLen) || r.htmlLen < 0
      || !Array.isArray(r.cookies)) return false;
  return r.cookies.every((cookie) => Boolean(cookie) && typeof cookie === "object"
    && typeof cookie.name === "string" && typeof cookie.value === "string"
    && typeof cookie.domain === "string" && typeof cookie.path === "string"
    && typeof cookie.secure === "boolean" && typeof cookie.httpOnly === "boolean");
}

/** Map one sidecar response record to unbrowse's RawRequest shape. */
export function responseRecordToRawRequest(r: ObscuraResponseRecord): RawRequest {
  return {
    url: r.url,
    method: r.method,
    request_headers: r.reqHeaders,
    // obscura's passive callback carries no request body (see module docs).
    request_body: undefined,
    response_status: r.status,
    response_headers: r.respHeaders,
    response_body: r.bodyText ?? undefined,
    // Real capture-order clock from the sidecar; reveng-local reads it, never
    // drawing its own, so `same input => byte-identical output` holds.
    timestamp: new Date(r.ts).toISOString(),
  };
}

/**
 * Parse the sidecar's NDJSON stdout into RawRequest rows + the page record.
 * Pure and total: malformed lines and malformed records are skipped, order is
 * preserved. Non-textual responses (no `bodyText`) still produce a RawRequest
 * so header/status-only evidence survives — admission downstream drops what it
 * can't use.
 */
export function parseObscuraCapture(ndjson: string): ObscuraCapture {
  const requests: RawRequest[] = [];
  let page: ObscuraPageRecord | undefined;
  for (const line of ndjson.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (isObscuraResponseRecord(obj)) {
      requests.push(responseRecordToRawRequest(obj));
    } else if (isObscuraPageRecord(obj)) {
      page = obj;
    }
  }
  return { requests, page };
}

/**
 * Keep only rows that look like an internal data API — a textual/JSON body or a
 * `/api|/graphql|/gql` URL. Optional noise reduction before enqueueing; the
 * admission gate enforces the real contract, so this is a convenience, not a
 * correctness boundary.
 */
export function apiLikelyRequests(requests: RawRequest[]): RawRequest[] {
  return requests.filter((r) => {
    const ct = (r.response_headers?.["content-type"] ?? r.response_headers?.["Content-Type"] ?? "").toLowerCase();
    const looksApiCt = ct.includes("json") || ct.includes("graphql") || ct.includes("protobuf");
    const looksApiUrl = /\/(api|graphql|gql|v\d+)\//i.test(r.url) || /graphql|gql/i.test(r.url);
    return (looksApiCt && Boolean(r.response_body)) || looksApiUrl;
  });
}

/**
 * Could this response BE a wall, structurally?
 *
 * `classifyExecuteFailure` matches vendor markers anywhere in the body, which is
 * right for a failed execute and wrong for a whole capture: measured on
 * defillama, a 200 `application/javascript` chunk that merely REFERENCES
 * `/cdn-cgi/challenge-platform/...` was classified `vendor_blocked` and dropped
 * from the routes — losing a real row to a mention of a wall.
 *
 * The shape of the thing, not a list of names: a wall is a DOCUMENT served in
 * place of the answer, or an error status. A 2xx carrying script, JSON, CSS or
 * an image IS the origin's answer — whatever its bytes happen to mention. Note
 * Cloudflare does serve interstitials with 200, so status alone is not enough;
 * a 2xx `text/html` still gets asked.
 *
 * Biased toward keeping rows: over-blocking silently deletes captured endpoints,
 * and "a merge that would reduce the endpoint count is skipped whole" is already
 * the house rule for exactly that reason.
 */
function couldBeAWall(r: RawRequest): boolean {
  if (r.response_status >= 400) return true;
  const h = r.response_headers ?? {};
  const ct = String(h["content-type"] ?? h["Content-Type"] ?? "").toLowerCase();
  return ct.includes("html");
}

/** A captured row plus WHY it is not the origin's answer. */
export interface BlockedRequest {
  request: RawRequest;
  vendor: string;
  evidence: string;
}

/**
 * Split captured rows into the origin's real answers and the bot walls standing
 * in front of them.
 *
 * Necessary because admission looks at SHAPE, not outcome: `apiLikelyRequests`
 * matches `/api/…` in the URL and never reads the status, so a Cloudflare
 * interstitial served for a real endpoint sails through and becomes that
 * endpoint's evidence. Measured on defillama: obscura asked for
 * `/api/public/protocol-rankings` and got 403 + 6,930 bytes of
 * "Just a moment..." (`cf-mitigated: challenge`), while Chrome got 200 and
 * 301,918 bytes of JSON. Same request, same page — the route was never missing,
 * it was refused.
 *
 * Classification is delegated, never re-implemented: `classifyExecuteFailure`
 * already knows Cloudflare, DataDome, PerimeterX, Akamai, Imperva and Fastly by
 * their structural markers, so a new vendor is recognised here for free.
 */
export function partitionBlockedRequests(
  requests: readonly RawRequest[],
): { ok: RawRequest[]; blocked: BlockedRequest[] } {
  const ok: RawRequest[] = [];
  const blocked: BlockedRequest[] = [];
  for (const r of requests) {
    if (!couldBeAWall(r)) {
      ok.push(r);
      continue;
    }
    const c = classifyExecuteFailure({
      status: r.response_status,
      body: r.response_body,
      headers: r.response_headers,
    });
    if (c.kind === "vendor_blocked") {
      blocked.push({ request: r, vendor: c.vendor ?? "unknown", evidence: c.evidence ?? "" });
    } else {
      ok.push(r);
    }
  }
  return { ok, blocked };
}

/** Locate a resolved obscura binary path, or null if none is installed. */
export function resolveObscuraBin(
  bin: ObscuraBin,
  opts?: { execDir?: string; moduleDir?: string; env?: Record<string, string | undefined> },
): string | null {
  const candidates = obscuraVendorCandidatePaths({
    bin,
    execDir: opts?.execDir ?? dirname(process.execPath),
    moduleDir: opts?.moduleDir ?? import.meta.dirname,
    env: opts?.env,
  });
  // env override / absolute vendor paths are checked with existsSync; a bare
  // name (last candidate) is accepted as a PATH lookup for execFile to resolve.
  const resolved = firstExisting(candidates.slice(0, -1), existsSync);
  return resolved ?? candidates[candidates.length - 1] ?? null;
}

export interface RunObscuraCaptureOptions {
  /**
   * Cap for a single captured response body. Defaults to 4MB — the sidecar's own
   * default truncates near 512KB, which loses SSR payloads on real pages.
   * Override with UNBROWSE_OBSCURA_MAX_BODY for constrained environments.
   */
  maxBodyBytes?: number;
  /** Path to an obscura cookies.json (auth injection). See writeObscuraJar. */
  cookiesFile?: string;
  /** obscura --storage-dir (persisted jar + localStorage). */
  storageDir?: string;
  /** ms to settle the JS event loop after load (default 4000). */
  settleMs?: number;
  /** CSS selector to wait for before settling. */
  waitSelector?: string;
  /** Turn on obscura stealth TLS fingerprinting (requires a stealth binary). */
  stealth?: boolean;
  /** Overall spawn timeout in ms (default 60000). */
  timeoutMs?: number;
  /** Explicit sidecar path (else resolved via resolveObscuraBin). */
  binPath?: string;
}

/** Result of a live capture, shaped toward CaptureResult's consumer contract. */
/**
 * Did the origin return NOTHING — no requests and no bytes?
 *
 * Structural, not a hostname list: zero of both is the signature of an origin
 * that never answered, and it is the only thing separating "this host does not
 * exist" from "this page simply has no XHR". Both were `routes: 0` before this,
 * so a caller could not tell a pointless retry from a fruitless one.
 *
 * Measured on swapi.dev (no DNS record): requests=0, html_len=0. On a live page:
 * requests=1, html_len=544. A static page always brings at least its own
 * document, so this cannot misfire on "boring but real".
 */
export function capturedNothing(requestCount: number, htmlLen: number): boolean {
  return requestCount === 0 && htmlLen === 0;
}

export interface RunObscuraCaptureResult {
  requests: RawRequest[];
  final_url: string;
  html_len: number;
  cookies: ObscuraPageRecord["cookies"];
  domain: string;
  /**
   * Set when the origin returned NOTHING — no requests and no bytes of HTML.
   *
   * Without it, a host that does not resolve is indistinguishable from a static
   * page with no XHR: both are `routes: 0`. Measured on swapi.dev (no DNS
   * record): requests=0, html_len=0, and no error anywhere in the result, so a
   * caller could not tell "retry is pointless" from "nothing to learn here" —
   * different retries, same silence.
   *
   * The value is the canonical `origin_down` token the rest of the engine already
   * uses, so `values/origin-health.ts` classifies it with no new vocabulary.
   */
  error?: string;
}

/**
 * Run the sidecar against `url` and return parsed RawRequest rows plus page
 * summary. Spawns `obscura-capture` (no Chrome, no CDP). Rejects if the binary
 * is missing or the process fails.
 */
export function runObscuraCapture(
  url: string,
  opts: RunObscuraCaptureOptions = {},
): Promise<RunObscuraCaptureResult> {
  const bin = opts.binPath ?? resolveObscuraBin("obscura-capture");
  if (!bin) {
    return Promise.reject(new Error("obscura-capture binary not found (set UNBROWSE_OBSCURA_CAPTURE_BIN)"));
  }
  // --max-body: the sidecar's DEFAULT silently truncates response bodies at
  // ~512KB, and we were never passing it. Measured on defillama.com: the
  // document arrived as 524,286 bytes against a real page of 1,254,471 — the
  // server-rendered payload that carries the indexable endpoints sits past that
  // cut, so obscura indexed 0 endpoints where the CDP engine indexed 4.
  // Raising it recovered 923,685 bytes of the same document.
  const maxBody = opts.maxBodyBytes ?? Number(process.env.UNBROWSE_OBSCURA_MAX_BODY ?? 4 * 1024 * 1024);
  const args: string[] = [url, "--settle", String(opts.settleMs ?? 4000), "--max-body", String(maxBody)];
  if (opts.cookiesFile) args.push("--cookies", opts.cookiesFile);
  if (opts.storageDir) args.push("--storage-dir", opts.storageDir);
  if (opts.waitSelector) args.push("--wait", opts.waitSelector);
  if (opts.stealth) args.push("--stealth");

  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: opts.timeoutMs ?? 60000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        const { requests, page } = parseObscuraCapture(stdout);
        const final_url = page?.url ?? url;
        let domain = "";
        try {
          domain = new URL(final_url).hostname;
        } catch {
          /* leave empty on unparseable url */
        }
        const htmlLen = page?.htmlLen ?? 0;
        const nothingReceived = capturedNothing(requests.length, htmlLen);
        resolve({
          requests,
          final_url,
          html_len: htmlLen,
          cookies: page?.cookies ?? [],
          domain,
          ...(nothingReceived ? { error: "origin_down" } : {}),
        });
      },
    );
  });
}
