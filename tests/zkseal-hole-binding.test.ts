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
import { zkBindKnownSecrets, proveHole } from "../src/capture/zk-bound-hole.js";
import { verifyBinding } from "../src/values/zk-binding.js";

const enc = new TextEncoder();

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
