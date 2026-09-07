import { describe, test, expect } from "bun:test";
import { isRscPayload, parseRscPayload, extractRscDataEndpoints } from "../src/capture/rsc";
import { extractEndpoints } from "../backend/src/services/reverse-engineer/index.js";
import type { RawRequest } from "../src/capture/index.js";

function makeRequest(overrides: Partial<RawRequest>): RawRequest {
  return {
    url: "https://example.com/api/search?q=openai",
    method: "GET",
    request_headers: {},
    response_status: 200,
    response_headers: {},
    response_body: '{"items":[{"id":"1","name":"OpenAI"}]}',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("#175 RSC wire format parser", () => {
  test("detects RSC payload", () => {
    const rsc = '0:["$","div",null,{"children":"Hello"}]\n1:["$","$L2",null,{}]';
    expect(isRscPayload(rsc)).toBe(true);
  });

  test("does not detect regular JSON as RSC", () => {
    expect(isRscPayload('{"key": "value"}')).toBe(false);
  });

  test("does not detect HTML as RSC", () => {
    expect(isRscPayload("<html><body>Hello</body></html>")).toBe(false);
  });

  test("parses RSC payload into chunks", () => {
    const rsc = '0:["$","div",null,{}]\n1:["$","span",null,{"children":"text"}]';
    const chunks = parseRscPayload(rsc);
    expect(chunks.length).toBe(2);
    expect(chunks[0].id).toBe("0");
    expect(Array.isArray(chunks[0].data)).toBe(true);
  });

  test("extracts embedded URLs from RSC payload", () => {
    const rsc = '0:["$","div",null,{"src":"https://api.example.com/data"}]\n1:["$","img",null,{"src":"https://cdn.example.com/img.png"}]';
    const urls = extractRscDataEndpoints(rsc);
    expect(urls).toContain("https://api.example.com/data");
    expect(urls).toContain("https://cdn.example.com/img.png");
  });

  test("handles empty/malformed input", () => {
    expect(isRscPayload("")).toBe(false);
    expect(parseRscPayload("")).toEqual([]);
    expect(isRscPayload("not rsc at all")).toBe(false);
  });
});

describe("#227 RSC wire format pipeline integration", () => {
  test("drops RSC wire format payloads from capture pipeline", () => {
    const rscBody =
      '0:["$","div",null,{"children":"Hello"}]\n1:["$","$L2",null,{}]\n2:["$","span",null,{"children":"World"}]';
    const endpoints = extractEndpoints(
      [
        makeRequest({
          url: "https://example.com/some-page",
          response_body: rscBody,
          response_headers: {},
        }),
      ],
      undefined,
      { pageUrl: "https://example.com/some-page" },
    );
    expect(endpoints.length).toBe(0);
  });

  test("drops RSC wire format even without text/x-component content-type", () => {
    // Next.js sometimes serves RSC payloads with text/plain or no content-type
    const rscBody =
      '0:["$","section",null,{"className":"container"}]\n1:["$","ul",null,{"children":[]}]\n2:["$","li",null,{"children":"item"}]';
    const endpoints = extractEndpoints(
      [
        makeRequest({
          url: "https://example.com/products?_rsc=abc123",
          response_body: rscBody,
          response_headers: { "content-type": "text/plain" },
        }),
      ],
      undefined,
      { pageUrl: "https://example.com/products" },
    );
    expect(endpoints.length).toBe(0);
  });

  test("does not drop regular JSON endpoints when RSC filter is active", () => {
    const endpoints = extractEndpoints(
      [
        makeRequest({
          url: "https://example.com/api/products",
          response_body: JSON.stringify([{ id: "1", name: "Widget", price: 9.99 }]),
          response_headers: { "content-type": "application/json" },
        }),
      ],
      undefined,
      { pageUrl: "https://example.com/products" },
    );
    expect(endpoints.length).toBe(1);
  });
});
