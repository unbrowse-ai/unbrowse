/**
 * W34-B — internet-layer boundary enforcement tests.
 *
 *   Genesis 1:9 — *"the waters gathered... and the dry land appear."* The
 *   37 named internet ops are the dry land (the public product surface); the
 *   mechanism kinds stay below the waters (aiko-only). These tests prove the
 *   PUBLIC dispatcher accepts ONLY the 37 KIND_MAP ops and that a mechanism
 *   op (`revealed_context`, etc.) fails closed with `unknown_op`, never
 *   reaching a handler/binary.
 *
 * Three surfaces under test:
 *   1. CLI/MCP dispatcher (src/cli-v7/dispatch/index.ts) — allowlist gate.
 *   2. Backend /v1/covenant (backend/src/routes/covenant.ts) — public-reject,
 *      aiko-key-allow.
 *   3. scripts/leak-guard.sh — CI gate catching mechanism leaks in source.
 *
 * No mocks of the surfaces under test — real in-process dispatch, real Hono
 * app + real Web Crypto Ed25519, real shell-out to the guard. CLAUDE.md:
 * never mock the network / the code path under test.
 */
import { describe, expect, it, test } from "bun:test";
import { Hono } from "hono";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  dispatchByKind,
  isPublicOp,
  PUBLIC_OP_ALLOWLIST,
} from "../src/cli-v7/dispatch/index.js";
import { KIND_MAP } from "../src/cli-v7/kind-map.js";
import { covenantRoutes } from "../backend/src/routes/covenant.js";
import {
  canonicalizeSignedFragment as auditSignedFragment,
  type AuditFillBody,
} from "../backend/src/services/audit.js";
import type { Env } from "../backend/src/types.js";

const REPO_ROOT = join(import.meta.dir, "..");

// The 8 headline mechanism kinds (INTERNET_LAYER_COVENANT_SURFACE.md §1 HIDDEN).
const MECHANISM_KINDS = [
  "revealed_context",
  "diffusion_populate",
  "ebm_route",
  "ebm_train",
  "canon_witness",
  "rules_for_identity",
  "establishment_query",
  "recall_episode",
] as const;

// ─── 1. CLI/MCP dispatcher allowlist (derived from KIND_MAP) ────────────────

describe("dispatcher allowlist — derived from KIND_MAP's 37 rows", () => {
  it("PUBLIC_OP_ALLOWLIST is exactly the KIND_MAP op_kinds (no second list)", () => {
    expect(PUBLIC_OP_ALLOWLIST.size).toBe(KIND_MAP.length);
    for (const entry of KIND_MAP) {
      expect(isPublicOp(entry.op_kind)).toBe(true);
    }
  });

  it("every mechanism kind is NOT on the allowlist", () => {
    for (const m of MECHANISM_KINDS) {
      expect(isPublicOp(m)).toBe(false);
      expect(PUBLIC_OP_ALLOWLIST.has(m)).toBe(false);
    }
  });

  it("dispatchByKind('breath:navigate', ...) — internet op dispatches normally", async () => {
    // breath:navigate is on the allowlist → it loads its handler. We don't
    // need a live browser; a missing session yields a structured handler
    // result (ok:false with a real error), NOT an `unknown_op` allowlist reject.
    const res = await dispatchByKind("breath:navigate", { url: "https://example.com" }, { json: true });
    expect(res.op_kind).toBe("breath:navigate");
    // It reached the handler (subcommand resolved), not the allowlist gate.
    expect(res.subcommand).toBe("breath go");
    expect(res.dispatch_error).not.toBe("unknown_op");
  }, 15_000);

  it("dispatchByKind('revealed_context', ...) — mechanism → unknown_op, never reaches binary", async () => {
    const res = await dispatchByKind("revealed_context", { foo: "bar" }, { json: true });
    expect(res.ok).toBe(false);
    expect(res.dispatch_error).toBe("unknown_op");
    // No handler was loaded → subcommand stays empty, no mcp_tool.
    expect(res.subcommand).toBe("");
    expect(res.mcp_tool).toBeNull();
    // No stdout/stderr from a handler — the gate short-circuited.
    expect(res.stdout).toBe("");
  });

  it("every mechanism kind → unknown_op (smuggled-base variants too)", async () => {
    for (const m of MECHANISM_KINDS) {
      const bare = await dispatchByKind(m, {}, { json: true });
      expect(bare.dispatch_error).toBe("unknown_op");
      // smuggled behind a valid verb prefix — still not in KIND_MAP.
      const smuggled = await dispatchByKind(`observe:${m}`, {}, { json: true });
      expect(smuggled.dispatch_error).toBe("unknown_op");
    }
  });
});

// ─── Backend /v1/covenant helpers (mirrors v7-covenant-opacity.test.ts) ──────

function makeMemoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async (opts?: { prefix?: string; limit?: number }) => {
      const prefix = opts?.prefix ?? "";
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .sort()
        .slice(0, opts?.limit ?? 1000)
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    AUDIT_LOG: makeMemoryKv(),
    SESSION_STATE: makeMemoryKv(),
    TRACE_STATE: makeMemoryKv(),
    SETTINGS_STATE: makeMemoryKv(),
    STATS_KV: {} as KVNamespace,
    ENVIRONMENT: "local-test",
    ...over,
  } as unknown as Env;
}

