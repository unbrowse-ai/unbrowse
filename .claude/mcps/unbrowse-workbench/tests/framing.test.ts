// Day-4 Luminaries: falsifiable signal over Day-3 framing.ts.
// Real-runtime: pure function calls on LineReader. No mocks.

import { describe, test, expect } from "bun:test";
import { LineReader, encodeMessage, decodeLine } from "../src/framing.ts";

describe("encodeMessage", () => {
  test("appends a newline so the receiver can split", () => {
    const out = encodeMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out.trim())).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
  });
});

describe("decodeLine", () => {
  test("trims trailing whitespace before parsing", () => {
    const obj = decodeLine('{"id":7}\r\n  ');
    expect(obj).toEqual({ id: 7 });
  });
});

describe("LineReader", () => {
  test("yields complete lines when chunks straddle the newline", () => {
    const got: string[] = [];
    const r = new LineReader((line) => got.push(line));
    r.push('{"id":1');
    r.push(',"method":"a"}\n{"id":2');
    r.push(',"method":"b"}\n');
    expect(got).toEqual(['{"id":1,"method":"a"}', '{"id":2,"method":"b"}']);
  });

  test("preserves the buffer across pushes until newline arrives", () => {
    const got: string[] = [];
    const r = new LineReader((line) => got.push(line));
    r.push("partial");
    expect(got).toEqual([]);
    r.push(" still partial");
    expect(got).toEqual([]);
    r.push("\n");
    expect(got).toEqual(["partial still partial"]);
  });

  test("flush emits trailing un-newlined data so child-exit messages are not lost", () => {
    const got: string[] = [];
    const r = new LineReader((line) => got.push(line));
    r.push("last word without newline");
    r.flush();
    expect(got).toEqual(["last word without newline"]);
  });

  test("ignores empty lines (the bare-newline keepalive)", () => {
    const got: string[] = [];
    const r = new LineReader((line) => got.push(line));
    r.push("\n\n{\"id\":3}\n\n");
    expect(got).toEqual(['{"id":3}']);
  });
});
