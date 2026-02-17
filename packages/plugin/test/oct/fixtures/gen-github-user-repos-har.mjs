#!/usr/bin/env node
/**
 * Real-network HAR generator (popular app: GitHub REST API) for replay-v2:
 *   0) GET  https://api.github.com/users/<user>            -> returns { login, ... }
 *   1) GET  https://api.github.com/users/<login>/repos    -> should use login from step 0
 *
 * Sanitization:
 * - step0 response body "login" is replaced with LOGIN_PLACEHOLDER
 * - step1 request path uses LOGIN_PLACEHOLDER in place of login
 *
 * This forces replay-v2 correlation+injection into URL path segments.
 */

import { writeFileSync } from "node:fs";

function parseArgs(argv) {
  const out = { out: "", user: "torvalds", token: process.env.GITHUB_TOKEN || "", sanitize: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    if (a === "--user") out.user = argv[++i];
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
  console.error("usage: gen-github-user-repos-har.mjs --out /tmp/file.har [--user torvalds]");
  process.exit(2);
}

const LOGIN_PLACEHOLDER = "login_placeholder_for_replay_v2_0123456789";

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
const user = String(args.user || "torvalds");
const token = String(args.token || "").trim();

const step0Url = `${base}/users/${encodeURIComponent(user)}`;
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
  console.error("github step0 failed:", step0.status, step0.text.slice(0, 200));
  process.exit(1);
}

let userJson;
try { userJson = JSON.parse(step0.text); } catch { userJson = null; }
const login = userJson?.login;
if (typeof login !== "string" || login.length < 8) {
  // eslint-disable-next-line no-console
  console.error("github login parse failed / too short:", String(login));
  process.exit(1);
}

const step1UrlReal = `${base}/users/${encodeURIComponent(login)}/repos?per_page=1`;
const step1 = await doFetch(step1UrlReal, {
  method: "GET",
  headers: {
    accept: "application/vnd.github+json",
    "user-agent": "unbrowse-oct",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
});
if (step1.status !== 200) {
  // eslint-disable-next-line no-console
  console.error("github step1 failed:", step1.status, step1.text.slice(0, 200));
  process.exit(1);
}

// Optionally sanitize captured artifacts (deterministic correlation tests).
const step0Text = args.sanitize ? JSON.stringify({ ...(userJson ?? {}), login: LOGIN_PLACEHOLDER }) : step0.text;
const step1Url = args.sanitize ? `${base}/users/${encodeURIComponent(LOGIN_PLACEHOLDER)}/repos?per_page=1` : step1UrlReal;

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
        startedDateTime: new Date(now - 10).toISOString(),
        method: "GET",
        url: step0Url,
        reqHeaders: { accept: "application/vnd.github+json", "user-agent": "unbrowse-oct", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        status: step0.status,
        respHeaders: step0.headers,
        respText: step0Text,
        timeMs: step0.ms,
      }),
      toHarEntry({
        startedDateTime: new Date(now - 9).toISOString(),
        method: "GET",
        url: step1Url,
        reqHeaders: { accept: "application/vnd.github+json", "user-agent": "unbrowse-oct", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        status: step1.status,
        respHeaders: step1.headers,
        respText: step1.text,
        timeMs: step1.ms,
      }),
    ],
  },
};

writeFileSync(args.out, JSON.stringify(har, null, 2), "utf-8");
// eslint-disable-next-line no-console
console.log(args.out);
