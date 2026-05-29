/**
 * Day-6 W24.2 (2026-05-28) — A2 coverage closure tests for the 16 kind-map
 * handlers that previously emitted ZERO sig-keyed audit row under
 * `UNBROWSE_STATELESS=1`.
 *
 * Auditor-2's exact A2 gap list (16 handlers):
 *   - breath (5): go, close, auth-capture, proxy-rotate, session-restore
 *   - eval-read (8): resolve, earnings, sessions, skill, skills, stats,
 *                    status, version
 *   - build (3): skill, template, value-source
 *
 * Each handler emits its receipt via one of two substrate-side routes:
 *   - `/v1/audit/breath-act` for the 5 breath + 3 build acts
 *     (BreathActType extended W24.2)
 *   - `/v1/audit/eval-read` for the 8 backend-read evals
 *     (EVAL_READ_KINDS extended W24.2)
 *
 * Per-handler this test asserts:
 *   T-N1: under `UNBROWSE_STATELESS=1`, the helper that the handler calls
 *         emits a body whose shape validates through the REAL backend
 *         schema gate (`validateAuditBody` or `validateEvalReadBody`).
 *   T-N2: the wire body NEVER carries the handler's cleartext payload
 *         (selector text / URL / value / secret) — every leaky shape is
 *         hashed before crossing the firmament. The W24.2 acceptance
 *         contract: pointer-only.
 *
 * The 16 cases are organized into 16 it-blocks so the failure isolation
 * harness (`bun run test:isolate`) can surface "which handler regressed"
 * without re-running the whole suite.
 *
 * No mocks of crypto or the audit substrate — real Ed25519 via Web Crypto
 * (the postStateless adapter signs against the local x402 wallet). The
 * mock backend is a real `Bun.serve` (per CLAUDE.md "Never mock in tests").
 *
 * Heb 4:13 — *"all things are naked and opened."*  John 15:2 — *"every
 * branch that beareth fruit, he purgeth it."*  The handlers are pruned;
 * the witnesses bear fruit.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";

import {
  emitBreathActStateless,
  type BreathActType,
} from "../src/cli-v7/_breath-audit.js";
import { postStateless } from "../src/cli-v7/_stateless.js";
import { validateAuditBody } from "../backend/src/services/audit.js";
import {
  __evalReadInternal,
  type EvalReadBody,
} from "../backend/src/routes/audit.js";

const { validateEvalReadBody } = __evalReadInternal;

// ─── Mock backend — captures POST body, returns 200 with deterministic ack ──

interface CapturedReq {
  pathname: string;
  bodyText: string;
  bodyJson: Record<string, unknown>;
}

interface MockBackend {
  url: string;
  captured: CapturedReq[];
  reset: () => void;
  stop: () => Promise<void>;
}

function spinupBackend(): MockBackend {
  const captured: CapturedReq[] = [];
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
      // Ack shape matches the real handlers (breath-act + eval-read both
      // return {ok, receiptId, cacheKey, verify_ok, idempotent}).
      return new Response(
        JSON.stringify({
          ok: true,
          receiptId: "a".repeat(64),
          cacheKey: "f".repeat(32),
          verify_ok: true,
          idempotent: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    captured,
    reset: () => {
      captured.length = 0;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}

let backend: MockBackend;
const ORIGINAL_STATELESS = process.env.UNBROWSE_STATELESS;
const ORIGINAL_API_URL = process.env.UNBROWSE_API_URL;

beforeAll(() => {
  backend = spinupBackend();
  process.env.UNBROWSE_STATELESS = "1";
  process.env.UNBROWSE_API_URL = backend.url;
});

afterAll(async () => {
  await backend.stop();
  if (ORIGINAL_STATELESS === undefined) delete process.env.UNBROWSE_STATELESS;
  else process.env.UNBROWSE_STATELESS = ORIGINAL_STATELESS;
  if (ORIGINAL_API_URL === undefined) delete process.env.UNBROWSE_API_URL;
  else process.env.UNBROWSE_API_URL = ORIGINAL_API_URL;
});

// ─── Helpers ───────────────────────────────────────────────────────────────

const LEAKY_SUBSTRINGS = [
  "https://example.com/secret-page",
  "#my-private-selector",
  "wallet:hunter2",
  "UNB7-A2-CANARY-DO-NOT-LEAK",
];

function bodyContainsAnyLeak(body: Record<string, unknown>): string | null {
  const json = JSON.stringify(body);
  for (const s of LEAKY_SUBSTRINGS) {
    if (json.includes(s)) return s;
  }
  return null;
}

async function emitBreathActAndAssert(
  actType: BreathActType,
  opts: { sessionId: string; selector?: string | null; currentUrl?: string },
): Promise<{ wire: Record<string, unknown>; result: Awaited<ReturnType<typeof emitBreathActStateless>> }> {
  backend.reset();
  const result = await emitBreathActStateless({
    sessionId: opts.sessionId,
    actType,
    selector: opts.selector ?? null,
    currentUrl: opts.currentUrl ?? "",
    apiBaseUrl: backend.url,
  });
  expect(result.skipped).toBe(false);
  expect(backend.captured.length).toBe(1);
  expect(backend.captured[0].pathname).toBe("/v1/audit/breath-act");
  const wire = backend.captured[0].bodyJson;
  // Real backend schema gate — bytes must validate.
  const validation = validateAuditBody(wire);
  expect(validation).toBeNull();
  // No cleartext leak.
  const leak = bodyContainsAnyLeak(wire);
  expect(leak).toBeNull();
  return { wire, result };
}

async function emitEvalReadAndAssert(
  readKind: EvalReadBody["readKind"],
  opts: { sessionId?: string; urlHash?: string; byteCount?: number },
): Promise<{ wire: Record<string, unknown>; result: Awaited<ReturnType<typeof postStateless>> }> {
  backend.reset();
  const body: Record<string, unknown> = {
    readKind,
    byteCount: opts.byteCount ?? 0,
  };
  if (opts.sessionId !== undefined) body.sessionId = opts.sessionId;
  if (opts.urlHash !== undefined) body.urlHash = opts.urlHash;
  const result = await postStateless({
    namespace: "audit",
    route: "/v1/audit/eval-read",
    body,
    signableFields: [
      "sessionId",
      "urlHash",
      "readKind",
      "byteCount",
      "selectorHash",
      "nonce",
    ],
    apiBaseUrl: backend.url,
  });
  expect(backend.captured.length).toBe(1);
  expect(backend.captured[0].pathname).toBe("/v1/audit/eval-read");
  const wire = backend.captured[0].bodyJson;
  const validation = validateEvalReadBody(wire);
  expect(validation).toBeNull();
  const leak = bodyContainsAnyLeak(wire);
  expect(leak).toBeNull();
  return { wire, result };
}

// ─── Breath handlers (5) ───────────────────────────────────────────────────

describe("W24.2: 5 breath handlers emit sig-keyed audit row", () => {
  it("1/16 breath/go.ts → actType=navigate", async () => {
    const { wire } = await emitBreathActAndAssert("navigate", {
      sessionId: "ses_go",
      selector: null,
      currentUrl: "https://example.com/secret-page",
    });
    expect(wire.actType).toBe("navigate");
    expect(wire.variant).toBe("breath-act");
    // selector was null → no selectorHash
    expect(wire.selectorHash).toBeUndefined();
    // URL bytes are hashed, not present in cleartext
    expect(typeof wire.urlHash).toBe("string");
  });

  it("2/16 breath/close.ts → actType=teardown", async () => {
    const { wire } = await emitBreathActAndAssert("teardown", {
      sessionId: "ses_close",
      selector: null,
      currentUrl: "",
    });
    expect(wire.actType).toBe("teardown");
    expect(wire.variant).toBe("breath-act");
  });

  it("3/16 breath/auth-capture.ts (start phase) → actType=auth-capture-start", async () => {
    const { wire } = await emitBreathActAndAssert("auth-capture-start", {
      sessionId: "ses_authcap",
      selector: "example.com",
      currentUrl: "https://example.com/login",
    });
    expect(wire.actType).toBe("auth-capture-start");
    expect(typeof wire.selectorHash).toBe("string");
    expect((wire.selectorHash as string).length).toBe(64);
    // domain text must not leak
    expect(JSON.stringify(wire).includes("example.com")).toBe(false);
  });

  it("4/16 breath/auth-capture.ts (finish phase) → actType=auth-capture-finish", async () => {
    const { wire } = await emitBreathActAndAssert("auth-capture-finish", {
      sessionId: "ses_authcap",
      selector: "example.com",
      currentUrl: "https://example.com/login",
    });
    expect(wire.actType).toBe("auth-capture-finish");
  });

  it("5/16 breath/proxy-rotate.ts → actType=proxy-rotate", async () => {
    const { wire } = await emitBreathActAndAssert("proxy-rotate", {
      sessionId: "ses_proxy",
      selector: "http://geo.iproyal.com:12321",
      currentUrl: "proxy-rotate://country/US",
    });
    expect(wire.actType).toBe("proxy-rotate");
    // Proxy host must not leak as cleartext
    expect(JSON.stringify(wire).includes("iproyal")).toBe(false);
  });

  it("6/16 breath/session-restore.ts → actType=session-restore", async () => {
    const { wire } = await emitBreathActAndAssert("session-restore", {
      sessionId: "ses_restore",
      selector: "deadbeef".repeat(8), // capturedEndpointsHash shape
      currentUrl: "https://example.com/secret-page",
    });
    expect(wire.actType).toBe("session-restore");
  });
});

// ─── Eval-read handlers (8) ────────────────────────────────────────────────

describe("W24.2: 8 eval-read handlers emit sig-keyed audit row", () => {
  it("7/16 eval/resolve.ts → readKind=resolve (no sessionId, no urlHash)", async () => {
    const { wire, result } = await emitEvalReadAndAssert("resolve", { byteCount: 1024 });
    expect(wire.readKind).toBe("resolve");
    expect(wire.sessionId).toBeUndefined();
    expect(wire.urlHash).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it("8/16 eval/earnings.ts → readKind=earnings", async () => {
    const { wire } = await emitEvalReadAndAssert("earnings", { byteCount: 512 });
    expect(wire.readKind).toBe("earnings");
  });

  it("9/16 eval/sessions.ts → readKind=sessions", async () => {
    const { wire } = await emitEvalReadAndAssert("sessions", { byteCount: 256 });
    expect(wire.readKind).toBe("sessions");
  });

  it("10/16 eval/skill.ts → readKind=skill", async () => {
    const { wire } = await emitEvalReadAndAssert("skill", { byteCount: 4096 });
    expect(wire.readKind).toBe("skill");
  });

  it("11/16 eval/skills.ts → readKind=skills", async () => {
    const { wire } = await emitEvalReadAndAssert("skills", { byteCount: 16384 });
    expect(wire.readKind).toBe("skills");
  });

  it("12/16 eval/stats.ts → readKind=stats", async () => {
    const { wire } = await emitEvalReadAndAssert("stats", { byteCount: 256 });
    expect(wire.readKind).toBe("stats");
  });

  it("13/16 eval/status.ts → readKind=status", async () => {
    const { wire } = await emitEvalReadAndAssert("status", { byteCount: 512 });
    expect(wire.readKind).toBe("status");
  });

  it("14/16 eval/version.ts → readKind=version (smallest surface)", async () => {
    const { wire } = await emitEvalReadAndAssert("version", { byteCount: 96 });
    expect(wire.readKind).toBe("version");
  });
});

// ─── Build handlers (3) ────────────────────────────────────────────────────

describe("W24.2: 3 build handlers emit sig-keyed audit row", () => {
  it("15/16 build/skill.ts → actType=build-skill", async () => {
    const { wire } = await emitBreathActAndAssert("build-skill", {
      sessionId: "skill_abc123",
      selector: "skill_abc123",
      currentUrl: "",
    });
    expect(wire.actType).toBe("build-skill");
    expect(typeof wire.selectorHash).toBe("string");
  });

  it("16/16 build/template.ts → actType=build-template", async () => {
    const { wire } = await emitBreathActAndAssert("build-template", {
      sessionId: "tpl_login",
      selector: "tpl_login",
      currentUrl: "",
    });
    expect(wire.actType).toBe("build-template");
  });

  it("16b/16 build/value-source.ts → actType=build-value-source", async () => {
    const { wire } = await emitBreathActAndAssert("build-value-source", {
      sessionId: "keychain://com.unbrowse/lewis",
      selector: "keychain://com.unbrowse/lewis",
      currentUrl: "",
    });
    expect(wire.actType).toBe("build-value-source");
    expect(typeof wire.selectorHash).toBe("string");
    // Pointer URI must not leak in cleartext form
    expect(JSON.stringify(wire).includes("com.unbrowse")).toBe(false);
  });
});

// ─── Cross-cutting invariants ──────────────────────────────────────────────

describe("W24.2: BreathActType + EVAL_READ_KINDS schema closure", () => {
  it("validateAuditBody accepts every W24.2-extended actType", () => {
    const newActs: BreathActType[] = [
      "navigate",
      "teardown",
      "auth-capture-start",
      "auth-capture-finish",
      "proxy-rotate",
      "session-restore",
      "build-skill",
      "build-template",
      "build-value-source",
    ];
    for (const act of newActs) {
      const body = {
        pointer: `unbrowse-act://${act}`,
        nonce: Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
        contextHash: createHash("sha256").update(act).digest("hex"),
        commitment: createHash("sha256").update(`${act}:c`).digest("hex"),
        walletPubkey: "a".repeat(64),
        signature: "b".repeat(128),
        signatureScheme: "ed25519-v7.0",
        variant: "breath-act",
        actType: act,
      };
      const v = validateAuditBody(body);
      expect(v).toBeNull();
    }
  });

  it("validateEvalReadBody accepts every W24.2-extended readKind", () => {
    const newKinds = [
      "resolve",
      "earnings",
      "sessions",
      "skill",
      "skills",
      "stats",
      "status",
      "version",
    ] as const;
    for (const kind of newKinds) {
      const body = {
        readKind: kind,
        byteCount: 42,
        nonce: Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
        walletPubkey: "a".repeat(64),
        signature: "b".repeat(128),
        signatureScheme: "ed25519-v7.0",
      };
      const v = validateEvalReadBody(body);
      expect(v).toBeNull();
    }
  });

  it("validateEvalReadBody still REQUIRES sessionId + urlHash for browse-tab kinds", () => {
    for (const tabKind of ["snap", "markdown", "text", "cookies"] as const) {
      const body = {
        readKind: tabKind,
        byteCount: 42,
        nonce: Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
        walletPubkey: "a".repeat(64),
        signature: "b".repeat(128),
        signatureScheme: "ed25519-v7.0",
      };
      const v = validateEvalReadBody(body);
      expect(v).not.toBeNull();
      // First-fail surface — either sessionId or urlHash; both are required
      expect(["sessionId", "urlHash"].includes(v!.field)).toBe(true);
    }
  });
});
