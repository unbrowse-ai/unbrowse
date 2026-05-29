/**
 * v7.2.0-preview.0 settings-state — wire + verify + KV path.
 *
 * Day-3 Land worker B (2026-05-28). Mirrors v7-session-park.test.ts.
 *
 * Test coverage:
 *   T1. POST /v1/settings/set with literal:true → 200.
 *   T2. POST with raw value (no scheme) → 400 not_a_pointer.
 *   T3. POST with cleartext_value forbidden field → 400.
 *   T4. GET /v1/settings/get/:keyHash with valid sig → returns row.
 *   T5. Cross-wallet GET → 404 (structural isolation, same as session-state).
 *   T6. Idempotent re-POST.
 *   T7. Binding missing → 503 envelope.
 *
 * Prov 16:9 — preferences are deliberate.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { settingsStateRoutes } from "../src/routes/settings.js";
import {
  canonicalizeSignedFragment,
  canonicalDeleteChallenge,
  deriveSettingKeyHash,
  settingsPrimaryKey,
  type SettingsSetBody,
} from "../src/services/settings-state.js";
import type { Env } from "../src/types.js";

// ─── In-memory KV ──────────────────────────────────────────────────────────

interface MemoryKV extends KVNamespace {
  _dump(): Map<string, string>;
}

function makeMemoryKv(): MemoryKV {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async (opts?: { prefix?: string; limit?: number; cursor?: string }) => {
      const prefix = opts?.prefix ?? "";
      const limit = opts?.limit ?? 1000;
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .sort()
        .slice(0, limit)
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
    _dump: () => store,
  };
  return kv as unknown as MemoryKV;
}

function makeEnv(opts: { kv?: KVNamespace } = {}): Env {
  return {
    SETTINGS_STATE: opts.kv,
    STATS_KV: {} as KVNamespace,
    ENVIRONMENT: "local-test",
  } as unknown as Env;
}

function mountApp() {
  const app = new Hono();
  app.route("/", settingsStateRoutes);
  return app;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function bytesToHex(b: ArrayBuffer | Uint8Array): string {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  return Array.from(u8)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function genKeypair(): Promise<{ pubHex: string; privKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { pubHex: bytesToHex(pubRaw), privKey: kp.privateKey };
}

async function signFragmentHex(
  body: SettingsSetBody,
  privKey: CryptoKey,
): Promise<string> {
  const fragment = canonicalizeSignedFragment(body);
  const bytes = new TextEncoder().encode(fragment);
  const sigBuf = await crypto.subtle.sign({ name: "Ed25519" }, privKey, bytes);
  return bytesToHex(new Uint8Array(sigBuf));
}

async function signChallengeHex(
  keyHash: string,
  timestampMs: number,
  privKey: CryptoKey,
): Promise<string> {
  const message = `${keyHash}:${timestampMs}`;
  const bytes = new TextEncoder().encode(message);
  const sigBuf = await crypto.subtle.sign({ name: "Ed25519" }, privKey, bytes);
  return bytesToHex(new Uint8Array(sigBuf));
}

async function signDeleteChallengeHex(
  keyHash: string,
  timestampMs: number,
  privKey: CryptoKey,
): Promise<string> {
  const message = canonicalDeleteChallenge(keyHash, timestampMs);
  const bytes = new TextEncoder().encode(message);
  const sigBuf = await crypto.subtle.sign({ name: "Ed25519" }, privKey, bytes);
  return bytesToHex(new Uint8Array(sigBuf));
}

function randomNonceB64(): string {
  const u8 = new Uint8Array(32);
  crypto.getRandomValues(u8);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

async function makeValidBody(opts: {
  pubHex: string;
  privKey: CryptoKey;
  settingKey?: string;
  settingValuePointer?: string;
}): Promise<SettingsSetBody> {
  const draft: SettingsSetBody = {
    walletPubkey: opts.pubHex,
    signatureScheme: "ed25519-v7.0",
    signature: "00".repeat(64),
    nonce: randomNonceB64(),
    settingKey: opts.settingKey ?? "headless",
    settingValuePointer: opts.settingValuePointer ?? "literal:true",
  };
  draft.signature = await signFragmentHex(draft, opts.privKey);
  return draft;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("v7.2.0-preview.0 settings-state (T1) — literal: pointer accepted", () => {
  test("POST /v1/settings/set with literal:true returns 200", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const body = await makeValidBody({ pubHex, privKey });

    const res = await app.request(
      "/v1/settings/set",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(res.status).toBe(200);
    const ack = (await res.json()) as {
      ok: boolean;
      cacheKey: string;
      keyHash: string;
      verify_ok: boolean;
      idempotent: boolean;
      _binding_status: string;
    };
    expect(ack.ok).toBe(true);
    expect(ack.verify_ok).toBe(true);
    expect(ack._binding_status).toBe("wired");
    expect(ack.idempotent).toBe(false);
    expect(ack.cacheKey.length).toBe(32);
    expect(ack.keyHash.length).toBe(32);
    const expectedKeyHash = await deriveSettingKeyHash(body.settingKey);
    expect(ack.keyHash).toBe(expectedKeyHash);
  });
});

describe("v7.2.0-preview.0 settings-state (T2) — raw value rejected", () => {
  test("POST with settingValuePointer='hunter2' (no scheme) → 400 not_a_pointer", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const body = await makeValidBody({
      pubHex,
      privKey,
      settingValuePointer: "hunter2",
    });

    const res = await app.request(
      "/v1/settings/set",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(res.status).toBe(400);
    const ack = (await res.json()) as { error: string; field: string; reason: string };
    expect(ack.error).toBe("not_a_pointer");
    expect(ack.field).toBe("settingValuePointer");
    expect(kv._dump().size).toBe(0);
  });
});

describe("v7.2.0-preview.0 settings-state (T3) — cleartext_value forbidden", () => {
  test("POST body carrying cleartext_value is rejected with 400", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const valid = await makeValidBody({ pubHex, privKey });
    const tainted = { ...valid, cleartext_value: "hunter2" };

    const res = await app.request(
      "/v1/settings/set",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tainted),
      },
      env,
    );
    expect(res.status).toBe(400);
    const ack = (await res.json()) as { error: string; field: string };
    expect(ack.error).toBe("invalid_body");
    expect(ack.field.toLowerCase()).toBe("cleartext_value");
    expect(kv._dump().size).toBe(0);
  });
});

describe("v7.2.0-preview.0 settings-state (T4) — GET happy path", () => {
  test("GET /v1/settings/get/:keyHash with valid wallet sig returns row", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const body = await makeValidBody({ pubHex, privKey });

    const postRes = await app.request(
      "/v1/settings/set",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(postRes.status).toBe(200);
    const postAck = (await postRes.json()) as { keyHash: string };
    const keyHash = postAck.keyHash;

    const ts = Date.now();
    const sig = await signChallengeHex(keyHash, ts, privKey);
    const res = await app.request(
      `/v1/settings/get/${keyHash}`,
      {
        method: "GET",
        headers: {
          Authorization: `WalletSig ${sig}`,
          "X-Wallet-Pubkey": pubHex,
          "X-Wallet-Timestamp": String(ts),
        },
      },
      env,
    );
    expect(res.status).toBe(200);
    const ack = (await res.json()) as {
      ok: boolean;
      keyHash: string;
      row: { settingKey: string; settingValuePointer: string };
    };
    expect(ack.ok).toBe(true);
    expect(ack.row.settingKey).toBe(body.settingKey);
    expect(ack.row.settingValuePointer).toBe(body.settingValuePointer);
  });
});

describe("v7.2.0-preview.0 settings-state (T5) — cross-wallet → 404", () => {
  test("WALLET-A reading keyHash that WALLET-B wrote returns 404", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const walletA = await genKeypair();
    const walletB = await genKeypair();

    const bodyB = await makeValidBody({
      pubHex: walletB.pubHex,
      privKey: walletB.privKey,
    });
    const postRes = await app.request(
      "/v1/settings/set",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyB),
      },
      env,
    );
    expect(postRes.status).toBe(200);
    const postAck = (await postRes.json()) as { keyHash: string };
    const keyHash = postAck.keyHash;

    // Wallet-A signs a read challenge for the same keyHash.
    const ts = Date.now();
    const sigA = await signChallengeHex(keyHash, ts, walletA.privKey);
    const res = await app.request(
      `/v1/settings/get/${keyHash}`,
      {
        method: "GET",
        headers: {
          Authorization: `WalletSig ${sigA}`,
          "X-Wallet-Pubkey": walletA.pubHex,
          "X-Wallet-Timestamp": String(ts),
        },
      },
      env,
    );
    // Sig is valid (wallet-A is a real signer); KV key prefix
    // `settings:<walletA>:<keyHash>` has no row. 404 (structural,
    // same envelope as session-restore cross-wallet path).
    expect(res.status).toBe(404);
    const ack = (await res.json()) as { error: string };
    expect(ack.error).toBe("setting_not_found");
    // Sanity: wallet-B with same challenge DOES get its row.
    const sigB = await signChallengeHex(keyHash, ts, walletB.privKey);
    const resB = await app.request(
      `/v1/settings/get/${keyHash}`,
      {
        method: "GET",
        headers: {
          Authorization: `WalletSig ${sigB}`,
          "X-Wallet-Pubkey": walletB.pubHex,
          "X-Wallet-Timestamp": String(ts),
        },
      },
      env,
    );
    expect(resB.status).toBe(200);
  });
});

describe("v7.2.0-preview.0 settings-state (T6) — idempotent re-POST", () => {
  test("repeat POST of same body returns idempotent:true, same cacheKey", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const body = await makeValidBody({ pubHex, privKey });

    const res1 = await app.request(
      "/v1/settings/set",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(res1.status).toBe(200);
    const ack1 = (await res1.json()) as { cacheKey: string; idempotent: boolean };
    expect(ack1.idempotent).toBe(false);
    const sizeAfter = kv._dump().size;

    const res2 = await app.request(
      "/v1/settings/set",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(res2.status).toBe(200);
    const ack2 = (await res2.json()) as { cacheKey: string; idempotent: boolean };
    expect(ack2.cacheKey).toBe(ack1.cacheKey);
    expect(ack2.idempotent).toBe(true);
    expect(kv._dump().size).toBe(sizeAfter);
  });
});

describe("v7.2.0-preview.0 settings-state (T7) — binding missing → 503", () => {
  test("SETTINGS_STATE undefined → 503 envelope with _binding_missing", async () => {
    const env = makeEnv({ kv: undefined });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const body = await makeValidBody({ pubHex, privKey });

    const res = await app.request(
      "/v1/settings/set",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(res.status).toBe(503);
    const ack = (await res.json()) as {
      error: string;
      _binding_missing: string;
      _wave_hint: string;
    };
    expect(ack.error).toBe("settings_state_binding_missing");
    expect(ack._binding_missing).toBe("SETTINGS_STATE");
    expect(ack._wave_hint).toContain("SETTINGS_STATE");
  });
});

// ─── W24.7 — DELETE /v1/settings/:keyHash ──────────────────────────────────

describe("v7.2.0-preview.0 settings-state (T8) — DELETE valid sig on existing key", () => {
  test("DELETE removes the row and returns ok+deleted", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const body = await makeValidBody({ pubHex, privKey });

    const postRes = await app.request(
      "/v1/settings/set",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(postRes.status).toBe(200);
    const postAck = (await postRes.json()) as { keyHash: string };
    const keyHash = postAck.keyHash;
    expect(kv._dump().size).toBe(1);

    const ts = Date.now();
    const sig = await signDeleteChallengeHex(keyHash, ts, privKey);
    const res = await app.request(
      `/v1/settings/${keyHash}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `WalletSig ${sig}`,
          "X-Wallet-Pubkey": pubHex,
          "X-Wallet-Timestamp": String(ts),
        },
      },
      env,
    );
    expect(res.status).toBe(200);
    const ack = (await res.json()) as {
      ok: boolean;
      deleted: boolean;
      cacheKey: string;
    };
    expect(ack.ok).toBe(true);
    expect(ack.deleted).toBe(true);
    expect(ack.cacheKey).toBe(settingsPrimaryKey(pubHex, keyHash));
    expect(kv._dump().size).toBe(0);
  });
});

describe("v7.2.0-preview.0 settings-state (T9) — DELETE on missing key idempotent", () => {
  test("DELETE on absent row returns ok+idempotent (no error)", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();

    const keyHash = await deriveSettingKeyHash("never_written");
    const ts = Date.now();
    const sig = await signDeleteChallengeHex(keyHash, ts, privKey);
    const res = await app.request(
      `/v1/settings/${keyHash}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `WalletSig ${sig}`,
          "X-Wallet-Pubkey": pubHex,
          "X-Wallet-Timestamp": String(ts),
        },
      },
      env,
    );
    expect(res.status).toBe(200);
    const ack = (await res.json()) as {
      ok: boolean;
      deleted: boolean;
      idempotent: boolean;
    };
    expect(ack.ok).toBe(true);
    expect(ack.deleted).toBe(false);
    expect(ack.idempotent).toBe(true);
  });
});

describe("v7.2.0-preview.0 settings-state (T10) — DELETE without Authorization → 401", () => {
  test("DELETE missing Authorization header rejects with 401", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const keyHash = await deriveSettingKeyHash("anything");
    const ts = Date.now();

    const res = await app.request(
      `/v1/settings/${keyHash}`,
      {
        method: "DELETE",
        headers: {
          "X-Wallet-Pubkey": "00".repeat(32),
          "X-Wallet-Timestamp": String(ts),
        },
      },
      env,
    );
    expect(res.status).toBe(401);
    const ack = (await res.json()) as { error: string; reason: string };
    expect(ack.error).toBe("unauthorized");
    expect(ack.reason).toContain("WalletSig");
  });
});

describe("v7.2.0-preview.0 settings-state (T11) — DELETE with wrong wallet sig → 403", () => {
  test("WALLET-B signing over WALLET-A's existing row is rejected with 403", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const walletA = await genKeypair();
    const walletB = await genKeypair();

    // Wallet-A writes a row.
    const bodyA = await makeValidBody({
      pubHex: walletA.pubHex,
      privKey: walletA.privKey,
    });
    const postRes = await app.request(
      "/v1/settings/set",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyA),
      },
      env,
    );
    expect(postRes.status).toBe(200);
    const postAck = (await postRes.json()) as { keyHash: string };
    const keyHash = postAck.keyHash;
    const sizeBefore = kv._dump().size;
    expect(sizeBefore).toBe(1);

    // Wallet-B writes a row at the SAME settingKey (different KV
    // primary key because of the wallet prefix) so we can force a
    // wallet-mismatch on the structural row of wallet-A.
    //
    // The structural KV key for the DELETE on (walletB, keyHash) is
    // `settings:<walletB>:<keyHash>`. To exercise the wallet_mismatch
    // path in deleteSettingsRow, we hand-write a corrupt row under
    // wallet-B's prefix whose stored walletPubkey is wallet-A — same
    // defense-in-depth invariant the GET enforces.
    const primaryKeyB = settingsPrimaryKey(walletB.pubHex, keyHash);
    const corruptRow = {
      walletPubkey: walletA.pubHex,
      signatureScheme: "ed25519-v7.0",
      signature: bodyA.signature,
      nonce: bodyA.nonce,
      settingKey: bodyA.settingKey,
      settingValuePointer: bodyA.settingValuePointer,
      received_at: Date.now(),
      verify_ok: true,
      cacheKey: "00".repeat(16),
      keyHash,
    };
    await kv.put(primaryKeyB, JSON.stringify(corruptRow));

    // Wallet-B signs a valid DELETE challenge over the same keyHash.
    const ts = Date.now();
    const sigB = await signDeleteChallengeHex(keyHash, ts, walletB.privKey);
    const res = await app.request(
      `/v1/settings/${keyHash}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `WalletSig ${sigB}`,
          "X-Wallet-Pubkey": walletB.pubHex,
          "X-Wallet-Timestamp": String(ts),
        },
      },
      env,
    );
    expect(res.status).toBe(403);
    const ack = (await res.json()) as { error: string };
    expect(ack.error).toBe("wallet_mismatch");
    // Wallet-A's row must remain untouched.
    const rowA = await kv.get(settingsPrimaryKey(walletA.pubHex, keyHash));
    expect(rowA).not.toBeNull();
  });
});

describe("v7.2.0-preview.0 settings-state (T12) — DELETE under missing binding → 503", () => {
  test("SETTINGS_STATE undefined → 503 envelope on DELETE", async () => {
    const env = makeEnv({ kv: undefined });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const keyHash = await deriveSettingKeyHash("anything");
    const ts = Date.now();
    const sig = await signDeleteChallengeHex(keyHash, ts, privKey);

    const res = await app.request(
      `/v1/settings/${keyHash}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `WalletSig ${sig}`,
          "X-Wallet-Pubkey": pubHex,
          "X-Wallet-Timestamp": String(ts),
        },
      },
      env,
    );
    expect(res.status).toBe(503);
    const ack = (await res.json()) as {
      error: string;
      _binding_missing: string;
      _wave_hint: string;
    };
    expect(ack.error).toBe("settings_state_binding_missing");
    expect(ack._binding_missing).toBe("SETTINGS_STATE");
    expect(ack._wave_hint).toContain("SETTINGS_STATE");
  });
});
