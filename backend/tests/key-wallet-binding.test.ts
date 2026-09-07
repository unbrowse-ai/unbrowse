/**
 * Witness for the web3-PK auth re-root, increment 1: the api_key ↔ wallet-pubkey
 * binding (the key is the web2 wrapper; the PK is the root). Additive + backward-
 * compatible — the request path (bearerAuth) is untouched, so existing keys +
 * agent_ids are unaffected; an unbound key behaves exactly like an unfunded one.
 *   bun test backend/tests/key-wallet-binding.test.ts
 */
import { describe, it, expect } from "bun:test";
import {
  generateLocalKey,
  createLocalKey,
  revokeLocalKey,
  verifyLocalKey,
  getKeyWallet,
  setKeyWallet,
  keyIdForPubkey,
  clearKeyWallet,
} from "../src/services/keys.js";
import type { Env } from "../src/types.js";

const env = { ENVIRONMENT: "local-dev" } as unknown as Env;
let seq = 0;
const uniqPk = () => `Pk${Date.now()}${seq++}`;

describe("key↔pubkey binding (web3-PK root, additive + backward-compatible)", () => {
  it("an unbound key returns null (backward-compatible: like an unfunded key)", async () => {
    const { keyId } = generateLocalKey();
    expect(await getKeyWallet(env, keyId)).toBeNull();
  });

  it("binds, reads back, and reverse-resolves to the SAME agent (the key wraps the PK)", async () => {
    const { keyId } = generateLocalKey();
    const pk = uniqPk();
    await setKeyWallet(env, keyId, pk);
    expect((await getKeyWallet(env, keyId))?.wallet_pubkey).toBe(pk);
    expect(await keyIdForPubkey(env, pk)).toBe(keyId); // signature-auth → same agent_id as the key
  });

  it("clearKeyWallet drops both the binding and the reverse index", async () => {
    const { keyId } = generateLocalKey();
    const pk = uniqPk();
    await setKeyWallet(env, keyId, pk);
    await clearKeyWallet(env, keyId);
    expect(await getKeyWallet(env, keyId)).toBeNull();
    expect(await keyIdForPubkey(env, pk)).toBeNull();
  });

  it("revokeLocalKey also clears the wallet binding (no orphaned reverse index)", async () => {
    const { keyId } = await createLocalKey(env, "binding-revoke-test");
    const pk = uniqPk();
    await setKeyWallet(env, keyId, pk);
    expect(await revokeLocalKey(env, keyId)).toBe(true);
    expect(await getKeyWallet(env, keyId)).toBeNull();
    expect(await keyIdForPubkey(env, pk)).toBeNull();
  });

  // Judgement-step adversarial guard: a pubkey bound to one key cannot be hijacked
  // by another (else the victim's signatures would resolve to the attacker's agent).
  it("HIJACK PREVENTION: a pubkey owned by one key cannot be re-bound by another", async () => {
    const victim = generateLocalKey();
    const attacker = generateLocalKey();
    const pk = uniqPk();
    expect(await setKeyWallet(env, victim.keyId, pk)).not.toBeNull(); // victim binds
    expect(await setKeyWallet(env, attacker.keyId, pk)).toBeNull(); // attacker refused
    expect(await keyIdForPubkey(env, pk)).toBe(victim.keyId); // still resolves to the victim
  });

  it("a key may rebind ITSELF to a new pubkey (stale reverse index cleared)", async () => {
    const { keyId } = generateLocalKey();
    const pk1 = uniqPk();
    const pk2 = uniqPk();
    await setKeyWallet(env, keyId, pk1);
    expect(await setKeyWallet(env, keyId, pk2)).not.toBeNull(); // same key → allowed
    expect(await keyIdForPubkey(env, pk1)).toBeNull(); // old binding cleared
    expect(await keyIdForPubkey(env, pk2)).toBe(keyId);
  });

  // The luminary (Mt 7:24-25): the binding must be INVISIBLE to the auth path —
  // binding a wallet may not change how the key authenticates. If a future edit
  // ever lets the binding bleed into the key record verifyLocalKey reads, this fails.
  it("binding a wallet does NOT change how the key authenticates (backward-compat)", async () => {
    const { key, keyId } = await createLocalKey(env, "backcompat-auth");
    const before = await verifyLocalKey(env, key);
    expect(before.valid).toBe(true);
    expect(before.keyId).toBe(keyId);
    await setKeyWallet(env, keyId, uniqPk());
    const after = await verifyLocalKey(env, key); // still valid, same agent, after binding
    expect(after.valid).toBe(true);
    expect(after.keyId).toBe(keyId);
  });
});
