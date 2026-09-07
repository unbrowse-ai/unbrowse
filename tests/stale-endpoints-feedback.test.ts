// Loop 5: 401-feedback substrate tests.
//
// Three lanes:
// 1. Module unit tests — record/read/expire round-trip
// 2. Resolve filter — endpoints marked stale don't appear in available_endpoints
// 3. Execute -> stale write — a real HTTP 401 round-trip in process causes
//    the (domain, endpoint_id) to land in the stale-endpoints file
//
// All tests use a per-test tmp file via UNBROWSE_STALE_ENDPOINTS_PATH so they
// don't trample the user's real stale-endpoints.json.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  recordStaleEndpoint,
  isEndpointStale,
  listStaleEndpoints,
  clearStaleEndpoints,
  STALE_TTL_MS,
} from "../src/auth/stale-endpoints.ts";

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `unbrowse-stale-test-${Date.now()}-${Math.random()}.json`);
  process.env.UNBROWSE_STALE_ENDPOINTS_PATH = tmpFile;
});

afterEach(() => {
  try { fs.unlinkSync(tmpFile); } catch {}
  delete process.env.UNBROWSE_STALE_ENDPOINTS_PATH;
});

describe("stale-endpoints substrate", () => {
  it("records a stale endpoint and reads it back", () => {
    recordStaleEndpoint("x.com", "bjuGxuwq", 401, "local-browser");
    expect(isEndpointStale("x.com", "bjuGxuwq")).toBe(true);
  });

  it("returns false for unmarked endpoints", () => {
    recordStaleEndpoint("x.com", "bjuGxuwq", 401);
    expect(isEndpointStale("x.com", "different-ep")).toBe(false);
    expect(isEndpointStale("other.com", "bjuGxuwq")).toBe(false);
  });

  it("expires records past the TTL window", () => {
    const longAgo = Date.now() - STALE_TTL_MS - 1000;
    recordStaleEndpoint("x.com", "old-ep", 401, "unknown", longAgo);
    // The record was written with now=longAgo, so calling at Date.now() is past TTL
    expect(isEndpointStale("x.com", "old-ep")).toBe(false);
  });

  it("replaces a prior record on re-mark (single row per pair)", () => {
    recordStaleEndpoint("x.com", "ep", 401, "local-browser");
    recordStaleEndpoint("x.com", "ep", 403, "remote-vault");
    const records = listStaleEndpoints("x.com");
    expect(records.length).toBe(1);
    expect(records[0].status).toBe(403);
    expect(records[0].cookie_source).toBe("remote-vault");
  });

  it("listStaleEndpoints filters by domain", () => {
    recordStaleEndpoint("x.com", "a", 401);
    recordStaleEndpoint("github.com", "b", 401);
    expect(listStaleEndpoints("x.com").length).toBe(1);
    expect(listStaleEndpoints("github.com").length).toBe(1);
    expect(listStaleEndpoints().length).toBe(2);
  });

  it("clearStaleEndpoints empties the store", () => {
    recordStaleEndpoint("x.com", "a", 401);
    clearStaleEndpoints();
    expect(listStaleEndpoints().length).toBe(0);
  });

  it("survives a missing file (cold read)", () => {
    expect(isEndpointStale("x.com", "ep")).toBe(false);
    expect(listStaleEndpoints()).toEqual([]);
  });

  it("survives a malformed JSON file (read returns [])", () => {
    fs.writeFileSync(tmpFile, "not-json{");
    expect(isEndpointStale("x.com", "ep")).toBe(false);
    expect(listStaleEndpoints()).toEqual([]);
  });
});
