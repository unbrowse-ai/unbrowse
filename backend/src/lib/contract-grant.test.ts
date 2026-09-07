/**
 * backend contract-grant witness — the ENFORCEMENT read-guard, with real node:crypto ed25519.
 * The load-bearing security property: isVisibleByGrant ALLOWS a caller with a valid signed
 * capability grant for the contract, and DENIES ungranted / forged / no-grant (NO LEAK).
 */
import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { isVisibleByGrant, canonicalGrant, grantGate, payGate, type MaybeGrantRow } from "./contract-grant";

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

describe("payGate ∘ grantGate — RBAC verdict feeds the x402 compensation tier (end-to-end)", () => {
  const AGENT = "FnKAsX65xiNBukiLt9YYyzHJQrsRxQG62X9uMavKtkf";

  it("ALLOWED + priced POST → a 402 quote payable to the agent (real grantGate base-allow → payGate)", () => {
    const dec = grantGate({ surface: "agent:x", baseAllowed: true, caller: AGENT, contractId: "c1", rows: [] });
    expect(dec.visible).toBe(true); // grantGate's REAL verdict
    const pay = payGate({ decision: dec, method: "POST", price: { POST: { amount: "10000" } }, recipient: AGENT, resource: "task:c1" });
    expect(pay.kind).toBe("payment_required");
    if (pay.kind !== "payment_required") throw new Error("unreachable");
    expect(pay.quote.payTo).toBe(AGENT);
    expect(pay.quote.amount).toBe("10000");
  });

  it("DENIED by grantGate stays denied EVEN WITH a price (payment never buys past RBAC)", () => {
    const dec = grantGate({ surface: "agent:x", baseAllowed: false, caller: AGENT, contractId: "c1", rows: [] });
    expect(dec.visible).toBe(false); // no base, no grant → grantGate denies
    const pay = payGate({ decision: dec, method: "POST", price: { POST: { amount: "999999" } }, recipient: AGENT, resource: "r" });
    expect(pay.kind).toBe("denied"); // NOT payment_required
  });

  it("ALLOWED + no price → free", () => {
    const dec = grantGate({ surface: "s", baseAllowed: true, caller: AGENT, contractId: "c1", rows: [] });
    expect(payGate({ decision: dec, method: "GET", recipient: AGENT, resource: "r" }).kind).toBe("free");
  });

  it("ALLOWED + malformed amount → denied (no bogus quote on a money path)", () => {
    const dec = grantGate({ surface: "s", baseAllowed: true, caller: AGENT, contractId: "c1", rows: [] });
    for (const amount of ["0", "-5", "abc", ""]) {
      expect(payGate({ decision: dec, method: "POST", price: { POST: { amount } }, recipient: AGENT, resource: "r" }).kind).toBe("denied");
    }
  });
});
