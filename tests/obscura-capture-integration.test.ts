/**
 * GATE: the Chrome-free capture path produces RawRequest rows that unbrowse's
 * REAL reverse-engineering pipeline turns into a learned, parameterized route.
 *
 * This is the moat with Chrome ripped out. The fixture is the exact NDJSON the
 * `obscura-capture` sidecar emits for quotes.toscrape.com/scroll — a page whose
 * JS fires an internal JSON API (`/api/quotes?page=1`) on load. We parse it to
 * RawRequest[] and feed it into `revengLocal` (the same function `captureSession`
 * feeds), asserting a `/api/quotes` endpoint with a `{page}` hole comes out.
 *
 * No network, no Chrome, no CDP — the sidecar's output shape is frozen here so a
 * regression in the adapter or the pipeline goes red.
 */

import { test, expect, describe } from "bun:test";
import {
  parseObscuraCapture,
  responseRecordToRawRequest,
  apiLikelyRequests,
  type ObscuraResponseRecord,
} from "../src/capture/obscura-capture.js";
import { revengLocal } from "../src/capture/reveng-local.js";

const API_BODY = JSON.stringify({
  has_next: false,
  page: 1,
  quotes: [
    { author: { name: "Albert Einstein", goodreads_link: "/author/show/9810" }, tags: ["change", "world"], text: "The world as we have created it is a process of our thinking." },
    { author: { name: "J.K. Rowling" }, tags: ["abilities", "choices"], text: "It is our choices, Harry, that show what we truly are." },
  ],
  tag: null,
  top_ten_tags: [["love", 30], ["life", 20]],
});

const FIXTURE_NDJSON = [
  JSON.stringify({ kind: "response", url: "https://quotes.toscrape.com/scroll", method: "GET", resourceType: "document", reqHeaders: {}, status: 200, respHeaders: { "content-type": "text/html" }, contentType: "text/html", bodyText: "<html></html>", bodyLen: 12, bodyTruncated: false, ts: 1785853139900 }),
  JSON.stringify({ kind: "response", url: "https://quotes.toscrape.com/static/main.css", method: "GET", resourceType: "stylesheet", reqHeaders: {}, status: 200, respHeaders: { "content-type": "text/css" }, contentType: "text/css", bodyText: "body{}", bodyLen: 6, bodyTruncated: false, ts: 1785853139910 }),
  JSON.stringify({ kind: "response", url: "https://quotes.toscrape.com/api/quotes?page=1", method: "GET", resourceType: "fetch", reqHeaders: { accept: "application/json" }, status: 200, respHeaders: { "content-type": "application/json" }, contentType: "application/json", bodyText: API_BODY, bodyLen: API_BODY.length, bodyTruncated: false, ts: 1785853139940 }),
  JSON.stringify({ kind: "page", url: "https://quotes.toscrape.com/scroll", requestedUrl: "https://quotes.toscrape.com/scroll", htmlLen: 2673, cookies: [] }),
].join("\n");

describe("responseRecordToRawRequest", () => {
  test("maps sidecar record onto the exact RawRequest shape", () => {
    const rec: ObscuraResponseRecord = {
      kind: "response", url: "https://x.test/api/y", method: "GET", resourceType: "fetch",
      reqHeaders: { accept: "application/json" }, status: 200,
      respHeaders: { "content-type": "application/json" }, contentType: "application/json",
      bodyText: '{"data":[]}', bodyLen: 11, bodyTruncated: false, ts: 1785853139940,
    };
    const raw = responseRecordToRawRequest(rec);
    expect(raw.url).toBe("https://x.test/api/y");
    expect(raw.method).toBe("GET");
    expect(raw.request_headers).toEqual({ accept: "application/json" });
    expect(raw.response_status).toBe(200);
    expect(raw.response_body).toBe('{"data":[]}');
    // request body is not available from obscura's passive callback (documented gap)
    expect(raw.request_body).toBeUndefined();
    // real capture-order clock, mapped to ISO
    expect(raw.timestamp).toBe(new Date(1785853139940).toISOString());
  });
});

