/**
 * Convergence conformance — the single Zig WASM core's `canonicalize` is
 * byte-for-byte identical to the pure-TS `canonicalizeDeclareBodyTs` across the
 * tricky vectors (escapes, control chars, UTF-8, null fields). This is the
 * witness that the Zig-core convergence's first live step (declare
 * canonicalization served by the WASM, TS as fallback) preserves every existing
 * signature: identical bytes -> identical signatures -> nothing re-verifies
 * differently.
 *
 * Run: bun test tests/core-wasm-conformance.test.ts   (from backend/)
 */
import { describe, expect, test } from "bun:test";
import { canonicalizeViaWasm } from "../src/services/core-wasm";
import {
  canonicalizeDeclareBody,
  canonicalizeDeclareBodyTs,
  type CanonicalDeclareBody,
} from "../src/services/declare-signature";

const vectors: { name: string; body: CanonicalDeclareBody }[] = [
  {
    name: "plain ascii",
    body: {
      plan: "resolve the route",
      action: "GET /v1/x",
      parent_id: null,
      agent: null,
      wallet_identity: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      ts: "2026-06-20T00:00:00Z",
    },
  },
  {
    name: "escapes + control chars + utf8 + nulls",
    body: {
      plan: 'a"b\\c\nd\tef',
      action: "emoji 😀 ünïcödé",
      parent_id: "par-1",
      agent: "agt",
      wallet_identity: "00",
      ts: "t",
    },
  },
  {
    name: "all optional fields null",
    body: {
      plan: "",
      action: "",
      parent_id: null,
      agent: null,
      wallet_identity: "",
      ts: "",
    },
  },
  {
    name: "more control chars (\\r \\b \\f \\v) + slash + backslash",
    body: {
      plan: "carriage\rreturn\bbackspace\fformfeedvtab",
      action: "path/with/slashes and back\\slashes",
      parent_id: "p\"q",
      agent: "a\\b",
      wallet_identity: "ff",
      ts: "2026-06-20T12:34:56.789Z",
    },
  },
  {
    name: "wide unicode + surrogate-pair emoji + cjk",
    body: {
      plan: "𝕌𝕟𝕓𝕣𝕠𝕨𝕤𝕖 🚀🔥 中文 日本語 한국어",
      action: "𩸽 𠀋 𡃁",
      parent_id: null,
      agent: "💀",
      wallet_identity: "abc",
      ts: "т",
    },
  },
];

describe("Zig WASM canonicalize === TS canonicalize (byte identical)", () => {
  for (const { name, body } of vectors) {
    test(name, () => {
      const tsOut = canonicalizeDeclareBodyTs(body);
      const wasmOut = canonicalizeViaWasm(body);
      // The WASM must load in bun:test — null here is a real regression.
      expect(wasmOut).not.toBeNull();
      expect(wasmOut).toBe(tsOut);
      // Byte-level assertion, not just string equality.
      const tb = new TextEncoder().encode(tsOut);
      const wb = new TextEncoder().encode(wasmOut as string);
      expect(Array.from(wb)).toEqual(Array.from(tb));
    });
  }

  test("public canonicalizeDeclareBody (wasm-preferred) === TS for every vector", () => {
    for (const { body } of vectors) {
      expect(canonicalizeDeclareBody(body)).toBe(canonicalizeDeclareBodyTs(body));
    }
  });
});
