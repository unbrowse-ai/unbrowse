/**
 * contract-grant witness — /contract NATIVE relationships + permissions between aiko identities.
 * Real node:crypto ed25519 (no fabricated green): a forged/tampered grant FAILS the permission check
 * at the signature, a granted reader passes, and ungranted/revoked/expired/wrong-scope are denied with
 * explicit reasons. Two aikos see each other's data ONLY per a grant that cryptographically traces
 * to the granter.
 */
import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { canRead, canonicalGrant, grantGate, type ContractGrant } from "../src/values/contract-grant.ts";

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

describe("contract-grant RBAC — roles as scoped grants (native, no new mechanism)", () => {
  const owner = identity();   // data owner + role authority
  const alice = identity();
  const NOW = 1_900_000_000_000;
  // owner grants: anyone with role "admin" may read contract:abc
  const roleGrant = (privateKey: ReturnType<typeof identity>["privateKey"], granterId: string) =>
    signGrant({ granter: granterId, grantee: "role:admin", scope: "contract:abc", expires: null }, privateKey);
  // owner assigns alice the role "admin"
  const assign = (privateKey: ReturnType<typeof identity>["privateKey"], granterId: string, who: string) =>
    signGrant({ granter: granterId, grantee: who, scope: "role:admin", expires: null }, privateKey);

  it("ROLE GRANTS ACCESS: an identity with a signed role:admin assignment reads a role:admin scope", () => {
    const grants = [roleGrant(owner.privateKey, owner.id), assign(owner.privateKey, owner.id, alice.id)];
    const r = canRead({ reader: alice.id, requestedScope: "contract:abc", grants, nowMs: NOW });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("granted");
  });

  it("NO ROLE: without the role assignment, the role grant does not apply", () => {
    const grants = [roleGrant(owner.privateKey, owner.id)]; // no assignment for alice
    const r = canRead({ reader: alice.id, requestedScope: "contract:abc", grants, nowMs: NOW });
    expect(r.allowed).toBe(false);
  });

  it("NO SELF-ASSIGN: a role assigned by a DIFFERENT granter (not the data owner) does NOT count", () => {
    const stranger = identity();
    const grants = [roleGrant(owner.privateKey, owner.id), assign(stranger.privateKey, stranger.id, alice.id)];
    const r = canRead({ reader: alice.id, requestedScope: "contract:abc", grants, nowMs: NOW });
    expect(r.allowed).toBe(false); // the assignment must be by owner (the role grant's granter)
  });

  it("REVOKED ROLE: revoking the assignment removes access", () => {
    const grants = [roleGrant(owner.privateKey, owner.id), { ...assign(owner.privateKey, owner.id, alice.id), revoked: true }];
    expect(canRead({ reader: alice.id, requestedScope: "contract:abc", grants, nowMs: NOW }).allowed).toBe(false);
  });

  it("FORGED ROLE: a tampered role assignment fails the native ed25519 check", () => {
    const good = assign(owner.privateKey, owner.id, alice.id);
    const forged = { ...good, grantee: "role:admin", scope: "role:admin", granter: owner.id, signature: good.signature.replace(/.$/, (c) => (c === "0" ? "1" : "0")) };
    const grants = [roleGrant(owner.privateKey, owner.id), { ...good, grantee: alice.id }, forged];
    // the forged one for a different identity won't grant; the real assignment for alice still works,
    // so test the inverse: only the forged assignment present → denied
    const onlyForged = [roleGrant(owner.privateKey, owner.id), { ...good, signature: "00".repeat(32) }];
    expect(canRead({ reader: alice.id, requestedScope: "contract:abc", grants: onlyForged, nowMs: NOW }).allowed).toBe(false);
  });
});

describe("grantGate — the opt-in permission policy (one guard, opted into per surface)", () => {
  const owner = identity();
  const reader = identity();
  const NOW = 1_900_000_000_000;
  const grant = (() => {
    const g = { granter: owner.id, grantee: reader.id, scope: "contract:abc", expires: null };
    return { ...g, signature: sign(null, Buffer.from(canonicalGrant(g)), owner.privateKey).toString("hex") };
  })();

  it("base allow → visible via base (the surface's own prior decision wins, no grant needed)", () => {
    const d = grantGate({ surface: "s1", baseAllowed: true, caller: reader.id, scope: "contract:abc", grants: [], nowMs: NOW });
    expect(d).toEqual({ surface: "s1", visible: true, via: "base" });
  });
  it("base deny + valid grant → visible via grant (additive widening)", () => {
    const d = grantGate({ surface: "s2", baseAllowed: false, caller: reader.id, scope: "contract:abc", grants: [grant], nowMs: NOW });
    expect(d.visible).toBe(true);
    expect(d.via).toBe("grant");
  });
  it("base deny + no grant → denied (fail-closed), surface named", () => {
    const d = grantGate({ surface: "s3", baseAllowed: false, caller: reader.id, scope: "contract:abc", grants: [], nowMs: NOW });
    expect(d).toEqual({ surface: "s3", visible: false, via: "denied" });
  });
});
