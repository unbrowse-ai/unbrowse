/**
 * v7-covenant-opacity (W33-C, 2026-05-28) — the opaque unbrowse↔aiko boundary.
 *
 * Mark 4:11 — *"the mystery to you; parables to them without."* These tests
 * prove the covenant MECHANISM (the 3-verb river actuate/observe/build + the
 * scripture witnesses verse:...) NEVER crosses the unbrowse egress wire, never
 * lands in the public API response, and never appears in the logs.
 *
 * No mocks of the surface under test — real Web Crypto Ed25519, real in-process
 * Hono app, real captured fetch (the proxy is a captured fetchImpl, an honest
 * HTTP twin). CLAUDE.md: never mock the network.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { covenantRoutes } from "../src/routes/covenant.js";
import {
  mirrorToCovenantLedger,
  type MirrorableReceipt,
} from "../src/services/covenant-peer.js";
import {
  canonicalizeSignedFragment as auditSignedFragment,
  type AuditFillBody,
} from "../src/services/audit.js";
import type { Env } from "../src/types.js";

// ─── In-memory KVNamespace (Map-backed) ────────────────────────────────────

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

// ─── Crypto helpers ─────────────────────────────────────────────────────────

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

/** Build a valid actuate:navigate envelope (real signature). */
async function buildNavEnvelope() {
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
      kind: "actuate:navigate",
      params: { ...partial, walletPubkey: pubHex, urlHash: await sha256Hex("https://x.com") },
      identity: `wallet:${pubHex}`,
      signature,
      signatureScheme: "ed25519-v7.0",
    },
  };
}

