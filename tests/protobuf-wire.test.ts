import { afterEach, describe, expect, it } from "bun:test";
import { extractEndpoints } from "../backend/src/services/reverse-engineer/index.js";
import { executeSkill } from "../src/execution/index.js";
import { decodeProtobufBody, isProtobufLikeEndpoint } from "../src/protobuf/wire.js";
import type { RawRequest } from "../src/capture/index.js";
import type { SkillManifest } from "../src/types/index.js";

const servers: Array<{ stop: () => Promise<void> | void }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.stop();
  }
});

function bytes(...parts: Array<number[] | Uint8Array>): Uint8Array {
  return new Uint8Array(parts.flatMap((part) => Array.from(part)));
}

function strField(fieldNo: number, value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  return bytes([fieldNo << 3 | 2], varint(encoded.length), encoded);
}

function intField(fieldNo: number, value: number): Uint8Array {
  return bytes([fieldNo << 3], varint(value));
}

function msgField(fieldNo: number, value: Uint8Array): Uint8Array {
  return bytes([fieldNo << 3 | 2], varint(value.length), value);
}

function varint(value: number): number[] {
  const out: number[] = [];
  let next = value >>> 0;
  while (next >= 0x80) {
    out.push((next & 0x7f) | 0x80);
    next >>>= 7;
  }
  out.push(next);
  return out;
}

function listingPayload(): Uint8Array {
  const listing = bytes(
    strField(1, "Beige Cream V-Neck"),
    intField(2, 5),
    strField(3, "midheaven"),
  );
  return bytes(
    msgField(1, listing),
    strField(2, "beige sweater Serangoon"),
  );
}

function makeRequest(body: string): RawRequest {
  return {
    url: "https://www.carousell.sg/ds/field-data-proto/cf/4.0/search/",
    method: "POST",
    request_headers: { accept: "application/x-protobuf" },
    request_body: JSON.stringify({ query: "beige sweater", mrtLineStations: "NE12_CC13" }),
    response_status: 200,
    response_headers: { "content-type": "application/x-protobuf" },
    response_body: body,
    timestamp: new Date().toISOString(),
  };
}

describe("protobuf wire decoding", () => {
  it("decodes generic protobuf into JSON-safe records", () => {
    const body = `base64:${Buffer.from(listingPayload()).toString("base64")}`;
    const decoded = decodeProtobufBody(body, "application/x-protobuf");

    expect(decoded?.protobuf_decoded).toBe(true);
    expect(decoded?.records[0]?.title_like).toBe("Beige Cream V-Neck");
    expect(decoded?.records[0]?.price_like).toBe(5);
  });

  it("admits protobuf search endpoints instead of falling back to JSON-LD metadata", () => {
    const body = `base64:${Buffer.from(listingPayload()).toString("base64")}`;
    const endpoints = extractEndpoints([makeRequest(body)], undefined, {
      pageUrl: "https://www.carousell.sg/search/beige%20sweater",
      intent: "list beige sweater listings near Serangoon",
    });

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.url_template).toContain("/ds/field-data-proto/cf/4.0/search/");
    expect(endpoints[0]?.response_schema?.properties?.records).toBeDefined();
  });

  it("decodes protobuf responses during direct execution", async () => {
    const payload = listingPayload();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(payload, { headers: { "content-type": "application/x-protobuf" } });
      },
    });
    servers.push(server);

    const now = new Date().toISOString();
    const skill: SkillManifest = {
      skill_id: "skill-proto",
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      execution_type: "http",
      created_at: now,
      updated_at: now,
      name: "protobuf search",
      intent_signature: "list beige sweater listings",
      domain: "127.0.0.1",
      description: "protobuf search",
      owner_type: "agent",
      endpoints: [{
        endpoint_id: "search",
        method: "GET",
        url_template: `http://127.0.0.1:${server.port}/ds/field-data-proto/cf/4.0/search/`,
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 1,
        response_schema: { type: "object", properties: { records: { type: "array" } } },
      }],
    };

    const out = await executeSkill(skill, {}, undefined, { endpoint_id: "search" });
    const result = out.result as Record<string, any>;
    expect(result.protobuf_decoded).toBe(true);
    expect(result.records[0].title_like).toBe("Beige Cream V-Neck");
  });
});

