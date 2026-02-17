#!/usr/bin/env node
/**
 * Real-network HAR generator (popular app: Hacker News Firebase API) for replay-v2 (3-step chain):
 *   0) GET /v0/topstories.json         -> returns [id, ...] (dynamic)
 *   1) GET /v0/item/<id>.json          -> returns { by, ... }
 *   2) GET /v0/user/<by>.json          -> returns user profile
 *
 * Sanitization:
 * - step0 response first id -> ID_PLACEHOLDER
 * - step1 request path uses ID_PLACEHOLDER
 * - step1 response "by" -> USER_PLACEHOLDER
 * - step2 request path uses USER_PLACEHOLDER
 *
 * Guards:
 * - chooses a top story where "by" exists and has length >= 8 (correlation-engine ignores shorter strings).
 */

import { writeFileSync } from "node:fs";

function parseArgs(argv) {
  const out = { out: "", baseUrl: "https://hacker-news.firebaseio.com", sanitize: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    if (a === "--base-url") out.baseUrl = argv[++i];
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
  console.error("usage: gen-hn-topstory-item-user-har.mjs --out /tmp/file.har [--base-url https://hacker-news.firebaseio.com]");
  process.exit(2);
}

const base = String(args.baseUrl).replace(/\/+$/, "");
const ID_PLACEHOLDER = "hn_id_placeholder_for_replay_v2_0123456789";
const USER_PLACEHOLDER = "hn_user_placeholder_for_replay_v2_0123456789";

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

const topUrl = `${base}/v0/topstories.json`;
const top = await doFetch(topUrl, { method: "GET", headers: { accept: "application/json" } });
if (top.status !== 200) {
  // eslint-disable-next-line no-console
  console.error("hn topstories failed:", top.status, top.text.slice(0, 200));
  process.exit(1);
}

let ids;
try { ids = JSON.parse(top.text); } catch { ids = null; }
if (!Array.isArray(ids) || ids.length < 3) {
  // eslint-disable-next-line no-console
  console.error("hn topstories parse failed");
  process.exit(1);
}

let pickedId = null;
let pickedItem = null;
let pickedBy = null;

for (const id of ids.slice(0, 15)) {
  if (typeof id !== "number" && typeof id !== "string") continue;
  const idStr = String(id);
  if (idStr.length < 8) continue;
  const itemUrl = `${base}/v0/item/${encodeURIComponent(idStr)}.json`;
  const itemResp = await doFetch(itemUrl, { method: "GET", headers: { accept: "application/json" } });
  if (itemResp.status !== 200) continue;
  let itemJson;
  try { itemJson = JSON.parse(itemResp.text); } catch { itemJson = null; }
  const by = itemJson?.by;
  if (typeof by !== "string" || by.length < 8) continue;
  if (itemJson?.deleted || itemJson?.dead) continue;
  pickedId = idStr;
  pickedItem = { url: itemUrl, resp: itemResp, json: itemJson };
  pickedBy = by;
  break;
}

if (!pickedId || !pickedItem || !pickedBy) {
  // eslint-disable-next-line no-console
  console.error("hn: no suitable top story found (need by length >= 8)");
  process.exit(1);
}

const userUrlReal = `${base}/v0/user/${encodeURIComponent(pickedBy)}.json`;
const userResp = await doFetch(userUrlReal, { method: "GET", headers: { accept: "application/json" } });
if (userResp.status !== 200) {
  // eslint-disable-next-line no-console
  console.error("hn user failed:", userResp.status, userResp.text.slice(0, 200));
  process.exit(1);
}

// Optionally sanitize captured artifacts (deterministic correlation tests).
const topText = args.sanitize ? JSON.stringify([ID_PLACEHOLDER, ...ids.slice(1)]) : top.text;
const itemUrl = args.sanitize ? `${base}/v0/item/${encodeURIComponent(ID_PLACEHOLDER)}.json` : pickedItem.url;
const itemText = args.sanitize ? JSON.stringify({ ...(pickedItem.json ?? {}), by: USER_PLACEHOLDER }) : pickedItem.resp.text;
const userUrl = args.sanitize ? `${base}/v0/user/${encodeURIComponent(USER_PLACEHOLDER)}.json` : userUrlReal;

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
        url: topUrl,
        reqHeaders: { accept: "application/json" },
        status: top.status,
        respHeaders: top.headers,
        respText: topText,
        timeMs: top.ms,
      }),
      toHarEntry({
        startedDateTime: new Date(now - 11).toISOString(),
        method: "GET",
        url: itemUrl,
        reqHeaders: { accept: "application/json" },
        status: pickedItem.resp.status,
        respHeaders: pickedItem.resp.headers,
        respText: itemText,
        timeMs: pickedItem.resp.ms,
      }),
      toHarEntry({
        startedDateTime: new Date(now - 10).toISOString(),
        method: "GET",
        url: userUrl,
        reqHeaders: { accept: "application/json" },
        status: userResp.status,
        respHeaders: userResp.headers,
        respText: userResp.text,
        timeMs: userResp.ms,
      }),
    ],
  },
};

writeFileSync(args.out, JSON.stringify(har, null, 2), "utf-8");
// eslint-disable-next-line no-console
console.log(args.out);
