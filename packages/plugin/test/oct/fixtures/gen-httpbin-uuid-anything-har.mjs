#!/usr/bin/env node
/**
 * Real-network HAR generator for replay-v2:
 *   GET /uuid      -> returns { uuid }
 *   GET /anything  -> echoes request headers; we send x-echo-token=<uuid>
 *
 * For evals we replace the captured uuid with a placeholder in BOTH:
 * - /uuid response body
 * - /anything request header x-echo-token
 *
 * This forces replay-v2 chaining+injection to work (the real uuid at replay time differs).
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
  console.error("usage: gen-httpbin-uuid-anything-har.mjs --out /tmp/file.har [--base-url https://httpbin.org]");
  process.exit(2);
}

const base = String(args.baseUrl).replace(/\/+$/, "");
const PLACEHOLDER = "uuid_placeholder_for_replay_v2_0123456789";

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
const anythingUrl = `${base}/anything`;

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

const anyResp = await doFetch(anythingUrl, {
  method: "GET",
  headers: { accept: "application/json", "x-echo-token": uuid },
});
if (anyResp.status !== 200) {
  // eslint-disable-next-line no-console
  console.error("anything failed:", anyResp.status, anyResp.text.slice(0, 200));
  process.exit(1);
}

// Sanitize captured artifacts (placeholder in BOTH places).
const uuidRespTextSan = JSON.stringify({ ...(uuidJson ?? {}), uuid: PLACEHOLDER });
const anyReqHeaderSan = PLACEHOLDER;

function toHarEntry({ startedDateTime, method, url, reqHeaders, status, respHeaders, respText, timeMs }) {
  return {
    startedDateTime,
    request: {
      method,
      url,
      headers: Object.entries(reqHeaders).map(([name, value]) => ({ name, value })),
      cookies: [],
      queryString: [],
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
        startedDateTime: new Date(now - 10).toISOString(),
        method: "GET",
        url: uuidUrl,
        reqHeaders: { accept: "application/json" },
        status: uuidResp.status,
        respHeaders: uuidResp.headers,
        respText: uuidRespTextSan,
        timeMs: uuidResp.ms,
      }),
      toHarEntry({
        startedDateTime: new Date(now - 9).toISOString(),
        method: "GET",
        url: anythingUrl,
        reqHeaders: { accept: "application/json", "x-echo-token": anyReqHeaderSan },
        status: anyResp.status,
        respHeaders: anyResp.headers,
        respText: anyResp.text,
        timeMs: anyResp.ms,
      }),
    ],
  },
};

writeFileSync(args.out, JSON.stringify(har, null, 2), "utf-8");
// eslint-disable-next-line no-console
console.log(args.out);