// The Carousell listing-API blind spot (learned-problem:
// product-issue-carousell-search-api-missed): the real search call is
// `/ds/filter-search-proto/` — `proto` is HYPHEN-prefixed, not slash-prefixed,
// so the old `/\/proto/` recognizer missed it and only the slash-bounded
// `/field-data-proto/` rec-widget got captured. The fix recognises `proto`
// after a hyphen too. This is the client+backend hole-recognition widening.
function makeFilterSearchProtoRequest(body: string): RawRequest {
  return {
    url: "https://www.carousell.sg/ds/filter-search-proto/4.0/search/",
    method: "POST",
    request_headers: { accept: "application/x-protobuf" },
    request_body: JSON.stringify({ query: "homemade food" }),
    response_status: 200,
    response_headers: { "content-type": "application/x-protobuf" },
    response_body: body,
    timestamp: new Date().toISOString(),
  };
}

describe("isProtobufLikeEndpoint — hyphen-bounded proto tokens", () => {
  it("recognises slash- AND hyphen-prefixed proto path tokens", () => {
    expect(isProtobufLikeEndpoint("https://x/ds/field-data-proto/cf/4.0/search/")).toBe(true);
    expect(isProtobufLikeEndpoint("https://www.carousell.sg/ds/filter-search-proto/4.0/search/")).toBe(true);
    expect(isProtobufLikeEndpoint("https://x/api/protobuf")).toBe(true);
    expect(isProtobufLikeEndpoint("https://x/v1/list-proto-feed")).toBe(true);
  });
  it("does NOT false-match protocol / prototype / unrelated words", () => {
    expect(isProtobufLikeEndpoint("https://x/api/protocol/handshake")).toBe(false);
    expect(isProtobufLikeEndpoint("https://x/js/prototype.min.js")).toBe(false);
    expect(isProtobufLikeEndpoint("https://x/photos/cryptobeach")).toBe(false);
  });
  it("still honours an explicit protobuf content-type", () => {
    expect(isProtobufLikeEndpoint("https://x/anything", "application/x-protobuf")).toBe(true);
  });
});

describe("extractEndpoints admits the hyphen-prefixed proto search API", () => {
  it("captures /ds/filter-search-proto/ as the listing endpoint (was missed)", () => {
    const body = `base64:${Buffer.from(listingPayload()).toString("base64")}`;
    const endpoints = extractEndpoints([makeFilterSearchProtoRequest(body)], undefined, {
      pageUrl: "https://www.carousell.sg/food/q/",
      intent: "find good food listings with titles and prices",
    });
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.url_template).toContain("/ds/filter-search-proto/");
    expect(endpoints[0]?.response_schema?.properties?.records).toBeDefined();
  });

  // The generalization (CLAUDE.md "never a hard filter"): admission is STRUCTURAL —
  // a body that decodes to protobuf records is admitted even when the URL carries
  // NO proto/api token and NO declared protobuf content-type. Zero allowlist.
  it("admits a proto-decoding body at a URL with no proto/api token (structural)", () => {
    const body = `base64:${Buffer.from(listingPayload()).toString("base64")}`;
    const req: RawRequest = {
      url: "https://www.carousell.sg/ds/cf/4.0/results/",
      method: "POST",
      request_headers: {},
      request_body: JSON.stringify({ query: "homemade food" }),
      response_status: 200,
      response_headers: { "content-type": "application/octet-stream" }, // NOT a proto content-type
      response_body: body,
      timestamp: new Date().toISOString(),
    };
    const endpoints = extractEndpoints([req], undefined, {
      pageUrl: "https://www.carousell.sg/food/q/",
      intent: "find good food listings with titles and prices",
    });
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.url_template).toContain("/ds/cf/4.0/results/");
    expect(endpoints[0]?.response_schema?.properties?.records).toBeDefined();
  });
});
