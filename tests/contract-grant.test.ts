/**
 * contract-grant witness — /contract NATIVE relationships + permissions between aiko identities.
 * Real node:crypto ed25519 (no fabricated green): a forged/tampered grant FAILS the permission check
 * at the signature, a granted reader passes, and ungranted/revoked/expired/wrong-scope are denied with
 * explicit reasons. Two aikos see each other's data ONLY per a grant that cryptographically traces
 * to the granter.
 */
import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { canRead, canonicalGrant, type ContractGrant } from "../src/values/contract-grant.ts";

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { id: publicKey.export({ type: "spki", format: "der" }).toString("hex"), privateKey };
}

function signGrant(g: Omit<ContractGrant, "signature">, privateKey: ReturnType<typeof identity>["privateKey"]): ContractGrant {
  const signature = sign(null, Buffer.from(canonicalGrant(g)), privateKey).toString("hex");
  return { ...g, signature };
}

describe("contract-grant — native /contract auth between aikos", () => {
  const granter = identity();
  const reader = identity();
  const stranger = identity();
  const NOW = 1_900_000_000_000;

  it("GRANTED: a reader with a valid signed grant for the scope can read", () => {
    const grant = signGrant({ granter: granter.id, grantee: reader.id, scope: "contract:abc", expires: null }, granter.privateKey);
    const r = canRead({ reader: reader.id, requestedScope: "contract:abc", grants: [grant], nowMs: NOW });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("granted");
  });

  it("NO GRANT: a stranger with no matching grant is denied", () => {
    const grant = signGrant({ granter: granter.id, grantee: reader.id, scope: "contract:abc", expires: null }, granter.privateKey);
    const r = canRead({ reader: stranger.id, requestedScope: "contract:abc", grants: [grant], nowMs: NOW });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("no_grant");
  });

  it("FORGED (load-bearing): a tampered signature fails the native ed25519 check", () => {
    const grant = signGrant({ granter: granter.id, grantee: reader.id, scope: "contract:abc", expires: null }, granter.privateKey);
    const forged: ContractGrant = { ...grant, scope: "contract:SECRET" }; // sig is over the ORIGINAL scope
    const r = canRead({ reader: reader.id, requestedScope: "contract:SECRET", grants: [forged], nowMs: NOW });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("bad_signature");
  });

  it("FORGED: a grant signed by the WRONG key (not the claimed granter) fails", () => {
    const grant = signGrant({ granter: granter.id, grantee: reader.id, scope: "contract:abc", expires: null }, stranger.privateKey);
    const r = canRead({ reader: reader.id, requestedScope: "contract:abc", grants: [grant], nowMs: NOW });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("bad_signature");
  });

  it("REVOKED + EXPIRED are denied with explicit reasons", () => {
    const base = { granter: granter.id, grantee: reader.id, scope: "contract:abc" };
    const revoked = { ...signGrant({ ...base, expires: null }, granter.privateKey), revoked: true };
    const expired = signGrant({ ...base, expires: NOW - 1 }, granter.privateKey);
    expect(canRead({ reader: reader.id, requestedScope: "contract:abc", grants: [revoked], nowMs: NOW }).reason).toBe("revoked");
    expect(canRead({ reader: reader.id, requestedScope: "contract:abc", grants: [expired], nowMs: NOW }).reason).toBe("expired");
  });

  it("SCOPE: a wildcard grant covers the prefix; an out-of-scope request is denied", () => {
    const wild = signGrant({ granter: granter.id, grantee: reader.id, scope: "skill:*", expires: null }, granter.privateKey);
    expect(canRead({ reader: reader.id, requestedScope: "skill:flights", grants: [wild], nowMs: NOW }).allowed).toBe(true);
    expect(canRead({ reader: reader.id, requestedScope: "contract:other", grants: [wild], nowMs: NOW }).reason).toBe("scope_mismatch");
  });

  it("LINEAGE: a grant to lineage:<root> lets a descendant read", () => {
    const grant = signGrant({ granter: granter.id, grantee: "lineage:root-x", scope: "contract:abc", expires: null }, granter.privateKey);
    const r = canRead({ reader: reader.id, readerLineage: ["root-x"], requestedScope: "contract:abc", grants: [grant], nowMs: NOW });
    expect(r.allowed).toBe(true);
  });
});
