#!/usr/bin/env node
/**
 * Real-network HAR generator (popular app: StackOverflow / StackExchange API) for replay-v2 (3-step chain):
 *   0) GET  /2.3/questions?order=desc&sort=activity&site=stackoverflow&pagesize=1
 *      -> returns items[0].question_id
 *   1) GET  /2.3/questions/<question_id>?site=stackoverflow&filter=default
 *      -> returns items[0].owner.user_id
 *   2) GET  /2.3/users/<user_id>?site=stackoverflow&filter=default
 *
 * Sanitization:
 * - step0 response: items[0].question_id -> QID_PLACEHOLDER (string)
 * - step1 request path uses QID_PLACEHOLDER
 * - step1 response: items[0].owner.user_id -> UID_PLACEHOLDER (string)
 * - step2 request path uses UID_PLACEHOLDER
 *
 * Notes:
 * - Uses placeholders with length >= 8 so correlation-engine considers them.
 * - Runtime extraction can return numeric IDs shorter than 8 digits; injection still works at replay time.
 */

import { writeFileSync } from "node:fs";

function parseArgs(argv) {
  const out = { out: "", baseUrl: "https://api.stackexchange.com", sanitize: false };
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
  console.error("usage: gen-stackoverflow-question-user-chain-har.mjs --out /tmp/file.har [--base-url https://api.stackexchange.com]");
  process.exit(2);
}

const base = String(args.baseUrl).replace(/\/+$/, "");
const QID_PLACEHOLDER = "so_qid_placeholder_for_replay_v2_0123456789";
const UID_PLACEHOLDER = "so_uid_placeholder_for_replay_v2_0123456789";

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

const step0Url = `${base}/2.3/questions?order=desc&sort=activity&site=stackoverflow&pagesize=1`;
const step0 = await doFetch(step0Url, { method: "GET", headers: { accept: "application/json" } });
if (step0.status !== 200) {
  // eslint-disable-next-line no-console
  console.error("so step0 failed:", step0.status, step0.text.slice(0, 200));
  process.exit(1);
}

let q0;
try { q0 = JSON.parse(step0.text); } catch { q0 = null; }
const qid = q0?.items?.[0]?.question_id;
if (typeof qid !== "number" && typeof qid !== "string") {
  // eslint-disable-next-line no-console
  console.error("so qid parse failed:", step0.text.slice(0, 200));
  process.exit(1);
}

const qidStr = String(qid);
const step1UrlReal = `${base}/2.3/questions/${encodeURIComponent(qidStr)}?site=stackoverflow`;
const step1 = await doFetch(step1UrlReal, { method: "GET", headers: { accept: "application/json" } });
if (step1.status !== 200) {
  // eslint-disable-next-line no-console
  console.error("so step1 failed:", step1.status, step1.text.slice(0, 200));
  process.exit(1);
}

let q1;
try { q1 = JSON.parse(step1.text); } catch { q1 = null; }
const uid = q1?.items?.[0]?.owner?.user_id;
if (typeof uid !== "number" && typeof uid !== "string") {
  // eslint-disable-next-line no-console
  console.error("so uid parse failed:", step1.text.slice(0, 200));
  process.exit(1);
}

const uidStr = String(uid);
const step2UrlReal = `${base}/2.3/users/${encodeURIComponent(uidStr)}?site=stackoverflow`;
const step2 = await doFetch(step2UrlReal, { method: "GET", headers: { accept: "application/json" } });
if (step2.status !== 200) {
  // eslint-disable-next-line no-console
  console.error("so step2 failed:", step2.status, step2.text.slice(0, 200));
  process.exit(1);
}

// Optionally sanitize captured artifacts (deterministic correlation tests).
const step0Text = (() => {
  if (!args.sanitize) return step0.text;
  const q0San = {
    ...(q0 ?? {}),
    items: Array.isArray(q0?.items)
      ? [{ ...(q0.items?.[0] ?? {}), question_id: QID_PLACEHOLDER }, ...q0.items.slice(1)]
      : q0?.items,
  };
  return JSON.stringify(q0San);
})();

const step1Url = args.sanitize
  ? `${base}/2.3/questions/${encodeURIComponent(QID_PLACEHOLDER)}?site=stackoverflow`
  : step1UrlReal;

const step1Text = (() => {
  if (!args.sanitize) return step1.text;
  const q1San = {
    ...(q1 ?? {}),
    items: Array.isArray(q1?.items)
      ? [{
        ...(q1.items?.[0] ?? {}),
        owner: { ...((q1.items?.[0] ?? {}).owner ?? {}), user_id: UID_PLACEHOLDER },
      }, ...q1.items.slice(1)]
      : q1?.items,
  };
  return JSON.stringify(q1San);
})();

const step2Url = args.sanitize
  ? `${base}/2.3/users/${encodeURIComponent(UID_PLACEHOLDER)}?site=stackoverflow`
  : step2UrlReal;

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
        url: step0Url,
        reqHeaders: { accept: "application/json" },
        status: step0.status,
        respHeaders: step0.headers,
        respText: step0Text,
        timeMs: step0.ms,
      }),
      toHarEntry({
        startedDateTime: new Date(now - 11).toISOString(),
        method: "GET",
        url: step1Url,
        reqHeaders: { accept: "application/json" },
        status: step1.status,
        respHeaders: step1.headers,
        respText: step1Text,
        timeMs: step1.ms,
      }),
      toHarEntry({
        startedDateTime: new Date(now - 10).toISOString(),
        method: "GET",
        url: step2Url,
        reqHeaders: { accept: "application/json" },
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
