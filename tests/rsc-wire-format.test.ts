import { describe, test, expect } from "bun:test";
import { isRscPayload, parseRscPayload, extractRscDataEndpoints } from "../src/capture/rsc";

describe("#175 RSC wire format", () => {
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
