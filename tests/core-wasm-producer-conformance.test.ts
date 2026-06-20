/**
 * Producer-conformance witness — the CLI's contract-declare PRODUCER side
 * (canonicalize + sign) routed through the single unbrowse-core Zig WASM
 * verifies on the backend.
 *
 * This proves the duplication-kill is sound:
 *   (a) canonicalizeViaWasm(body) === the existing TS canonicalization,
 *       byte-for-byte, across tricky vectors (escapes, unicode, null holes).
 *   (b) signViaWasm over a wallet's 64-byte SecretKey produces a 128-hex
 *       signature that the BACKEND's verifyDeclareSignature accepts.
 *   (c) end-to-end: a declare emitted by the real thin client (WASM canonical +
 *       WASM sign, via the real signer's withSecretKey) verifies on the backend.
 *
 * Hermetic: the wallet is pinned to a fresh temp UNBROWSE_WALLET_DIR so the
 * test never reads or writes the real user keychain.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalizeDeclareBody as backendCanonicalize,
  verifyDeclareSignature,
  type CanonicalDeclareBody,
} from "../backend/src/services/declare-signature";
import { canonicalizeViaWasm, signViaWasm } from "../src/lib/core-wasm";
import { createThinClient } from "../src/lib/contract-thin-client";
import { withSecretKey, getWalletPubkey, __internal } from "../src/values/signer";

let walletDir: string;
let prevWalletDir: string | undefined;

beforeAll(() => {
  prevWalletDir = process.env.UNBROWSE_WALLET_DIR;
  walletDir = mkdtempSync(join(tmpdir(), "ubrw-wasm-producer-"));
  process.env.UNBROWSE_WALLET_DIR = walletDir;
});

afterAll(() => {
  if (prevWalletDir === undefined) delete process.env.UNBROWSE_WALLET_DIR;
  else process.env.UNBROWSE_WALLET_DIR = prevWalletDir;
  try {
    rmSync(walletDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// Pure-TS reference (the exact bytes the backend signs/verifies over).
function canonicalTs(b: CanonicalDeclareBody): string {
  return JSON.stringify({
    plan: b.plan,
    action: b.action,
    parent_id: b.parent_id,
    agent: b.agent,
    wallet_identity: b.wallet_identity,
    ts: b.ts,
  });
}

const trickyBodies: CanonicalDeclareBody[] = [
  {
    plan: "resolve the route",
    action: "GET /v1/x",
    parent_id: null,
    agent: null,
    wallet_identity: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    ts: "2026-06-20T00:00:00Z",
  },
  {
    // escapes + control chars + unicode + non-null holes
    plan: 'a"b\\c\nd\tef',
    action: "emoji 😀 ünïcödé",
    parent_id: "par-1",
    agent: "agt",
    wallet_identity: "00",
    ts: "t",
  },
  {
    plan: "only parent",
    action: "x",
    parent_id: "p",
    agent: null,
    wallet_identity: "ab",
    ts: "2026-01-01",
  },
];

describe("core-wasm producer — canonicalize byte-identical to TS", () => {
  test("(a) canonicalizeViaWasm === TS canonicalization, byte-for-byte", () => {
    for (const body of trickyBodies) {
      const ts = canonicalTs(body);
      const wasm = canonicalizeViaWasm(body);
      expect(wasm).not.toBeNull();
      expect(wasm).toBe(ts);
      // Byte-level (not just JS string equality under normalization).
      const tb = new TextEncoder().encode(ts);
      const wb = new TextEncoder().encode(wasm!);
      expect(Array.from(wb)).toEqual(Array.from(tb));
      // And the WASM canonicalize agrees with the BACKEND canonicalize too,
      // so all three layers emit the identical signed bytes.
      expect(wasm).toBe(backendCanonicalize(body));
    }
  });
});

describe("core-wasm producer — WASM signature verifies on the backend", () => {
  test("(b) signViaWasm over the wallet SecretKey verifies under verifyDeclareSignature", async () => {
    // Derive wallet_identity from the SAME seed used to sign (the pubkey
    // embedded in the 64-byte SecretKey), so identity and signature can never
    // disagree even if signer.ts's process-wide pubkeyCache holds a value from
    // a different test's wallet dir (a pre-existing cross-file cache quirk).
    const ts = new Date().toISOString();
    const { wallet_identity, sigHex } = withSecretKey((sk64) => {
      expect(sk64.length).toBe(64);
      const wid = __internal.bytesToHex(sk64.slice(32)); // embedded pubkey
      const b: CanonicalDeclareBody = {
        plan: "wasm-signed declare",
        action: "agent-judges",
        parent_id: null,
        agent: "unbrowse-cli",
        wallet_identity: wid,
        ts,
      };
      const canonical = canonicalizeViaWasm(b);
      expect(canonical).not.toBeNull();
      return {
        wallet_identity: wid,
        sigHex: signViaWasm(new TextEncoder().encode(canonical!), sk64),
      };
    });
    expect(sigHex).not.toBeNull();
    expect(sigHex!.length).toBe(128); // 64-byte ed25519 sig, hex
    expect(wallet_identity.length).toBe(64); // 32-byte pubkey, hex

    const body: CanonicalDeclareBody = {
      plan: "wasm-signed declare",
      action: "agent-judges",
      parent_id: null,
      agent: "unbrowse-cli",
      wallet_identity,
      ts,
    };
    // The real witness: the BACKEND verifier accepts the WASM-produced sig.
    expect(await verifyDeclareSignature(body, sigHex!)).toBe(true);
    // Tamper → false.
    expect(await verifyDeclareSignature({ ...body, ts: "changed" }, sigHex!)).toBe(false);
  });
});

describe("core-wasm producer — end-to-end thin client declare (WASM path)", () => {
  test("(c) real thin-client declare (WASM canonical + WASM sign) verifies on backend", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
      if (url.pathname === "/v1/contract/declare") {
        captured = init?.body ? JSON.parse(init.body as string) : {};
        return new Response(JSON.stringify({ id: "feedface" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    // No signer override → the thin client loads the REAL signer (withSecretKey
    // present), so the declare canonicalizes + signs through the WASM core.
    const client = createThinClient({ baseUrl: "https://api.test.local", fetchImpl });
    const { id } = await client.declare({
      plan: "wasm e2e declare",
      action: "neuron",
      parent_id: "parent01",
      agent: "unbrowse-cli",
    });
    expect(id).toBe("feedface");

    const body = captured as {
      plan: string;
      action: string;
      parent_id?: string;
      agent?: string;
      wallet_identity: string;
      declare_signature: string;
      ts: string;
    };
    expect(body.wallet_identity.length).toBe(64);
    expect(body.declare_signature.length).toBe(128);

    const canonical: CanonicalDeclareBody = {
      plan: body.plan,
      action: body.action,
      parent_id: body.parent_id ?? null,
      agent: body.agent ?? null,
      wallet_identity: body.wallet_identity,
      ts: body.ts,
    };
    expect(await verifyDeclareSignature(canonical, body.declare_signature)).toBe(true);
  });

  test("(d) fallback — signer without withSecretKey signs via signBytes, still verifies", async () => {
    // A signer stub lacking withSecretKey forces the node:crypto signBytes
    // path; canonicalize still uses WASM. The declare must still verify, proving
    // signing never breaks when the WASM-sign route is unavailable.
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
      if (url.pathname === "/v1/contract/declare") {
        captured = init?.body ? JSON.parse(init.body as string) : {};
        return new Response(JSON.stringify({ id: "0ddba11" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    // Wrap the real signer but strip withSecretKey to force the signBytes path.
    const { signBytes } = await import("../src/values/signer");
    const client = createThinClient({
      baseUrl: "https://api.test.local",
      fetchImpl,
      signer: { getWalletPubkey, signBytes }, // no withSecretKey
    });
    await client.declare({ plan: "signbytes fallback", action: "neuron" });

    const body = captured as {
      plan: string;
      action: string;
      wallet_identity: string;
      declare_signature: string;
      ts: string;
    };
    expect(body.declare_signature.length).toBe(128);
    const canonical: CanonicalDeclareBody = {
      plan: body.plan,
      action: body.action,
      parent_id: null,
      agent: null,
      wallet_identity: body.wallet_identity,
      ts: body.ts,
    };
    expect(await verifyDeclareSignature(canonical, body.declare_signature)).toBe(true);
  });
});
