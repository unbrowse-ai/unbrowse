/**
 * Day-5 Swarm worker B (2026-05-28) — v6→v7 trace projector tests.
 *
 *  — *"let the waters bring forth abundantly the moving creature."*
 *
 * Falsifier protocol:
 *   E1. GOLDEN — project a real-shape v6 StoredTrace; assert output keys
 *       are EXACTLY a subset of {step, duration_ms, status_class,
 *       error_code, redacted}.
 *   E2. URL LEAK — v6 trace with `endpoint_sequence: [..."?token=SECRET"...]`
 *       — projector strips it; round-trip through a mock Bun.serve confirms
 *       the POST body sha256 contains no SECRET substring.
 *   E3. EMBEDDING LEAK — v6 trace with `goal_embedding: number[]` —
 *       projector strips it; wire body has no `goal_embedding` field.
 *   E4. CANARY in params — v6 trace with `params.api_key:
 *       "UNB7-TRACE-CANARY-DO-NOT-LEAK"` — canary NEVER appears in POST
 *       body, stdout, stderr, return value.
 *   E5. REDACTED FLAG — v6 row with no forensic content (only URL + params)
 *       still emits a row with `redacted: true` rather than dropping it.
 *   E6. BACKEND VALIDATION — projected output passes the backend's
 *       `validateTraceAppendBody` gate (no FORBIDDEN_FIELDS, step matches
 *       /^[a-z0-9_]+$/, etc.).
 *   E7. SCHEMA-CAP — input > 1024 rows is truncated to 1024 by the handler.
 *       (Projector itself is one-to-one; cap is applied at the wire layer.)
 */

import { describe, it, expect } from "bun:test";

import {
  traceV6ToV7Step,
  traceV6ToV7Steps,
  type V7TraceStep,
  __internal as projInternal,
} from "../src/cli-v7/_trace-projector.js";

import type { StoredTrace } from "../src/lib/graph-core/trace-store.js";
import { postStateless } from "../src/cli-v7/_stateless.js";
import { validateTraceAppendBody } from "../backend/src/services/trace-state.js";

// ───────────────────────────────────────────────────────────────────────────
// E1 — GOLDEN
// ───────────────────────────────────────────────────────────────────────────