async function postCovenant(
  app: Hono,
  env: Env,
  body: unknown,
  headers: Record<string, string> = {},
) {
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

// ─── 1. Egress wire: NO covenant verb, NO scripture ─────────────────────────

describe("opacity — egress wire to aiko proxy", () => {
  test("POST body carries op_class/op_kind, NOT kind:actuate / witness:verse", async () => {
    const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      captured.push({ url: u, body: init?.body ? JSON.parse(init.body as string) : {} });
      return new Response(JSON.stringify({ receipt_ptr: "sha256:opaque" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const receipt: MirrorableReceipt = {
      kind: "actuate", // internal verb — must be STRIPPED
      action: "navigate",
      params: { pointer: "arg://breath/navigate", walletPubkey: "ab".repeat(32) },
      witness: "verse:Genesis 1:3", // scripture — must be STRIPPED
      identity: "wallet:" + "ab".repeat(32),
      covenantReceiptPtr: "sha256:shared",
      sig: "ff".repeat(32),
    };

    await mirrorToCovenantLedger({ AIKO_OP_URL: "http://aiko.local" }, receipt, {
      fetchImpl: fakeFetch,
    });

    expect(captured.length).toBe(1);
    expect(captured[0].url.endsWith("/op")).toBe(true);
    const sent = captured[0].body;

    // Present (opaque, unbrowse-native).
    expect(sent.op_class).toBe("action");
    expect(sent.op_kind).toBe("navigate");
    expect(sent.unbrowse_receipt_ptr).toBe("sha256:shared");

    // Absent (mechanism).
    expect(sent.kind).toBeUndefined();
    expect(sent.witness).toBeUndefined();

    // The whole serialized payload must contain NO covenant vocabulary.
    const wire = JSON.stringify(sent);
    for (const banned of ["actuate", "observe", "build", "verse:", "Genesis", "witness"]) {
      expect(wire).not.toContain(banned);
    }
  });

  test("op_class maps observe→read, build→declare (verb never on wire)", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fakeFetch = (async (_u: unknown, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(init.body as string) : {});
      return new Response(JSON.stringify({ receipt_ptr: "sha256:x" }), { status: 200 });
    }) as unknown as typeof fetch;

    for (const [kind, expectedClass] of [
      ["observe", "read"],
      ["build", "declare"],
    ] as const) {
      await mirrorToCovenantLedger(
        { AIKO_OP_URL: "http://aiko.local" },
        {
          kind,
          action: "x",
          params: {},
          witness: "verse:Genesis 1:11",
          identity: "wallet:" + "cd".repeat(32),
          covenantReceiptPtr: "sha256:y",
        },
        { fetchImpl: fakeFetch },
      );
    }
    expect(bodies[0].op_class).toBe("read");
    expect(bodies[1].op_class).toBe("declare");
    for (const b of bodies) {
      const wire = JSON.stringify(b);
      expect(wire).not.toContain("observe");
      expect(wire).not.toContain("build");
      expect(wire).not.toContain("verse:");
    }
  });
});

// ─── 2. Public API response: OPAQUE (no kind/action) ────────────────────────

describe("opacity — /v1/covenant public response", () => {
  test("public caller (no aiko key) → {ok,receiptId,covenantReceiptPtr}, no kind/action", async () => {
    const app = mountApp();
    const env = makeEnv();
    const { envelope } = await buildNavEnvelope();

    const { status, json } = await postCovenant(app, env, envelope);

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(typeof json.receiptId).toBe("string");
    expect((json.covenantReceiptPtr as string).startsWith("sha256:")).toBe(true);
    expect(json.kind).toBeUndefined();
    expect(json.action).toBeUndefined();

    const blob = JSON.stringify(json);
    expect(blob).not.toContain("actuate");
    expect(blob).not.toContain("navigate");
  });

  test("unknown kind → generic unknown_op (no actuate|observe|build vocabulary)", async () => {
    const app = mountApp();
    const env = makeEnv();
    const { pubHex, privKey } = await genKeypair();
    const n = nonce();
    const partial = {
      pointer: "arg://breath/navigate",
      nonce: n,
      contextHash: await sha256Hex("x"),
      commitment: await sha256Hex(`v:${n}`),
    };
    const signature = await signHex(privKey, auditSignedFragment(partial));

    const { status, json } = await postCovenant(app, env, {
      kind: "destroy:everything",
      params: { ...partial, walletPubkey: pubHex },
      identity: `wallet:${pubHex}`,
      signature,
    });

    expect(status).toBe(400);
    expect(json.error).toBe("unknown_op");
    const blob = JSON.stringify(json);
    expect(blob).not.toContain("actuate");
    expect(blob).not.toContain("observe");
    expect(blob).not.toContain("build");
  });
});

// ─── 3. Aiko-key present → full mechanism returns ───────────────────────────

describe("opacity — aiko-key insider sees the mechanism", () => {
  test("Bearer AIKO_KEY → response carries kind/action", async () => {
    const app = mountApp();
    const env = makeEnv({ AIKO_KEY: "secret-aiko-key" });
    const { envelope } = await buildNavEnvelope();

    const { status, json } = await postCovenant(app, env, envelope, {
      Authorization: "Bearer secret-aiko-key",
    });

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.kind).toBe("actuate");
    expect(json.action).toBe("navigate");
  });

  test("ADMIN_KEY is also accepted as an insider token", async () => {
    const app = mountApp();
    const env = makeEnv({ ADMIN_KEY: "admin-secret" });
    const { envelope } = await buildNavEnvelope();

    const { json } = await postCovenant(app, env, envelope, {
      Authorization: "Bearer admin-secret",
    });
    expect(json.kind).toBe("actuate");
    expect(json.action).toBe("navigate");
  });

  test("wrong key → still stripped (public)", async () => {
    const app = mountApp();
    const env = makeEnv({ AIKO_KEY: "secret-aiko-key" });
    const { envelope } = await buildNavEnvelope();

    const { json } = await postCovenant(app, env, envelope, {
      Authorization: "Bearer wrong-key",
    });
    expect(json.ok).toBe(true);
    expect(json.kind).toBeUndefined();
    expect(json.action).toBeUndefined();
  });
});

// ─── 4. Logs: NO mechanism ──────────────────────────────────────────────────

describe("opacity — logs carry no mechanism", () => {
  test("no-op warn log contains no covenant verb / scripture / kind", async () => {
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const result = await mirrorToCovenantLedger(
        {}, // no proxy → no-op warn path
        {
          kind: "actuate",
          action: "navigate",
          params: {},
          witness: "verse:Genesis 1:3",
          identity: "wallet:" + "ab".repeat(32),
          covenantReceiptPtr: "sha256:no-proxy",
        },
      );
      expect(result.skipped).toBe(true);
    } finally {
      console.warn = orig;
    }
    const all = lines.join("\n");
    expect(all.length).toBeGreaterThan(0); // it DID log (honesty)
    for (const banned of ["actuate", "observe", "build", "verse:", "Genesis", "witness"]) {
      expect(all).not.toContain(banned);
    }
    // op_class + the opaque ptr ARE allowed.
    expect(all).toContain("action");
    expect(all).toContain("sha256:no-proxy");
  });

  test("proxy-failure warn log contains no mechanism", async () => {
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    const failFetch = (async () => new Response("denied", { status: 500 })) as unknown as typeof fetch;
    try {
      await mirrorToCovenantLedger(
        { AIKO_OP_URL: "http://aiko.local" },
        {
          kind: "build",
          action: "skill",
          params: {},
          witness: "verse:Genesis 1:11",
          identity: "wallet:" + "ab".repeat(32),
          covenantReceiptPtr: "sha256:fail-ptr",
        },
        { fetchImpl: failFetch },
      );
    } finally {
      console.warn = orig;
    }
    const all = lines.join("\n");
    for (const banned of ["build", "observe", "actuate", "verse:", "Genesis", "witness"]) {
      expect(all).not.toContain(banned);
    }
    expect(all).toContain("sha256:fail-ptr");
  });
});

// ─── 5. Graceful no-op when AIKO_OP_URL unset ───────────────────────────────

describe("opacity — graceful no-op", () => {
  test("no proxy configured → skipped, no fetch", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const result = await mirrorToCovenantLedger(
      {}, // no AIKO_OP_URL / COVENANT_LEDGER_URL / PEER_URLS
      {
        kind: "observe",
        action: "snap",
        params: {},
        witness: "verse:Genesis 1:4",
        identity: "wallet:" + "ef".repeat(32),
        covenantReceiptPtr: "sha256:none",
      },
      { fetchImpl: fakeFetch },
    );

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(called).toBe(false);
  });
});
