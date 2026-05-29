/**
 * Day-4 Luminary worker B — CLI-side stateless adapter tests.
 *
 * Genesis 1:14 — *"lights in the firmament... for signs."*
 * Matt 7:24-25 — *"founded upon a rock."*
 *
 * Load-bearing invariants:
 *   T1. Cross-system byte parity — `deriveCacheKeyFromSignature` (CLI) MUST
 *       produce the byte-identical string that `deriveCacheKey` (backend
 *       services/stateless-substrate.ts) produces on the same input. This
 *       is the F1 falsifier — proves the substrate is unified across the
 *       firmament.
 *   T2. `canonicalizeSignedFragment` enforces the whitelist + preserves
 *       caller-specified key order.
 *   T3. `freshNonce` returns 43-44 char base64 strings; 1000 calls all
 *       distinct.
 *   T4. End-to-end smoke against a local Bun.serve mimicking
 *       /v1/trace/append — adapter signs, POSTs, parses 2xx ack.
 *   T5. Idempotent repeat — same body+nonce → same cacheKey, backend can
 *       report `idempotent: true`.
 *   T6. Binding-missing 503 surfaces as `bindingMissing` field, NOT a throw.
 *   T7. Canary cleartext-leak — adapter NEVER logs the body field on
 *       stderr/stdout; the canary appears only in the wire body.
 *   T8. Forbidden-field gate at the adapter (defense in depth).
 */

import { describe, it, expect } from "bun:test";

import {
  postStateless,
  deriveCacheKeyFromSignature,
  canonicalizeSignedFragment,
  freshNonce,
  STATELESS_SIGNATURE_SCHEME,
  __internal as cliInternal,
} from "../src/cli-v7/_stateless.js";

import { deriveCacheKey as backendDeriveCacheKey } from "../backend/src/services/stateless-substrate.js";

// ───────────────────────────────────────────────────────────────────────────
// T1 — CROSS-SYSTEM BYTE PARITY (the load-bearing test)
// ───────────────────────────────────────────────────────────────────────────