describe("parseObscuraCapture", () => {
  test("splits response rows from the page record, preserving order", () => {
    const { requests, page } = parseObscuraCapture(FIXTURE_NDJSON);
    expect(requests.length).toBe(3);
    expect(requests.map((r) => r.url)).toEqual([
      "https://quotes.toscrape.com/scroll",
      "https://quotes.toscrape.com/static/main.css",
      "https://quotes.toscrape.com/api/quotes?page=1",
    ]);
    expect(page?.url).toBe("https://quotes.toscrape.com/scroll");
    expect(page?.htmlLen).toBe(2673);
  });

  test("skips malformed lines without throwing", () => {
    const { requests } = parseObscuraCapture('not json\n{"kind":"response","url":"https://z.test/","method":"GET","resourceType":"xhr","status":200,"reqHeaders":{},"respHeaders":{},"contentType":null,"bodyText":null,"bodyLen":0,"bodyTruncated":false,"ts":1}\n{bad');
    expect(requests.length).toBe(1);
    expect(requests[0].url).toBe("https://z.test/");
  });

  test("skips structurally invalid records found by the fuzz harness", () => {
    const invalid = '{"kind":"response","url":null,"method":3,"status":"bad","ts":"not-a-date"}';
    const incomplete = JSON.stringify({
      kind: "response", url: "https://x.test/api", method: "GET", status: 200,
      reqHeaders: {}, respHeaders: {}, bodyText: null, ts: 1,
    });
    expect(() => parseObscuraCapture(`${invalid}\n${incomplete}`)).not.toThrow();
    expect(parseObscuraCapture(`${invalid}\n${incomplete}`)).toEqual({ requests: [], page: undefined });
  });
});

describe("apiLikelyRequests", () => {
  test("keeps the JSON API row, drops the css asset", () => {
    const { requests } = parseObscuraCapture(FIXTURE_NDJSON);
    const api = apiLikelyRequests(requests);
    expect(api.some((r) => r.url.includes("/api/quotes"))).toBe(true);
    expect(api.some((r) => r.url.includes("main.css"))).toBe(false);
  });
});

describe("end-to-end: obscura capture -> revengLocal learned route", () => {
  test("produces a parameterized /api/quotes endpoint from the sidecar output", () => {
    const { requests } = parseObscuraCapture(FIXTURE_NDJSON);
    const endpoints = revengLocal(requests, {
      pageUrl: "https://quotes.toscrape.com/scroll",
      finalUrl: "https://quotes.toscrape.com/scroll",
    });
    expect(endpoints.length).toBeGreaterThanOrEqual(1);
    const quotes = endpoints.find((e) => String(e.url_template).includes("/api/quotes"));
    expect(quotes).toBeDefined();
    expect(quotes!.method).toBe("GET");
    // the page=1 query param was learned as a movable hole
    expect(String(quotes!.url_template)).toContain("{page}");
    // response shape inferred: a `quotes` array of like-shaped records (collection)
    const schema = quotes!.response_schema as { properties?: Record<string, { type?: string }> } | undefined;
    expect(schema?.properties?.quotes?.type).toBe("array");
    // the css asset must NOT have become an endpoint
    expect(endpoints.some((e) => String(e.url_template).includes("main.css"))).toBe(false);
  });

  test("determinism: same input => identical endpoint templates", () => {
    const { requests } = parseObscuraCapture(FIXTURE_NDJSON);
    const ctx = { pageUrl: "https://quotes.toscrape.com/scroll", finalUrl: "https://quotes.toscrape.com/scroll" };
    const a = revengLocal(requests, ctx).map((e) => `${e.method} ${e.url_template}`);
    const b = revengLocal(requests, ctx).map((e) => `${e.method} ${e.url_template}`);
    expect(a).toEqual(b);
  });
});