function mountApp(): Hono {
  const app = new Hono();
  app.route("/", covenantRoutes);
  return app;
}

function bytesToHex(b: ArrayBuffer | Uint8Array): string {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  return Array.from(u8).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function bytesToBase64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
async function genKeypair(): Promise<{ pubHex: string; privKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { pubHex: bytesToHex(pubRaw), privKey: kp.privateKey };
}
async function sha256Hex(s: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return bytesToHex(new Uint8Array(hash));
}
async function signHex(privKey: CryptoKey, canonical: string): Promise<string> {
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privKey, new TextEncoder().encode(canonical));
  return bytesToHex(sig);
}
function nonce(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

/** A signed envelope whose `kind` we control (mechanism vs internet). */
async function buildEnvelope(kind: string) {
  const { pubHex, privKey } = await genKeypair();
  const n = nonce();
  const partial: Pick<AuditFillBody, "pointer" | "nonce" | "contextHash" | "commitment"> = {
    pointer: "arg://breath/navigate",
    nonce: n,
    contextHash: await sha256Hex("https://x.com:/:bucket"),
    commitment: await sha256Hex(`v:${n}`),
  };
  const signature = await signHex(privKey, auditSignedFragment(partial));
  return {
    pubHex,
    envelope: {
      kind,
      params: { ...partial, walletPubkey: pubHex, urlHash: await sha256Hex("https://x.com") },
      identity: `wallet:${pubHex}`,
      signature,
      signatureScheme: "ed25519-v7.0",
    },
  };
}

async function postCovenant(app: Hono, env: Env, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.fetch(
    new Request("http://test.local/v1/covenant", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ─── 2. Backend /v1/covenant — public-reject, aiko-key-allow ────────────────

describe("backend /v1/covenant — mechanism public-reject / aiko-allow", () => {
  test("public caller + mechanism action (observe:revealed_context) → unknown_op", async () => {
    const app = mountApp();
    const env = makeEnv();
    const { envelope } = await buildEnvelope("observe:revealed_context");

    const { status, json } = await postCovenant(app, env, envelope);
    expect(status).toBe(400);
    expect(json.error).toBe("unknown_op");
    // Opacity: no mechanism vocabulary leaks in the rejection.
    const blob = JSON.stringify(json);
    expect(blob).not.toContain("revealed_context");
    expect(blob).not.toContain("observe");
  });

  test("public caller + every mechanism action → unknown_op", async () => {
    const app = mountApp();
    const env = makeEnv();
    for (const m of MECHANISM_KINDS) {
      const { envelope } = await buildEnvelope(`observe:${m}`);
      const { status, json } = await postCovenant(app, env, envelope);
      expect(status).toBe(400);
      expect(json.error).toBe("unknown_op");
    }
  });

  test("aiko-key caller + mechanism action → allowed through (not unknown_op)", async () => {
    const app = mountApp();
    const env = makeEnv({ AIKO_KEY: "secret-aiko-key" });
    // `observe:recall_episode` — an aiko insider may dispatch it; it falls into
    // the observe eval-read path. The key point: NOT rejected as unknown_op.
    const { envelope } = await buildEnvelope("observe:recall_episode");
    const { json } = await postCovenant(app, env, envelope, {
      Authorization: "Bearer secret-aiko-key",
    });
    expect(json.error).not.toBe("unknown_op");
    // Insider sees the mechanism (kind/action) on success.
    if (json.ok === true) {
      expect(json.action).toBe("recall_episode");
    }
  });

  test("internet op (actuate:navigate) public caller → accepted (200, opaque)", async () => {
    const app = mountApp();
    const env = makeEnv();
    const { envelope } = await buildEnvelope("actuate:navigate");
    const { status, json } = await postCovenant(app, env, envelope);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.error).toBeUndefined();
  });
});

// ─── 3. leak-guard.sh — fails on planted leak, passes on clean tree ─────────

describe("leak-guard.sh — mechanism keyword gate", () => {
  function runGuard(): { code: number; out: string } {
    const r = spawnSync("bash", ["scripts/leak-guard.sh"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
  }

  test("clean tree → exit 0 (no mechanism keywords in source surface)", () => {
    const { code, out } = runGuard();
    expect(code).toBe(0);
    expect(out).toContain("no covenant mechanism keywords in source surface");
  }, 60_000);

  test("planted functional leak in src/ → exit 1 + names the file", () => {
    const probe = join(REPO_ROOT, "src", "__w34b_leak_probe__.ts");
    writeFileSync(probe, 'export const probe = "revealed_context";\n');
    try {
      const { code, out } = runGuard();
      expect(code).toBe(1);
      expect(out).toContain("MECHANISM LEAK");
      expect(out).toContain("__w34b_leak_probe__.ts");
      expect(out).toContain("revealed_context");
    } finally {
      rmSync(probe, { force: true });
    }
  }, 60_000);

  test("comment-only mention does NOT trip the guard (stripped from bundle)", () => {
    const probe = join(REPO_ROOT, "src", "__w34b_comment_probe__.ts");
    // A pure comment line — minification drops it; it must not fail the gate.
    writeFileSync(probe, '// this is NOT revealed_context, just a doc note\nexport const ok = 1;\n');
    try {
      const { code } = runGuard();
      expect(code).toBe(0);
    } finally {
      rmSync(probe, { force: true });
    }
  }, 60_000);
});