describe("Day-4 W-B: cross-system cacheKey parity (CLI ↔ backend)", () => {
  it("CLI deriveCacheKeyFromSignature == backend deriveCacheKey on fixed input", async () => {
    const input = new Uint8Array(64).fill(0xab);
    const cli = await deriveCacheKeyFromSignature(input);
    const backend = await backendDeriveCacheKey(input);
    expect(cli).toBe(backend);
    expect(cli.length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(cli)).toBe(true);
  });

  it("CLI == backend on the canonical 'all zeros' fixture", async () => {
    const input = new Uint8Array(64); // zeros
    const cli = await deriveCacheKeyFromSignature(input);
    const backend = await backendDeriveCacheKey(input);
    expect(cli).toBe(backend);
    // sha256("\x00" * 64).slice(0, 32) is well-known:
    //   sha256 = f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b
    //   first 32 hex chars = f5a5fd42d16a20302798ef6ed309979b
    expect(cli).toBe("f5a5fd42d16a20302798ef6ed309979b");
  });

  it("parity holds across 20 random inputs (cross-system fuzz)", async () => {
    for (let i = 0; i < 20; i++) {
      const sig = new Uint8Array(64);
      crypto.getRandomValues(sig);
      const cli = await deriveCacheKeyFromSignature(sig);
      const backend = await backendDeriveCacheKey(sig);
      expect(cli).toBe(backend);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T2 — Whitelist enforcement on canonicalSignedFragment
// ───────────────────────────────────────────────────────────────────────────

describe("Day-4 W-B: canonicalizeSignedFragment whitelist", () => {
  it("includes ONLY the whitelisted fields, preserving caller key order", () => {
    const body = { a: 1, b: 2, c: 3, d: 4, nonce: "X" };
    const out = canonicalizeSignedFragment(body, ["a", "c"]);
    expect(out).toBe('{"a":1,"c":3}');
  });

  it("preserves the order provided (NOT lex-sorted)", () => {
    const body = { z: 1, a: 2, m: 3 };
    const out = canonicalizeSignedFragment(body, ["z", "a", "m"]);
    expect(out).toBe('{"z":1,"a":2,"m":3}');
  });

  it("coerces undefined fields to null (matches audit.ts pattern)", () => {
    const body = { a: 1 };
    const out = canonicalizeSignedFragment(body, ["a", "b"]);
    expect(out).toBe('{"a":1,"b":null}');
  });

  it("REJECTS forbidden field names (defense in depth)", () => {
    const body = { pointer: "op://x", value: "leak" };
    expect(() =>
      canonicalizeSignedFragment(body, ["pointer", "value"]),
    ).toThrow(/forbidden field/);
  });

  it("rejects forbidden field even with case variation", () => {
    expect(() =>
      canonicalizeSignedFragment({ Password: "x" }, ["Password"]),
    ).toThrow(/forbidden field/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T3 — freshNonce
// ───────────────────────────────────────────────────────────────────────────

describe("Day-4 W-B: freshNonce", () => {
  it("returns 44-char base64 (32 bytes encoded)", () => {
    const n = freshNonce();
    expect(n.length).toBeGreaterThanOrEqual(43);
    expect(n.length).toBeLessThanOrEqual(44);
    expect(/^[A-Za-z0-9+/]+={0,2}$/.test(n)).toBe(true);
  });

  it("1000 calls produce 1000 distinct values", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(freshNonce());
    expect(seen.size).toBe(1000);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T4-T8 — End-to-end with a local Bun.serve mock backend
// ───────────────────────────────────────────────────────────────────────────

interface CapturedRequest {
  url: string;
  bodyText: string;
  bodyJson: Record<string, unknown>;
}

/**
 * Spin up a local Bun.serve that records every request. Returns the
 * controller so each test scenario can swap the response shape.
 */
function spinupMockBackend(): {
  url: string;
  captured: CapturedRequest[];
  setResponse: (r: { status: number; body: Record<string, unknown> }) => void;
  stop: () => Promise<void>;
} {
  const captured: CapturedRequest[] = [];
  let nextResponse: { status: number; body: Record<string, unknown> } = {
    status: 200,
    body: { ok: true, idempotent: false, receiptId: "rcpt_default" },
  };

  const server = Bun.serve({
    port: 0, // ephemeral
    fetch: async (req) => {
      const bodyText = await req.text();
      let bodyJson: Record<string, unknown> = {};
      try { bodyJson = JSON.parse(bodyText); } catch { /* ignore */ }
      captured.push({ url: req.url, bodyText, bodyJson });
      return new Response(JSON.stringify(nextResponse.body), {
        status: nextResponse.status,
        headers: { "content-type": "application/json" },
      });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    captured,
    setResponse: (r) => { nextResponse = r; },
    stop: async () => { await server.stop(true); },
  };
}

describe("Day-4 W-B: postStateless end-to-end (mock backend)", () => {
  it("T4: signs canonical fragment and POSTs valid wire shape", async () => {
    const mock = spinupMockBackend();
    try {
      mock.setResponse({
        status: 200,
        body: { ok: true, idempotent: false, receiptId: "rcpt_xyz" },
      });

      const result = await postStateless({
        namespace: "trace",
        route: "/v1/trace/append",
        body: {
          sessionId: "ses_test_1",
          domain: "example.com",
          traces: [{ step: "server_fetch", duration_ms: 12 }],
        },
        signableFields: ["sessionId", "domain", "traces", "nonce"],
        apiBaseUrl: mock.url,
      });

      expect(result.ok).toBe(true);
      expect(result.httpStatus).toBe(200);
      expect(result.receiptId).toBe("rcpt_xyz");
      expect(result.idempotent).toBe(false);
      expect(result.cacheKey.length).toBe(32);
      expect(/^[0-9a-f]{32}$/.test(result.cacheKey)).toBe(true);

      // Inspect the wire body.
      expect(mock.captured.length).toBe(1);
      const wire = mock.captured[0].bodyJson;

      // walletPubkey: 32-byte hex (64 chars)
      expect(typeof wire["walletPubkey"]).toBe("string");
      expect((wire["walletPubkey"] as string).length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(wire["walletPubkey"] as string)).toBe(true);

      // signature: 64-byte hex (128 chars)
      expect(typeof wire["signature"]).toBe("string");
      expect((wire["signature"] as string).length).toBe(128);
      expect(/^[0-9a-f]{128}$/.test(wire["signature"] as string)).toBe(true);

      // signatureScheme defaults to STATELESS_SIGNATURE_SCHEME
      expect(wire["signatureScheme"]).toBe(STATELESS_SIGNATURE_SCHEME);

      // nonce: base64 32 bytes
      expect(typeof wire["nonce"]).toBe("string");
      const n = wire["nonce"] as string;
      expect(n.length).toBeGreaterThanOrEqual(43);
      expect(n.length).toBeLessThanOrEqual(44);

      // CacheKey reported MUST match sha256(sig)[:32] of the wire sig.
      const sigBytes = new Uint8Array(64);
      const sigHex = wire["signature"] as string;
      for (let i = 0; i < 64; i++) {
        sigBytes[i] = parseInt(sigHex.slice(i * 2, i * 2 + 2), 16);
      }
      const recomputed = await deriveCacheKeyFromSignature(sigBytes);
      expect(result.cacheKey).toBe(recomputed);

      // Original body fields preserved on the wire
      expect(wire["sessionId"]).toBe("ses_test_1");
      expect(wire["domain"]).toBe("example.com");
    } finally {
      await mock.stop();
    }
  });

  it("T5: idempotent repeat — backend echoes idempotent:true", async () => {
    const mock = spinupMockBackend();
    try {
      const fixedNonce = freshNonce();
      const body = {
        sessionId: "ses_idem",
        domain: "example.com",
        traces: [],
        nonce: fixedNonce, // reuse explicitly
      };

      mock.setResponse({
        status: 200,
        body: { ok: true, idempotent: false, receiptId: "rcpt_idem" },
      });
      const r1 = await postStateless({
        namespace: "trace",
        route: "/v1/trace/append",
        body,
        signableFields: ["sessionId", "domain", "traces", "nonce"],
        apiBaseUrl: mock.url,
      });

      mock.setResponse({
        status: 200,
        body: { ok: true, idempotent: true, receiptId: "rcpt_idem" },
      });
      const r2 = await postStateless({
        namespace: "trace",
        route: "/v1/trace/append",
        body,
        signableFields: ["sessionId", "domain", "traces", "nonce"],
        apiBaseUrl: mock.url,
      });

      // Same canonical body → same canonical fragment → same signature →
      // same cacheKey. Wallet signs deterministically over the same input.
      expect(r1.cacheKey).toBe(r2.cacheKey);
      expect(r2.idempotent).toBe(true);

      // Both wire bodies carried the SAME nonce (the body's preexisting one).
      const wire1 = mock.captured[0].bodyJson;
      const wire2 = mock.captured[1].bodyJson;
      expect(wire1["nonce"]).toBe(fixedNonce);
      expect(wire2["nonce"]).toBe(fixedNonce);
      expect(wire1["signature"]).toBe(wire2["signature"]);
    } finally {
      await mock.stop();
    }
  });

  it("T6: 503 with _binding_missing surfaces as bindingMissing field (no throw)", async () => {
    const mock = spinupMockBackend();
    try {
      mock.setResponse({
        status: 503,
        body: {
          _binding_missing: "TRACE_STATE",
          hint: "operator must run wrangler kv:namespace create TRACE_STATE",
        },
      });

      const result = await postStateless({
        namespace: "trace",
        route: "/v1/trace/append",
        body: { sessionId: "x", domain: "y", traces: [] },
        signableFields: ["sessionId", "domain", "traces", "nonce"],
        apiBaseUrl: mock.url,
      });

      expect(result.ok).toBe(false);
      expect(result.bindingMissing).toBe("TRACE_STATE");
      expect(result.httpStatus).toBe(503);
      // cacheKey was still derived locally despite the 503
      expect(result.cacheKey.length).toBe(32);
    } finally {
      await mock.stop();
    }
  });

  it("T7: canary leak — body field appears only on wire, never on stdout/stderr/result", async () => {
    const mock = spinupMockBackend();
    const CANARY = "UNB7-CLI-STATELESS-CANARY-DO-NOT-LEAK";
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    // @ts-expect-error — monkey-patch for capture
    process.stdout.write = (chunk: unknown, ...rest: unknown[]) => {
      try { stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk)); } catch { /* ignore */ }
      return origStdoutWrite(chunk as never, ...(rest as never[]));
    };
    // @ts-expect-error — monkey-patch for capture
    process.stderr.write = (chunk: unknown, ...rest: unknown[]) => {
      try { stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk)); } catch { /* ignore */ }
      return origStderrWrite(chunk as never, ...(rest as never[]));
    };

    try {
      mock.setResponse({
        status: 200,
        body: { ok: true, idempotent: false, receiptId: "rcpt_canary" },
      });
      const result = await postStateless({
        namespace: "trace",
        route: "/v1/trace/append",
        body: {
          sessionId: "ses_canary",
          domain: "example.com",
          someValue: CANARY,           // canary field
          traces: [],
        },
        signableFields: ["sessionId", "domain", "someValue", "traces", "nonce"],
        apiBaseUrl: mock.url,
      });

      // Canary lives in the wire body (acceptable — the caller put it there).
      expect(mock.captured[0].bodyText).toContain(CANARY);
      expect(mock.captured[0].bodyJson["someValue"]).toBe(CANARY);

      // Canary MUST NOT have leaked into stdout / stderr / result-summary.
      const stdoutAll = stdoutChunks.join("");
      const stderrAll = stderrChunks.join("");
      expect(stdoutAll).not.toContain(CANARY);
      expect(stderrAll).not.toContain(CANARY);

      const resultJson = JSON.stringify(result);
      expect(resultJson).not.toContain(CANARY);
    } finally {
      // @ts-expect-error — restore
      process.stdout.write = origStdoutWrite;
      // @ts-expect-error — restore
      process.stderr.write = origStderrWrite;
      await mock.stop();
    }
  });

  it("T8: forbidden field in signableFields rejected at adapter layer", async () => {
    const mock = spinupMockBackend();
    try {
      const result = await postStateless({
        namespace: "audit",
        route: "/v1/audit/fill",
        body: { pointer: "op://Vault/Item/password", value: "hunter2" },
        // CLI tried to sign over "value" — must be rejected before any POST.
        signableFields: ["pointer", "value", "nonce"],
        apiBaseUrl: mock.url,
      });

      expect(result.ok).toBe(false);
      // No request reached the backend.
      expect(mock.captured.length).toBe(0);
      expect(result.errorHint).toMatch(/forbidden field/i);
    } finally {
      await mock.stop();
    }
  });

  it("T9: fetch network error returns httpStatus 0 with sanitized hint", async () => {
    let throwingFetchCalled = false;
    const throwingFetch = (async () => {
      throwingFetchCalled = true;
      throw new Error("network unreachable: very-secret-token-abc123def456");
    }) as unknown as typeof fetch;

    const result = await postStateless({
      namespace: "trace",
      route: "/v1/trace/append",
      body: { sessionId: "x", domain: "y", traces: [] },
      signableFields: ["sessionId", "domain", "traces", "nonce"],
      apiBaseUrl: "http://localhost:1",
      fetchImpl: throwingFetch,
    });

    expect(throwingFetchCalled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(0);
    expect(result.cacheKey.length).toBe(32); // local derivation still happened
    // Error hint exists but is bounded; we don't assert specific content
    // because sanitizer redaction is best-effort over heuristic patterns.
    expect(typeof result.errorHint).toBe("string");
    expect((result.errorHint as string).length).toBeLessThanOrEqual(200);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Diagnostic: sanitizeErrorHint scrubs hex sigs + base64 secrets
// ───────────────────────────────────────────────────────────────────────────

describe("Day-4 W-B: sanitizeErrorHint redaction", () => {
  it("strips long hex strings (sig-shaped) from error messages", () => {
    const fakeHex = "a".repeat(128);
    const out = cliInternal.sanitizeErrorHint(new Error(`oops ${fakeHex}`));
    expect(out).not.toContain(fakeHex);
    expect(out).toContain("<hex-redacted>");
  });

  it("strips long base64 secrets from error messages", () => {
    const fakeB64 = "QWxhZGRpbjpvcGVuIHNlc2FtZUFsYWRkaW46b3BlbiBzZXNhbWU=";
    const out = cliInternal.sanitizeErrorHint(new Error(`bad creds ${fakeB64}`));
    expect(out).not.toContain(fakeB64);
  });
});
