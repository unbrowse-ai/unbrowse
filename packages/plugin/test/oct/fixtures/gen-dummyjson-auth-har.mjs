#!/usr/bin/env node
/**
 * Generate a real HAR capturing a token-gated flow on DummyJSON:
 *   POST /auth/login -> returns accessToken
 *   GET  /auth/me    -> requires Authorization: Bearer <accessToken>
 *
 * For replay-v2 evaluation we replace the captured token with a placeholder in both:
 * - login response body (accessToken)
 * - auth/me request header (Authorization)
 *
 * That forces replay-v2 chaining/injection to work, without using any local mock servers.
 */

import { writeFileSync } from "node:fs";

function parseArgs(argv) {
  const out = {
    out: "",
    baseUrl: "https://dummyjson.com",
    username: "emilys",
    password: "emilyspass",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    if (a === "--base-url") out.baseUrl = argv[++i];
    if (a === "--username") out.username = argv[++i];
    if (a === "--password") out.password = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.out) {
  // eslint-disable-next-line no-console
  console.error("usage: gen-dummyjson-auth-har.mjs --out /tmp/file.har [--base-url https://dummyjson.com] [--username emilys] [--password emilyspass]");
  process.exit(2);
}

const base = String(args.baseUrl).replace(/\/+$/, "");
const PLACEHOLDER = "ACCESS_TOKEN_PLACEHOLDER_0123456789abcdef0123456789abcdef";

async function doFetch(url, init) {
  const started = Date.now();
  const resp = await fetch(url, init);
  const text = await resp.text();
  const headers = [];
  resp.headers.forEach((value, name) => headers.push({ name, value }));
  const ms = Date.now() - started;
  return { status: resp.status, headers, text, ms };
}

const loginUrl = `${base}/auth/login`;
const meUrl = `${base}/auth/me`;

const loginReqBody = {
  username: args.username,
  password: args.password,
  expiresInMins: 5,
};

const loginReqBodyText = JSON.stringify(loginReqBody);

const login = await doFetch(loginUrl, {
  method: "POST",
  headers: { "content-type": "application/json", "accept": "application/json" },
  body: loginReqBodyText,
});

let loginJson;
try { loginJson = JSON.parse(login.text); } catch { loginJson = null; }

const accessToken = loginJson?.accessToken ?? loginJson?.token ?? null;
if (typeof accessToken !== "string" || accessToken.length < 10) {
  // eslint-disable-next-line no-console
  console.error("login failed; response:", login.text.slice(0, 400));
  process.exit(1);
}

// Real "me" request (ensures endpoint still works).
const me = await doFetch(meUrl, {
  method: "GET",
  headers: { "accept": "application/json", "authorization": `Bearer ${accessToken}` },
});
if (me.status !== 200) {
  // eslint-disable-next-line no-console
  console.error("auth/me failed; status:", me.status, "body:", me.text.slice(0, 200));
  process.exit(1);
}

// Sanitize: replace token with placeholder in captured artifacts.
const loginJsonSan = { ...loginJson, accessToken: PLACEHOLDER };
if (typeof loginJsonSan.refreshToken === "string" && loginJsonSan.refreshToken.length > 10) {
  loginJsonSan.refreshToken = `REFRESH_${PLACEHOLDER}`;
}

const loginRespTextSan = JSON.stringify(loginJsonSan);
const meAuthHeaderSan = `Bearer ${PLACEHOLDER}`;

function toHarEntry({ startedDateTime, method, url, reqHeaders, reqBodyText, status, respHeaders, respText, timeMs }) {
  return {
    startedDateTime,
    request: {
      method,
      url,
      headers: Object.entries(reqHeaders).map(([name, value]) => ({ name, value })),
      cookies: [],
      queryString: [],
      postData: reqBodyText != null ? { mimeType: "application/json", text: reqBodyText } : undefined,
    },
    response: {
      status,
      headers: respHeaders,
      content: { mimeType: "application/json", text: respText },
    },
    time: timeMs,
  };
}

const har = {
  log: {
    version: "1.2",
    creator: { name: "unbrowse-oct", version: "1" },
    entries: [
      toHarEntry({
        startedDateTime: new Date(Date.now() - 10).toISOString(),
        method: "POST",
        url: loginUrl,
        reqHeaders: { "content-type": "application/json", "accept": "application/json" },
        reqBodyText: loginReqBodyText,
        status: login.status,
        respHeaders: login.headers,
        respText: loginRespTextSan,
        timeMs: login.ms,
      }),
      toHarEntry({
        startedDateTime: new Date(Date.now() - 9).toISOString(),
        method: "GET",
        url: meUrl,
        reqHeaders: { "accept": "application/json", "Authorization": meAuthHeaderSan },
        reqBodyText: null,
        status: me.status,
        respHeaders: me.headers,
        respText: me.text,
        timeMs: me.ms,
      }),
    ],
  },
};

writeFileSync(args.out, JSON.stringify(har, null, 2), "utf-8");
// eslint-disable-next-line no-console
console.log(args.out);
