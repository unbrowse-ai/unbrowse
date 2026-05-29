/**
 * Day-6 Dominion worker 1 (2026-05-28) — v7 stateless breath-input tests
 * for the 6 non-value-bearing breath handlers (click, press, scroll,
 * submit, type-literal, select-literal).
 *
 * Gen 1:26 — *"let them have dominion."*
 * John 15:2 — *"every branch that beareth fruit, he purgeth it."*
 *
 * Falsifier matrix (8 tests):
 *   T1..T6 — one per actType: emitBreathActStateless POSTs the right
 *            shape against a Bun.serve mock and the wire body validates
 *            through the REAL backend `validateAuditBody` gate.
 *   T7 (adversarial canary) — a UNB7-BREATH-CANARY-DO-NOT-LEAK string
 *            in the selector text is sha256-hashed BEFORE crossing the
 *            firmament; the canary substring appears nowhere in the
 *            wire body (selector, selectorHash, pointer, anywhere).
 *   T8 (binding-missing graceful degrade, A5 widened acceptance) —
 *            backend returns 503 + `_binding_missing: "AUDIT_LOG"`;
 *            helper returns `bindingMissing: true`, the caller (which
 *            is the test directly here, simulating the handler) is
 *            NOT thrown into, and the result carries enough info for
 *            the handler to continue without blocking the user act.
 *
 * No mocks of the audit substrate logic — only the network endpoint is
 * a Bun.serve socket. The signature MUST verify against the REAL backend
 * validateAuditBody gate (T1..T6 prove this).
 *
 * Heb 4:13 — *"all things are naked and opened unto the eyes of him."*
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";

import {
  emitBreathActStateless,
  deriveBreathActContextHash,
  type BreathActType,
} from "../src/cli-v7/_breath-audit.js";
import { validateAuditBody } from "../backend/src/services/audit.js";

const CANARY = "UNB7-BREATH-CANARY-DO-NOT-LEAK";

// ───────────────────────────────────────────────────────────────────────────
// Mock backend — captures the POST body, returns configurable response
// ───────────────────────────────────────────────────────────────────────────

interface CapturedReq {
  pathname: string;
  bodyText: string;
  bodyJson: Record<string, unknown>;
}

interface MockBackend {
  url: string;
  captured: CapturedReq[];
  setResponse: (r: { status: number; body: Record<string, unknown> }) => void;
  stop: () => Promise<void>;
}

function spinupBackend(): MockBackend {
  const captured: CapturedReq[] = [];
  let nextResp: { status: number; body: Record<string, unknown> } = {
    status: 200,
    body: {
      ok: true,
      receiptId: "a".repeat(64),
      verify_ok: true,
      idempotent: false,
      warnings: [],
    },
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const bodyText = await req.text();
      let bodyJson: Record<string, unknown> = {};
      try {
        bodyJson = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        /* */
      }
      captured.push({ pathname: u.pathname, bodyText, bodyJson });
      return new Response(JSON.stringify(nextResp.body), {
        status: nextResp.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    captured,
    setResponse: (r) => {
      nextResp = r;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-handler tests (T1..T6)
// ───────────────────────────────────────────────────────────────────────────

const PER_HANDLER_CASES: ReadonlyArray<{
  name: string;
  actType: BreathActType;
  selector: string | null;
}> = [
  { name: "click",          actType: "click",          selector: "#submit-btn" },
  { name: "press",          actType: "press",          selector: null },
  { name: "scroll",         actType: "scroll",         selector: "#main-feed" },
  { name: "submit",         actType: "submit",         selector: "form#login" },
  { name: "type-literal",   actType: "type-literal",   selector: null },
  { name: "select-literal", actType: "select-literal", selector: "select.country" },
];

describe("Day-6 W1: stateless breath-act per-handler (T1..T6)", () => {
  let backend: MockBackend;
  let origStateless: string | undefined;
  let origApi: string | undefined;

  beforeEach(() => {
    backend = spinupBackend();
    origStateless = process.env.UNBROWSE_STATELESS;
    origApi = process.env.UNBROWSE_API_URL;
    process.env.UNBROWSE_STATELESS = "1";
  });
  afterEach(async () => {
    await backend.stop();
    if (origStateless === undefined) delete process.env.UNBROWSE_STATELESS;
    else process.env.UNBROWSE_STATELESS = origStateless;
    if (origApi === undefined) delete process.env.UNBROWSE_API_URL;
    else process.env.UNBROWSE_API_URL = origApi;
  });

  for (const tc of PER_HANDLER_CASES) {
    it(`${tc.name}: POSTs to /v1/audit/breath-act, wire body passes validateAuditBody`, async () => {
      const result = await emitBreathActStateless({
        sessionId: `ses_${tc.actType}`,
        actType: tc.actType,
        selector: tc.selector,
        currentUrl: "https://example.com/page",
        apiBaseUrl: backend.url,
        nowMs: 1700000000000,
      });

      // Route + ok shape.
      expect(result.skipped).toBe(false);
      expect(result.bindingMissing).toBe(false);
      expect(result.ok).toBe(true);
      expect(result.httpStatus).toBe(200);
      expect(result.cacheKey.length).toBe(32);
      expect(/^[0-9a-f]{32}$/.test(result.cacheKey)).toBe(true);
      expect(result.contextHash.length).toBe(64);

      // One POST, right path.
      expect(backend.captured.length).toBe(1);
      expect(backend.captured[0].pathname).toBe("/v1/audit/breath-act");

      // Wire body shape — REAL validateAuditBody gate (not a mock).
      const wire = backend.captured[0].bodyJson;
      const validation = validateAuditBody(wire);
      if (validation !== null) {
        // Make the failure visible — what field, what reason?
        throw new Error(
          `validateAuditBody rejected wire body: field='${validation.field}' reason='${validation.reason}'`,
        );
      }

      // Variant + actType discriminators.
      expect(wire.variant).toBe("breath-act");
      expect(wire.actType).toBe(tc.actType);
      expect(wire.pointer).toBe(`unbrowse-act://${tc.actType}`);

      // Selector handling: hashed when present, absent when null.
      if (tc.selector) {
        const expectedSelectorHash = createHash("sha256")
          .update(tc.selector, "utf8")
          .digest("hex");
        expect(wire.selectorHash).toBe(expectedSelectorHash);
      } else {
        expect(wire.selectorHash).toBeUndefined();
      }

      // urlHash present + correct shape.
      const expectedUrlHash = createHash("sha256")
        .update("https://example.com/page", "utf8")
        .digest("hex");
      expect(wire.urlHash).toBe(expectedUrlHash);

      // contextHash derivation deterministic + correct.
      const expectedCtxHash = deriveBreathActContextHash(
        `ses_${tc.actType}`,
        tc.actType,
        tc.selector,
        "https://example.com/page",
        1700000000000,
      );
      expect(wire.contextHash).toBe(expectedCtxHash);

      // Commitment: deterministic synthetic, 32-byte hex.
      expect(typeof wire.commitment).toBe("string");
      expect((wire.commitment as string).length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(wire.commitment as string)).toBe(true);

      // Signed envelope present (walletPubkey + signature + scheme + nonce).
      expect(typeof wire.walletPubkey).toBe("string");
      expect((wire.walletPubkey as string).length).toBe(64);
      expect(typeof wire.signature).toBe("string");
      expect((wire.signature as string).length).toBe(128);
      expect(wire.signatureScheme).toBe("ed25519-v7.0");
      expect(typeof wire.nonce).toBe("string");
      expect((wire.nonce as string).length).toBeGreaterThanOrEqual(43);
      expect((wire.nonce as string).length).toBeLessThanOrEqual(44);

      // FORBIDDEN — never raw selector / value / cleartext / cookie on wire.
      expect(wire.selector).toBeUndefined();
      expect(wire.value).toBeUndefined();
      expect(wire.cleartext).toBeUndefined();
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// T7 — adversarial canary in selector text
// ───────────────────────────────────────────────────────────────────────────

describe("Day-6 W1: canary in selector hashes, never appears raw on wire (T7)", () => {
  let backend: MockBackend;
  let origStateless: string | undefined;
  let origApi: string | undefined;

  beforeEach(() => {
    backend = spinupBackend();
    origStateless = process.env.UNBROWSE_STATELESS;
    origApi = process.env.UNBROWSE_API_URL;
    process.env.UNBROWSE_STATELESS = "1";
  });
  afterEach(async () => {
    await backend.stop();
    if (origStateless === undefined) delete process.env.UNBROWSE_STATELESS;
    else process.env.UNBROWSE_STATELESS = origStateless;
    if (origApi === undefined) delete process.env.UNBROWSE_API_URL;
    else process.env.UNBROWSE_API_URL = origApi;
  });

  it(`canary "${CANARY}" in selector is sha256-hashed; raw substring absent everywhere`, async () => {
    const canarySelector = `#row[data-name="${CANARY}"]`;
    const result = await emitBreathActStateless({
      sessionId: "ses_canary",
      actType: "click",
      selector: canarySelector,
      currentUrl: `https://example.com/path?marker=${CANARY}`,
      apiBaseUrl: backend.url,
    });

    expect(result.ok).toBe(true);
    expect(backend.captured.length).toBe(1);
    const cap = backend.captured[0];

    // CANARY MUST NOT appear in the raw POST body text — not in the
    // JSON, not in any field's stringification, not as a substring.
    expect(cap.bodyText.includes(CANARY)).toBe(false);

    // The selectorHash IS present (canary-bearing selector was hashed).
    const wire = cap.bodyJson;
    const expectedHash = createHash("sha256").update(canarySelector, "utf8").digest("hex");
    expect(wire.selectorHash).toBe(expectedHash);
    // Hash MUST NOT contain the canary substring.
    expect((wire.selectorHash as string).includes(CANARY)).toBe(false);

    // The urlHash IS present (canary-bearing URL was hashed).
    const expectedUrlHash = createHash("sha256")
      .update(`https://example.com/path?marker=${CANARY}`, "utf8")
      .digest("hex");
    expect(wire.urlHash).toBe(expectedUrlHash);
    expect((wire.urlHash as string).includes(CANARY)).toBe(false);

    // Result fields never carry the canary either.
    expect(JSON.stringify(result).includes(CANARY)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T8 — binding-missing graceful degrade (A5 widened acceptance)
// ───────────────────────────────────────────────────────────────────────────

describe("Day-6 W1: binding-missing surfaces, never throws (T8)", () => {
  let backend: MockBackend;
  let origStateless: string | undefined;
  let origApi: string | undefined;
  let origStderrWrite: typeof process.stderr.write;
  let stderrCaptured: string;

  beforeEach(() => {
    backend = spinupBackend();
    origStateless = process.env.UNBROWSE_STATELESS;
    origApi = process.env.UNBROWSE_API_URL;
    process.env.UNBROWSE_STATELESS = "1";
    // Capture stderr.write so we can assert the warning fires without
    // polluting test output. process.stderr.write is the spec-required
    // surface (see _breath-audit.ts).
    stderrCaptured = "";
    origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrCaptured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;
  });
  afterEach(async () => {
    process.stderr.write = origStderrWrite;
    await backend.stop();
    if (origStateless === undefined) delete process.env.UNBROWSE_STATELESS;
    else process.env.UNBROWSE_STATELESS = origStateless;
    if (origApi === undefined) delete process.env.UNBROWSE_API_URL;
    else process.env.UNBROWSE_API_URL = origApi;
  });

  it("503 + _binding_missing yields bindingMissing:true, warns stderr, never throws", async () => {
    backend.setResponse({
      status: 503,
      body: {
        error: "audit_log_binding_missing",
        _binding_missing: "AUDIT_LOG",
        reason: "operator must run `bunx wrangler kv:namespace create AUDIT_LOG`",
      },
    });

    let threw = false;
    let result;
    try {
      result = await emitBreathActStateless({
        sessionId: "ses_binding_missing",
        actType: "click",
        selector: "#button",
        currentUrl: "https://example.com",
        apiBaseUrl: backend.url,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(result!.bindingMissing).toBe(true);
    expect(result!.ok).toBe(false);
    expect(result!.skipped).toBe(false);
    expect(result!.httpStatus).toBe(503);

    // Warning landed on stderr (A5: surface the missing binding so the
    // operator can run the kv:namespace create commands; never silent).
    expect(stderrCaptured.includes("audit binding missing")).toBe(true);
    expect(stderrCaptured.includes("breath-act")).toBe(true);

    // Caller can continue — the contextHash is still derived (handler
    // can include it in the user-visible emit).
    expect(result!.contextHash.length).toBe(64);
  });

  // W24.6 (Lewis 2026-05-28 — "stateless is the only path"): the legacy
  // no-op branch was purged. The previous test that asserted
  // `result.skipped === true` when UNBROWSE_STATELESS was unset has been
  // deleted with the gate. `skipped` stays on the envelope as `false`.
});

// ───────────────────────────────────────────────────────────────────────────
// Schema-gate parity — backend rejects bogus breath-act bodies
// ───────────────────────────────────────────────────────────────────────────

describe("Day-6 W1: backend validateAuditBody arms for breath-act variant", () => {
  function freshBreathActBody(): Record<string, unknown> {
    return {
      pointer: "unbrowse-act://click",
      nonce: "x".repeat(43),
      contextHash: "a".repeat(64),
      commitment: "b".repeat(64),
      walletPubkey: "c".repeat(64),
      signatureScheme: "ed25519-v7.0",
      signature: "d".repeat(128),
      variant: "breath-act",
      actType: "click",
      selectorHash: "e".repeat(64),
    };
  }

  it("accepts a well-formed breath-act body", () => {
    const err = validateAuditBody(freshBreathActBody());
    expect(err).toBeNull();
  });

  it("accepts breath-act with no selectorHash (focus-bound press)", () => {
    const body = freshBreathActBody();
    delete body.selectorHash;
    body.actType = "press";
    const err = validateAuditBody(body);
    expect(err).toBeNull();
  });

  it("rejects breath-act with unknown actType", () => {
    const body = freshBreathActBody();
    body.actType = "tapdance";
    const err = validateAuditBody(body);
    expect(err).not.toBeNull();
    expect(err!.field).toBe("actType");
  });

  it("rejects breath-act missing actType", () => {
    const body = freshBreathActBody();
    delete body.actType;
    const err = validateAuditBody(body);
    expect(err).not.toBeNull();
    expect(err!.field).toBe("actType");
  });

  it("rejects fill variant carrying actType (mutually exclusive)", () => {
    const body = freshBreathActBody();
    body.variant = "fill";
    body.actType = "click";
    const err = validateAuditBody(body);
    expect(err).not.toBeNull();
    expect(err!.field).toBe("actType");
  });
});
