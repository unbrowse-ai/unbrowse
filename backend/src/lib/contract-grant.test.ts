/**
 * backend contract-grant witness — the ENFORCEMENT read-guard, with real node:crypto ed25519.
 * The load-bearing security property: isVisibleByGrant ALLOWS a caller with a valid signed
 * capability grant for the contract, and DENIES ungranted / forged / no-grant (NO LEAK).
 */
import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { isVisibleByGrant, canonicalGrant, type MaybeGrantRow } from "./contract-grant";

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { id: publicKey.export({ type: "spki", format: "der" }).toString("hex"), privateKey };
}
function grantRow(owner: ReturnType<typeof identity>, grantee: string, scope: string): MaybeGrantRow {
  const g = { granter: owner.id, grantee, scope, expires: null };
  return { event: "capability_granted", ...g, signature: sign(null, Buffer.from(canonicalGrant(g)), owner.privateKey).toString("hex") };
}

describe("backend isVisibleByGrant — enforcement read-guard (no leak)", () => {
  const owner = identity();
  const reader = identity();
  const NOW = 1_900_000_000_000;

  it("ALLOWS a caller with a valid signed grant for the contract scope", () => {
    const rows = [grantRow(owner, reader.id, "contract:abc")];
    expect(isVisibleByGrant(reader.id, "abc", rows, NOW)).toBe(true);
  });

  it("DENIES an ungranted caller (no leak)", () => {
    const rows = [grantRow(owner, reader.id, "contract:abc")];
    expect(isVisibleByGrant(identity().id, "abc", rows, NOW)).toBe(false);
  });

  it("DENIES when there are no grant rows (no leak)", () => {
    expect(isVisibleByGrant(reader.id, "abc", [], NOW)).toBe(false);
    expect(isVisibleByGrant(reader.id, "abc", [{ event: "declared" }], NOW)).toBe(false);
  });

  it("DENIES a null caller", () => {
    const rows = [grantRow(owner, "*", "contract:abc")];
    expect(isVisibleByGrant(null, "abc", rows, NOW)).toBe(false);
  });

  it("FORGED (load-bearing): a tampered grant signature is denied", () => {
    const good = grantRow(owner, reader.id, "contract:abc");
    const forged: MaybeGrantRow = { ...good, signature: "00".repeat(32) };
    expect(isVisibleByGrant(reader.id, "abc", [forged], NOW)).toBe(false);
  });

  it("SCOPE: a grant for a DIFFERENT contract does not leak this one", () => {
    const rows = [grantRow(owner, reader.id, "contract:other")];
    expect(isVisibleByGrant(reader.id, "abc", rows, NOW)).toBe(false);
  });
});