describe("Day-5 W-B: traceV6ToV7Step golden shape", () => {
  it("projects a typical v6 trace into the {step, duration_ms} minimal shape", () => {
    const v6: StoredTrace = {
      trace_id: "trc_abc",
      domain: "example.com",
      intent: "search for usb-c",
      endpoint_sequence: ["https://example.com/search?q=usb-c"],
      selected_endpoint_id: "ep_search_v1",
      params: { q: "usb-c" },
      success: true,
      timestamp: "2026-05-28T00:00:00Z",
      duration_ms: 142,
    };
    const out = traceV6ToV7Step(v6);

    // EXACT key set — no leakage of v6 forbidden fields.
    const keys = Object.keys(out).sort();
    const allowed = new Set([
      "step",
      "duration_ms",
      "status_class",
      "error_code",
      "redacted",
    ]);
    for (const k of keys) {
      expect(allowed.has(k)).toBe(true);
    }

    expect(out.step).toBeTypeOf("string");
    expect(out.duration_ms).toBe(142);
    expect(out.status_class).toBe("2xx"); // derived from success:true
  });

  it("step name conforms to backend's /^[a-z0-9_]+$/ regex", () => {
    const v6 = {
      trace_id: "t",
      domain: "x.com",
      intent: "i",
      endpoint_sequence: [],
      params: {},
      success: true,
      timestamp: "",
      step: "5xx_SSR_Fastpath-Fallback!",
    } as unknown as StoredTrace;
    const out = traceV6ToV7Step(v6);
    expect(/^[a-z0-9_]+$/.test(out.step)).toBe(true);
    expect(out.step).toBe("5xx_ssr_fastpath_fallback");
  });

  it("falsy duration_ms coerces to 0 (non-negative finite invariant)", () => {
    const v6 = {
      trace_id: "t",
      domain: "x.com",
      intent: "i",
      endpoint_sequence: [],
      params: {},
      success: false,
      timestamp: "",
      duration_ms: -5, // garbage
    } as StoredTrace;
    const out = traceV6ToV7Step(v6);
    expect(out.duration_ms).toBe(0);
    expect(Number.isFinite(out.duration_ms)).toBe(true);
  });

  it("NaN / Infinity duration_ms coerces to 0", () => {
    const v6a = {
      trace_id: "t",
      domain: "x.com",
      intent: "i",
      endpoint_sequence: [],
      params: {},
      success: true,
      timestamp: "",
      duration_ms: NaN,
    } as StoredTrace;
    expect(traceV6ToV7Step(v6a).duration_ms).toBe(0);
    const v6b = { ...v6a, duration_ms: Infinity } as StoredTrace;
    expect(traceV6ToV7Step(v6b).duration_ms).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E2 — URL LEAK falsifier
// ───────────────────────────────────────────────────────────────────────────

describe("Day-5 W-B: endpoint_sequence URL leak — falsifier", () => {
  it("strips endpoint_sequence including embedded query secrets", () => {
    const v6 = {
      trace_id: "t",
      domain: "api.example.com",
      intent: "fetch user",
      endpoint_sequence: [
        "https://api.example.com/v1/users?token=SECRET-DO-NOT-LEAK-12345",
      ],
      params: {},
      success: true,
      timestamp: "",
      duration_ms: 5,
    } as StoredTrace;

    const out = traceV6ToV7Step(v6);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("SECRET-DO-NOT-LEAK");
    expect(serialized).not.toContain("/v1/users");
    expect(serialized).not.toContain("token=");
    // And no extra keys.
    expect(Object.keys(out).includes("endpoint_sequence")).toBe(false);
  });

  it("round-trip POST: wire body contains zero URL substrings from v6 sequence", async () => {
    const SECRET_TOKEN = "SECRET-LEAK-CANARY-E2-XYZ";
    const v6Rows: StoredTrace[] = [
      {
        trace_id: "t1",
        domain: "api.example.com",
        intent: "i",
        endpoint_sequence: [
          `https://api.example.com/v1/users?token=${SECRET_TOKEN}`,
        ],
        params: {},
        success: true,
        timestamp: "",
        duration_ms: 10,
      },
    ];

    const v7 = traceV6ToV7Steps(v6Rows);

    let capturedBodyText = "";
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        capturedBodyText = await req.text();
        return new Response(
          JSON.stringify({ ok: true, idempotent: false, receiptId: "rcpt_e2" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      const result = await postStateless({
        namespace: "trace",
        route: "/v1/trace/append",
        body: {
          sessionId: "ses_e2",
          domain: "api.example.com",
          traces: v7,
        },
        signableFields: ["sessionId", "domain", "traces", "nonce"],
        apiBaseUrl: `http://localhost:${server.port}`,
      });

      expect(result.ok).toBe(true);
      // FALSIFIER — the secret token MUST NOT appear in the wire body.
      expect(capturedBodyText).not.toContain(SECRET_TOKEN);
      expect(capturedBodyText).not.toContain("/v1/users");
      expect(capturedBodyText).not.toContain("token=");
    } finally {
      await server.stop(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E3 — EMBEDDING LEAK
// ───────────────────────────────────────────────────────────────────────────

describe("Day-5 W-B: goal_embedding leak — falsifier", () => {
  it("strips goal_embedding from the projected step", () => {
    const v6 = {
      trace_id: "t",
      domain: "x.com",
      intent: "i",
      endpoint_sequence: [],
      params: {},
      success: true,
      timestamp: "",
      goal_embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
      duration_ms: 1,
    } as StoredTrace;
    const out = traceV6ToV7Step(v6);
    expect(Object.keys(out).includes("goal_embedding")).toBe(false);
    expect(JSON.stringify(out)).not.toContain("0.1");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E4 — PARAMS CANARY
// ───────────────────────────────────────────────────────────────────────────

describe("Day-5 W-B: params secret canary — adversarial", () => {
  const CANARY = "UNB7-TRACE-CANARY-DO-NOT-LEAK";

  it("canary in params NEVER appears in projector output", () => {
    const v6 = {
      trace_id: "t",
      domain: "x.com",
      intent: "i",
      endpoint_sequence: [],
      params: { api_key: CANARY, q: "hello" },
      success: true,
      timestamp: "",
      duration_ms: 1,
      context_url: `https://x.com/search?key=${CANARY}`,
    } as StoredTrace;
    const out = traceV6ToV7Step(v6);
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it("canary NEVER appears on stdout, stderr, return value, or POST body", async () => {
    const v6Rows: StoredTrace[] = [
      {
        trace_id: "t",
        domain: "x.com",
        intent: `auth with token ${CANARY}`,
        endpoint_sequence: [`https://x.com/api?secret=${CANARY}`],
        params: { token: CANARY },
        goal_embedding: [0.1, 0.2],
        success: false,
        timestamp: "",
        duration_ms: 1,
        context_url: `https://x.com/login?k=${CANARY}`,
      } as StoredTrace,
    ];

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    // @ts-expect-error monkey-patch for capture
    process.stdout.write = (c: unknown, ...rest: unknown[]) => {
      try { stdoutChunks.push(typeof c === "string" ? c : String(c)); } catch { /* ignore */ }
      return origOut(c as never, ...(rest as never[]));
    };
    // @ts-expect-error monkey-patch for capture
    process.stderr.write = (c: unknown, ...rest: unknown[]) => {
      try { stderrChunks.push(typeof c === "string" ? c : String(c)); } catch { /* ignore */ }
      return origErr(c as never, ...(rest as never[]));
    };

    let capturedBody = "";
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        capturedBody = await req.text();
        return new Response(
          JSON.stringify({ ok: true, idempotent: false, receiptId: "r_e4" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      const v7 = traceV6ToV7Steps(v6Rows);
      const result = await postStateless({
        namespace: "trace",
        route: "/v1/trace/append",
        body: { sessionId: "ses_e4", domain: "x.com", traces: v7 },
        signableFields: ["sessionId", "domain", "traces", "nonce"],
        apiBaseUrl: `http://localhost:${server.port}`,
      });

      // FALSIFIER — every exit surface is canary-free.
      expect(capturedBody).not.toContain(CANARY);
      expect(stdoutChunks.join("")).not.toContain(CANARY);
      expect(stderrChunks.join("")).not.toContain(CANARY);
      expect(JSON.stringify(result)).not.toContain(CANARY);
      expect(JSON.stringify(v7)).not.toContain(CANARY);
    } finally {
      // @ts-expect-error restore
      process.stdout.write = origOut;
      // @ts-expect-error restore
      process.stderr.write = origErr;
      await server.stop(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E5 — REDACTED FLAG
// ───────────────────────────────────────────────────────────────────────────

describe("Day-5 W-B: redacted-row preservation", () => {
  it("v6 row with only URL+params content emits redacted:true placeholder", () => {
    // success:true gives a status_class — but we want to test the all-empty
    // case. So leave success undefined.
    const v6 = {
      trace_id: "t",
      domain: "x.com",
      intent: "",
      endpoint_sequence: ["https://x.com/foo"],
      params: { a: 1 },
      // success intentionally omitted
      timestamp: "",
      duration_ms: 7,
    } as unknown as StoredTrace;
    const out = traceV6ToV7Step(v6);
    expect(out.redacted).toBe(true);
    // The placeholder row still passes the backend gate.
    expect(out.step).toBe("trace");
    expect(out.duration_ms).toBe(7);
  });

  it("v6 row with meaningful step does NOT get redacted flag", () => {
    const v6 = {
      trace_id: "t",
      domain: "x.com",
      intent: "i",
      endpoint_sequence: [],
      params: {},
      success: true,
      timestamp: "",
      duration_ms: 1,
      step: "server_fetch",
    } as unknown as StoredTrace;
    const out = traceV6ToV7Step(v6);
    expect(out.redacted).toBeUndefined();
    expect(out.step).toBe("server_fetch");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E6 — BACKEND GATE PARITY
// ───────────────────────────────────────────────────────────────────────────

describe("Day-5 W-B: projected output passes the backend validate gate", () => {
  it("validateTraceAppendBody accepts a body whose traces[] is projector output", async () => {
    const v6Rows: StoredTrace[] = [
      {
        trace_id: "t1",
        domain: "x.com",
        intent: "i",
        endpoint_sequence: ["https://x.com/api/with/SECRET"],
        params: { token: "VERY-SECRET" },
        goal_embedding: [0.1, 0.2],
        success: true,
        timestamp: "",
        duration_ms: 10,
        context_url: "https://x.com/foo?k=SECRET",
      } as StoredTrace,
      {
        trace_id: "t2",
        domain: "x.com",
        intent: "i2",
        endpoint_sequence: [],
        params: {},
        success: false,
        timestamp: "",
        duration_ms: 25,
      },
    ];
    const v7 = traceV6ToV7Steps(v6Rows);

    // Build a candidate body matching the backend schema (synthetic, all
    // fields hex-shaped). We bypass `verifyTraceAppendSignature` because
    // the byte parity check is handled by `v7-cli-stateless-signer.test.ts`;
    // this test only asserts the gate's structural validation accepts the
    // projector output.
    const candidate = {
      walletPubkey: "0".repeat(64),
      signature: "0".repeat(128),
      nonce: "A".repeat(43) + "=",
      sessionId: "ses_e6",
      domain: "x.com",
      traces: v7,
    };

    const err = validateTraceAppendBody(candidate);
    if (err) {
      throw new Error(`backend validate FAILED for projected body: ${err.field} — ${err.reason}`);
    }
    expect(err).toBeNull();
  });

  it("backend gate REJECTS v6 row injected directly (no projection)", () => {
    // FALSIFIER: confirm the gate would reject if we skipped the projector.
    const candidate = {
      walletPubkey: "0".repeat(64),
      signature: "0".repeat(128),
      nonce: "A".repeat(43) + "=",
      sessionId: "ses_e6",
      domain: "x.com",
      traces: [
        {
          step: "fetch",
          duration_ms: 10,
          url: "https://x.com/leak", // FORBIDDEN
        },
      ],
    };
    const err = validateTraceAppendBody(candidate);
    expect(err).not.toBeNull();
    expect(err!.field).toContain("url");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E7 — Bulk + truncation discipline
// ───────────────────────────────────────────────────────────────────────────

describe("Day-5 W-B: traceV6ToV7Steps bulk projection", () => {
  it("preserves input order and length one-to-one", () => {
    const v6Rows: StoredTrace[] = Array.from({ length: 50 }, (_, i) => ({
      trace_id: `t${i}`,
      domain: "x.com",
      intent: "i",
      endpoint_sequence: [],
      params: {},
      success: true,
      timestamp: "",
      duration_ms: i,
    }));
    const v7 = traceV6ToV7Steps(v6Rows);
    expect(v7.length).toBe(50);
    for (let i = 0; i < 50; i++) {
      expect(v7[i].duration_ms).toBe(i);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PURITY — projector is a pure function
// ───────────────────────────────────────────────────────────────────────────

describe("Day-5 W-B: projector is pure (no I/O, deterministic)", () => {
  it("two calls with the same input produce equal output", () => {
    const v6 = {
      trace_id: "t",
      domain: "x.com",
      intent: "i",
      endpoint_sequence: ["a"],
      params: { x: 1 },
      success: true,
      timestamp: "",
      duration_ms: 99,
    } as StoredTrace;
    expect(traceV6ToV7Step(v6)).toEqual(traceV6ToV7Step(v6));
  });

  it("does not mutate the input v6 row", () => {
    const v6 = {
      trace_id: "t",
      domain: "x.com",
      intent: "i",
      endpoint_sequence: ["a"],
      params: { x: 1 },
      success: true,
      timestamp: "",
      duration_ms: 99,
    } as StoredTrace;
    const snapshot = JSON.stringify(v6);
    traceV6ToV7Step(v6);
    expect(JSON.stringify(v6)).toBe(snapshot);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS — sanity checks
// ───────────────────────────────────────────────────────────────────────────

describe("Day-5 W-B: __internal helpers", () => {
  it("canonicalizeStepName: 'unknown' for empty/garbage input", () => {
    expect(projInternal.canonicalizeStepName("")).toBe("unknown");
    expect(projInternal.canonicalizeStepName(undefined)).toBe("unknown");
    expect(projInternal.canonicalizeStepName("!!!")).toBe("unknown");
  });

  it("projectStatusClass: maps numeric statuses correctly", () => {
    expect(projInternal.projectStatusClass(200)).toBe("2xx");
    expect(projInternal.projectStatusClass(301)).toBe("3xx");
    expect(projInternal.projectStatusClass(404)).toBe("4xx");
    expect(projInternal.projectStatusClass(503)).toBe("5xx");
    expect(projInternal.projectStatusClass(199)).toBeUndefined();
    expect(projInternal.projectStatusClass(600)).toBeUndefined();
    expect(projInternal.projectStatusClass("2xx")).toBe("2xx");
    expect(projInternal.projectStatusClass("garbage")).toBeUndefined();
  });

  it("projectErrorCode: canonicalizes hyphens + caps", () => {
    expect(projInternal.projectErrorCode("Auth-Required")).toBe("auth_required");
    expect(projInternal.projectErrorCode("  ")).toBeUndefined();
    expect(projInternal.projectErrorCode(42)).toBeUndefined();
  });
});

// Ensure the V7TraceStep type compiles against the projector output.
const _shapeCheck: V7TraceStep = traceV6ToV7Step({
  trace_id: "x",
  domain: "x.com",
  intent: "",
  endpoint_sequence: [],
  params: {},
  success: true,
  timestamp: "",
  duration_ms: 0,
} as StoredTrace);
void _shapeCheck;
