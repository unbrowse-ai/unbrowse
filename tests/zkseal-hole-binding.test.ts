/**
 * Layer-2 (zkseal) witness — wiring the real ZK credential binding into the
 * capture-hole path. Grows seam by seam across the loop's EXECUTE days.
 *
 * DAY 3 (land — the seed): Seam 2, the binding mint. Prove zkBindKnownSecrets:
 *   (a) keys each binding by the SAME sha16 the redactor stamps (`bindingTag` →
 *       `[bound:<sha16>]`), so it can later join to the hole's placeholder;
 *   (b) mints a REAL binding that round-trips: verifyBinding(binding, proveHole)
 *       confirms knowledge of the bound secret WITHOUT the secret being present;
 *   (c) a wrong secret's proof fails against the binding (no forgery).
 */
import { describe, it, expect } from "bun:test";
import { getWalletPubkey } from "../src/values/signer.js";
import { bindingTag } from "../src/capture/wallet-bind.js";
import { zkBindKnownSecrets, proveHole, verifyHoleAttested, verifyHoleProof } from "../src/capture/zk-bound-hole.js";
import { verifyBinding } from "../src/values/zk-binding.js";
import { obfuscateRequestForReveng } from "../src/capture/obfuscate.js";
import { extractHoles } from "../src/capture/hole-template.js";
import type { RawRequest } from "../src/capture/index.js";

const enc = new TextEncoder();

/** A request carrying a known secret in the Authorization header. */
function reqWithSecret(secret: string): RawRequest {
  return {
    method: "GET",
    url: "https://api.example.com/v1/me",
    request_headers: { authorization: `Bearer ${secret}` },
    request_body: undefined,
    response_headers: {},
    response_body: undefined,
  } as RawRequest;
}

describe("zkseal Seam 2 — the binding mint (Day 3 seed)", () => {
  it("keys each binding by the same sha16 the redactor stamps", async () => {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const secret = "sk-live-abcdef0123456789";
    const map = await zkBindKnownSecrets([secret], wallet);

    const sha16 = bindingTag(secret, wallet).slice("bound:".length); // the join key
    expect(Object.keys(map)).toEqual([sha16]);
    expect(map[sha16].y).toMatch(/^[0-9a-f]+$/);
    expect(map[sha16].root).toBe(wallet); // bound to THIS wallet
    expect(map[sha16].sig.length).toBeGreaterThan(0);
  });

  it("the minted binding round-trips: holder proves knowledge, secret never present", async () => {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const secret = "session=9f8e7d6c5b4a3210";
    const map = await zkBindKnownSecrets([secret], wallet);
    const sha16 = bindingTag(secret, wallet).slice("bound:".length);

    const proof = proveHole(enc.encode(secret)); // holder proves with the real secret
    expect(verifyBinding(map[sha16], proof)).toBe(true);
    // the proof carries no secret bytes
    expect(JSON.stringify(proof)).not.toContain(secret);
  });

  it("a wrong secret cannot forge a proof for the binding", async () => {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const secret = "api_key=correct-horse-battery";
    const map = await zkBindKnownSecrets([secret], wallet);
    const sha16 = bindingTag(secret, wallet).slice("bound:".length);

    const forged = proveHole(enc.encode("api_key=wrong-guess"));
    expect(verifyBinding(map[sha16], forged)).toBe(false);
  });

  it("dedupes repeated secrets and skips empties in one pass", async () => {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const map = await zkBindKnownSecrets(["dup-secret", "dup-secret", ""], wallet);
    expect(Object.keys(map).length).toBe(1);
  });
});

describe("zkseal Seam 1+3 — end-to-end binding through the capture-hole path (Day 4 lights)", () => {
  it("obfuscate → mint → extractHoles upgrades Hole.bound to a real zkbind tag, reviving verifyHoleAttested", async () => {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const secret = "tok-1234567890abcdef";
    const sink = new Set<string>();
    const skeleton = obfuscateRequestForReveng(reqWithSecret(secret), { walletPubkey: wallet, secrets: [secret], boundSink: sink });
    const bindings = await zkBindKnownSecrets([...sink], wallet);

    const { holes } = extractHoles(skeleton, bindings);
    const authHole = holes.find((h) => h.name === "authorization");
    expect(authHole).toBeDefined();
    // Hole.bound is now the REAL binding, not the bare commitment
    expect(authHole!.bound?.startsWith("zkbind:")).toBe(true);
    // the dead backend check is alive: the wallet really bound this slot
    expect(verifyHoleAttested(authHole!)).toBe(true);
  });

  it("the holder proves knowledge of the bound secret at fill time (verifyHoleProof), secret never transmitted", async () => {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const secret = "tok-fill-time-proof-99";
    const sink = new Set<string>();
    const skeleton = obfuscateRequestForReveng(reqWithSecret(secret), { walletPubkey: wallet, secrets: [secret], boundSink: sink });
    const bindings = await zkBindKnownSecrets([...sink], wallet);
    const authHole = extractHoles(skeleton, bindings).holes.find((h) => h.name === "authorization")!;

    // At fill time the holder fills the hole with the vault value (the exact
    // string that was bound, e.g. the full `Bearer <tok>` header) and proves
    // knowledge of it — the secret bytes never leave.
    const boundValue = [...sink][0];
    const proof = proveHole(enc.encode(boundValue));
    expect(verifyHoleProof(authHole, proof)).toBe(true);
    // a wrong value cannot satisfy the same hole
    expect(verifyHoleProof(authHole, proveHole(enc.encode("Bearer tok-wrong")))).toBe(false);
  });

  it("a foreign wallet's binding does not match this wallet's commitment sha16 (no cross-owner correlation)", async () => {
    const wallet = Buffer.from(await getWalletPubkey()).toString("hex");
    const secret = "tok-owner-bound";
    const sink = new Set<string>();
    const skeleton = obfuscateRequestForReveng(reqWithSecret(secret), { walletPubkey: wallet, secrets: [secret], boundSink: sink });
    // a binding map minted under a DIFFERENT wallet pubkey → different sha16 keys
    const foreign = "00".repeat(32);
    const foreignBindings = await zkBindKnownSecrets([...sink], foreign);

    const authHole = extractHoles(skeleton, foreignBindings).holes.find((h) => h.name === "authorization")!;
    // no matching sha16 → no upgrade → stays the bare commitment, attestation stays closed
    expect(authHole.bound?.startsWith("zkbind:")).toBe(false);
    expect(verifyHoleAttested(authHole)).toBe(false);
  });

  it("no-wallet path falls back to the commitment unchanged (backward compatible)", () => {
    const secret = "tok-no-wallet";
    const skeleton = obfuscateRequestForReveng(reqWithSecret(secret), { secrets: [secret] }); // no walletPubkey
    const { holes } = extractHoles(skeleton); // no bindings
    const authHole = holes.find((h) => h.name === "authorization");
    // obfuscation without a wallet emits [REDACTED], not a bound tag — still a hole, no zk
    expect(authHole).toBeDefined();
    expect(authHole!.bound?.startsWith("zkbind:")).toBeFalsy();
    expect(verifyHoleAttested(authHole!)).toBe(false);
  });
});
