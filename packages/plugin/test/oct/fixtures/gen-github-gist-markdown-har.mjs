#!/usr/bin/env node
/**
 * Real-network HAR generator (popular app: GitHub REST API) for replay-v2 (body injection):
 *   0) GET  https://api.github.com/gists/public?per_page=1
 *      -> returns [ { id, ... } ]
 *   1) POST https://api.github.com/markdown
 *      body: { "text": "gist:<id>", "mode": "markdown" }
 *
 * Sanitization:
 * - step0 response body first gist id replaced with ID_PLACEHOLDER
 * - step1 request JSON body uses ID_PLACEHOLDER
 *
 * This forces replay-v2 correlation+injection into request bodies.
 */

import { writeFileSync } from "node:fs";

function parseArgs(argv) {
  const out = { out: "", token: process.env.GITHUB_TOKEN || "", sanitize: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    if (a === "--token") out.token = argv[++i];
    if (a === "--sanitize") {
      const v = String(argv[++i] ?? "").toLowerCase();
      out.sanitize = v === "1" || v === "true" || v === "yes" || v === "on";
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.out) {
  // eslint-disable-next-line no-console
  console.error("usage: gen-github-gist-markdown-har.mjs --out /tmp/file.har");
  process.exit(2);
}

const ID_PLACEHOLDER = "gist_id_placeholder_for_replay_v2_0123456789";
const token = String(args.token || "").trim();

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

const base = "https://api.github.com";
const step0Url = `${base}/gists/public?per_page=1`;
const step0 = await doFetch(step0Url, {
  method: "GET",
  headers: {
    accept: "application/vnd.github+json",
    "user-agent": "unbrowse-oct",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
});
if (step0.status !== 200) {
  // eslint-disable-next-line no-console
  console.error("github gists failed:", step0.status, step0.text.slice(0, 200));
  process.exit(1);
}

let gists;
try { gists = JSON.parse(step0.text); } catch { gists = null; }
const firstId = Array.isArray(gists) ? gists?.[0]?.id : null;
if (typeof firstId !== "string" || firstId.length < 8) {
  // eslint-disable-next-line no-console
  console.error("github gist id parse failed:", String(firstId));
  process.exit(1);
}

const step1Url = `${base}/markdown`;
// Correlation engine matches exact values (not substrings), so keep the id as the full text payload.
const realBody = { text: String(firstId), mode: "markdown" };
const step1 = await doFetch(step1Url, {
  method: "POST",
  headers: {
    accept: "text/html",
    "content-type": "application/json",
    "user-agent": "unbrowse-oct",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(realBody),
});
if (step1.status !== 200) {
  // eslint-disable-next-line no-console
  console.error("github markdown failed:", step1.status, step1.text.slice(0, 200));
  process.exit(1);
}

// Optionally sanitize captured artifacts (deterministic correlation tests).
const step0Text = (() => {
  if (!args.sanitize) return step0.text;
  const gistsSan = Array.isArray(gists)
    ? [{ ...(gists[0] ?? {}), id: ID_PLACEHOLDER }, ...gists.slice(1)]
    : gists;
  return JSON.stringify(gistsSan);
})();

const step1Body = args.sanitize ? JSON.stringify({ text: ID_PLACEHOLDER, mode: "markdown" }) : JSON.stringify(realBody);

function toHarEntry({ startedDateTime, method, url, reqHeaders, reqBodyText, status, respHeaders, respText, respMime, timeMs }) {
  return {
    startedDateTime,
    request: {
      method,
      url,
      headers: Object.entries(reqHeaders).map(([name, value]) => ({ name, value })),
      cookies: [],
      queryString: queryStringFromUrl(url),
      ...(reqBodyText
        ? { postData: { mimeType: "application/json", text: reqBodyText } }
        : {}),
    },
    response: {
      status,
      headers: respHeaders,
      content: { mimeType: respMime, text: respText },
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
        url: step0Url,
        reqHeaders: { accept: "application/vnd.github+json", "user-agent": "unbrowse-oct", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        status: step0.status,
        respHeaders: step0.headers,
        respText: step0Text,
        respMime: "application/json",
        timeMs: step0.ms,
      }),
      toHarEntry({
        startedDateTime: new Date(now - 9).toISOString(),
        method: "POST",
        url: step1Url,
        reqHeaders: { accept: "text/html", "content-type": "application/json", "user-agent": "unbrowse-oct", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        reqBodyText: step1Body,
        status: step1.status,
        respHeaders: step1.headers,
        respText: step1.text,
        respMime: "text/html",
        timeMs: step1.ms,
      }),
    ],
  },
};

writeFileSync(args.out, JSON.stringify(har, null, 2), "utf-8");
// eslint-disable-next-line no-console
console.log(args.out);
