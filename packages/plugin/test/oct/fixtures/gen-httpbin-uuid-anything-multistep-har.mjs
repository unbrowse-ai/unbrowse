#!/usr/bin/env node
/**
 * Real-network HAR generator for replay-v2 (3-step chain):
 *   0) GET /uuid -> returns { uuid }
 *   1) GET /anything/step1 (x-echo-token=<uuid>) -> response includes X-Amzn-Trace-Id
 *   2) GET /anything/step2 (x-trace-id=<trace>)  -> echoes X-Trace-Id back
 *
 * We sanitize placeholders so chaining MUST occur:
 * - step0 response body uuid -> UUID_PLACEHOLDER
 * - step1 request header x-echo-token -> UUID_PLACEHOLDER
 * - step1 response header X-Amzn-Trace-Id -> TRACE_PLACEHOLDER
 * - step2 request header x-trace-id -> TRACE_PLACEHOLDER
 */

import { writeFileSync } from "node:fs";

function parseArgs(argv) {
  const out = { out: "", baseUrl: "https://httpbin.org" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    if (a === "--base-url") out.baseUrl = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.out) {
  // eslint-disable-next-line no-console
  console.error("usage: gen-httpbin-uuid-anything-multistep-har.mjs --out /tmp/file.har [--base-url https://httpbin.org]");
  process.exit(2);
}

const base = String(args.baseUrl).replace(/\/+$/, "");
const UUID_PLACEHOLDER = "uuid_placeholder_for_replay_v2_0123456789";
const TRACE_PLACEHOLDER = "trace_placeholder_for_replay_v2_0123456789";

function queryStringFromUrl(url) {
  try {
    const u = new URL(url);
    const qs = [];
    u.searchParams.forEach((value, name) => qs.push({ name, value }));
    return qs;
  } catch {
    return [];
  }
}

async function doFetch(url, init) {
  const started = Date.now();
  const resp = await fetch(url, init);
  const text = await resp.text();
  const headers = [];
  resp.headers.forEach((value, name) => headers.push({ name, value }));
  const ms = Date.now() - started;
  return { status: resp.status, headers, text, ms };
}

const uuidUrl = `${base}/uuid`;
const step1Url = `${base}/anything/step1`;
const step2Url = `${base}/anything/step2`;

const uuidResp = await doFetch(uuidUrl, { method: "GET", headers: { accept: "application/json" } });
if (uuidResp.status !== 200) {
  // eslint-disable-next-line no-console
  console.error("uuid failed:", uuidResp.status, uuidResp.text.slice(0, 200));
  process.exit(1);
}

let uuidJson;
try { uuidJson = JSON.parse(uuidResp.text); } catch { uuidJson = null; }
const uuid = uuidJson?.uuid;
if (typeof uuid !== "string" || uuid.length < 10) {
  // eslint-disable-next-line no-console
  console.error("uuid parse failed:", uuidResp.text.slice(0, 200));
  process.exit(1);
}

const step1 = await doFetch(step1Url, {
  method: "GET",
  headers: { accept: "application/json", "x-echo-token": uuid },
});
if (step1.status !== 200) {
  // eslint-disable-next-line no-console
  console.error("anything step1 failed:", step1.status, step1.text.slice(0, 200));
  process.exit(1);
}

// Extract trace id from step1 response BODY (httpbin echoes proxy-added request headers there).
let step1Json;
try { step1Json = JSON.parse(step1.text); } catch { step1Json = null; }
const traceHeader = step1Json?.headers?.["X-Amzn-Trace-Id"];
if (typeof traceHeader !== "string" || traceHeader.length < 6) {
  // eslint-disable-next-line no-console
  console.error("trace header missing from step1 response body");
  process.exit(1);
}

const step2 = await doFetch(step2Url, {
  method: "GET",
  headers: { accept: "application/json", "x-trace-id": traceHeader },
});
if (step2.status !== 200) {
  // eslint-disable-next-line no-console
  console.error("anything step2 failed:", step2.status, step2.text.slice(0, 200));
  process.exit(1);
}

// Sanitize captured artifacts.
const uuidRespTextSan = JSON.stringify({ ...(uuidJson ?? {}), uuid: UUID_PLACEHOLDER });
const step1ReqHeaderSan = UUID_PLACEHOLDER;
const step1RespTextSan = JSON.stringify({
  ...(step1Json ?? {}),
  headers: { ...((step1Json ?? {}).headers ?? {}), "X-Amzn-Trace-Id": TRACE_PLACEHOLDER },
});
const step2ReqHeaderSan = TRACE_PLACEHOLDER;

function toHarEntry({ startedDateTime, method, url, reqHeaders, status, respHeaders, respText, timeMs }) {
  return {
    startedDateTime,
    request: {
      method,
      url,
      headers: Object.entries(reqHeaders).map(([name, value]) => ({ name, value })),
      cookies: [],
      queryString: queryStringFromUrl(url),
    },
    response: {
      status,
      headers: respHeaders,
      content: { mimeType: "application/json", text: respText },
    },
    time: timeMs,
  };
}

const now = Date.now();
const har = {
  log: {
    version: "1.2",
    creator: { name: "unbrowse-oct", version: "1" },
    entries: [
      toHarEntry({
        startedDateTime: new Date(now - 12).toISOString(),
        method: "GET",
        url: uuidUrl,
        reqHeaders: { accept: "application/json" },
        status: uuidResp.status,
        respHeaders: uuidResp.headers,
        respText: uuidRespTextSan,
        timeMs: uuidResp.ms,
      }),
      toHarEntry({
        startedDateTime: new Date(now - 11).toISOString(),
        method: "GET",
        url: step1Url,
        reqHeaders: { accept: "application/json", "x-echo-token": step1ReqHeaderSan },
        status: step1.status,
        respHeaders: step1.headers,
        respText: step1RespTextSan,
        timeMs: step1.ms,
      }),
      toHarEntry({
        startedDateTime: new Date(now - 10).toISOString(),
        method: "GET",
        url: step2Url,
        reqHeaders: { accept: "application/json", "x-trace-id": step2ReqHeaderSan },
        status: step2.status,
        respHeaders: step2.headers,
        respText: step2.text,
        timeMs: step2.ms,
      }),
    ],
  },
};

writeFileSync(args.out, JSON.stringify(har, null, 2), "utf-8");
// eslint-disable-next-line no-console
console.log(args.out);
