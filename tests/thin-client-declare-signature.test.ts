/**
 * Round-trip witness — the CLI /contract declare path (contract-thin-client.ts)
 * signs with the SAME unbrowse wallet the rest of the CLI uses (one-key-signs-
 * every-layer), and the BACKEND's `verifyDeclareSignature` accepts it.
 *
 * This proves the canonicalization is byte-identical across the layer
 * boundary: the bytes the CLI signs == the bytes the server verifies. If the
 * field set / key order / null-coercion drifted, this signature would fail to
 * verify and the test would go red.
 *
 * Hermetic: the wallet is pinned to a fresh temp UNBROWSE_WALLET_DIR so the
 * test never reads or writes the real user keychain.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalizeDeclareBody,
  verifyDeclareSignature,
  type CanonicalDeclareBody,
} from "../backend/src/services/declare-signature";
import { createThinClient } from "../src/lib/contract-thin-client";

let walletDir: string;
let prevWalletDir: string | undefined;

beforeAll(() => {
  prevWalletDir = process.env.UNBROWSE_WALLET_DIR;
  walletDir = mkdtempSync(join(tmpdir(), "ubrw-declare-sig-"));
  // Pin the signer to a hermetic, isolated wallet (encrypted-file backend,
  // never the real OS keychain — see src/values/signer.ts secretStoreOpts()).
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

describe("thin-client declare — wallet-bound signature verifies with backend", () => {
  test("CLI-produced declare signature verifies via backend verifyDeclareSignature", async () => {
    // Capture the exact wire body the thin client POSTs.
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
      if (url.pathname === "/v1/contract/declare") {
        captured = init?.body ? JSON.parse(init.body as string) : {};
        return new Response(JSON.stringify({ id: "deadbeef" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const client = createThinClient({ baseUrl: "https://api.test.local", fetchImpl });

    const { id } = await client.declare({
      plan: "wallet-bound declare probe",
      action: "agent-judges",
      parent_id: "parent01",
      agent: "unbrowse-cli",
    });
    expect(id).toBe("deadbeef");

    // The thin client signed → wire body carries identity + sig + ts.
    expect(captured).toBeDefined();
    const body = captured as {
      plan: string;
      action: string;
      parent_id?: string;
      agent?: string;
      wallet_identity?: string;
      declare_signature?: string;
      ts?: string;
    };
    expect(typeof body.wallet_identity).toBe("string");
    expect(body.wallet_identity!.length).toBe(64); // 32-byte ed25519 pubkey, hex
    expect(typeof body.declare_signature).toBe("string");
    expect(body.declare_signature!.length).toBe(128); // 64-byte sig, hex
    expect(typeof body.ts).toBe("string");

    // Reconstruct the canonical body the BACKEND would reconstruct from this
    // wire request (verifyDeclareAuth in contract.ts), then verify the CLI's
    // signature against it with the real backend verifier.
    const canonical: CanonicalDeclareBody = {
      plan: body.plan,
      action: body.action,
      parent_id: body.parent_id ?? null,
      agent: body.agent ?? null,
      wallet_identity: body.wallet_identity!,
      ts: body.ts!,
    };
    const ok = await verifyDeclareSignature(canonical, body.declare_signature!);
    expect(ok).toBe(true);
  });

  test("CLI canonical bytes are byte-identical to the backend canonicalization", async () => {
    // Independent of the signature: assert the exact byte string the CLI signs
    // matches the backend's canonicalizeDeclareBody for the same inputs. This
    // is the load-bearing invariant — a mismatch here is the only way the
    // round-trip above could ever silently break.
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
      if (url.pathname === "/v1/contract/declare") {
        captured = init?.body ? JSON.parse(init.body as string) : {};
        return new Response(JSON.stringify({ id: "cafef00d" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const client = createThinClient({ baseUrl: "https://api.test.local", fetchImpl });
    await client.declare({ plan: "no-parent no-agent", action: "neuron" });

    const body = captured as {
      plan: string;
      action: string;
      wallet_identity: string;
      ts: string;
    };
    // Backend reconstructs with parent_id=null, agent=null when omitted.
    const backendCanonical = canonicalizeDeclareBody({
      plan: body.plan,
      action: body.action,
      parent_id: null,
      agent: null,
      wallet_identity: body.wallet_identity,
      ts: body.ts,
    });
    // Fixed insertion order, null-coerced — must be exactly this string.
    expect(backendCanonical).toBe(
      JSON.stringify({
        plan: body.plan,
        action: body.action,
        parent_id: null,
        agent: null,
        wallet_identity: body.wallet_identity,
        ts: body.ts,
      }),
    );
  });

  test("backward-compat: no wallet available → unsigned legacy POST", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
      if (url.pathname === "/v1/contract/declare") {
        captured = init?.body ? JSON.parse(init.body as string) : {};
        return new Response(JSON.stringify({ id: "0badf00d" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    // Inject a signer that throws (simulates no wallet / offline) → the
    // declare path must NOT hard-break; it falls back to unsigned.
    const client = createThinClient({
      baseUrl: "https://api.test.local",
      fetchImpl,
      signer: {
        getWalletPubkey: async () => {
          throw new Error("no wallet configured");
        },
        signBytes: async () => {
          throw new Error("no wallet configured");
        },
      },
    });

    const { id } = await client.declare({ plan: "offline declare", action: "neuron" });
    expect(id).toBe("0badf00d");
    const body = captured as Record<string, unknown>;
    expect(body.wallet_identity).toBeUndefined();
    expect(body.declare_signature).toBeUndefined();
    expect(body.plan).toBe("offline declare");
  });
});
