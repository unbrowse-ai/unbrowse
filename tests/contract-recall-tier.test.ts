import { describe, expect, it } from "bun:test";
import { recallContractVia, type RecallTier } from "../src/values/contract-everything.js";

/**
 * The recall path is the web2-cache(emergent KV)-wraps-web3-ledger(IQ) seam. These tests are the
 * standing SIGN that the wrap is OBSERVABLE — onTier reports which tier served — and COLD: the pure
 * `recallContractVia` core takes the two lookups injected, so the tier logic is exercised with zero
 * network (the live recall touches the flaky KV; the pure core is the falsifiable seam).
 */
describe("recallContractVia — tier observability (web2 KV wraps web3 IQ)", () => {
  const cap = () => {
    const tiers: RecallTier[] = [];
    return { tiers, on: (t: RecallTier) => tiers.push(t) };
  };

  it("kv-hit: the emergent KV cache (web2) serves; onTier sees kv-hit", async () => {
    const c = cap();
    const v = await recallContractVia("a", {
      kvGet: async () => JSON.stringify({ x: 1 }),
      findInLedger: async () => null,
      onTier: c.on,
    });
    expect(v).toEqual({ x: 1 });
    expect(c.tiers).toContain("kv-hit");
    expect(c.tiers).not.toContain("iq-fallback"); // KV hit short-circuits — IQ is never touched
  });

  it("iq-fallback: KV miss → the IQ ledger (web3) serves; onTier sees iq-fallback", async () => {
    const c = cap();
    const v = await recallContractVia("a", {
      kvGet: async () => null,
      findInLedger: async () => ({ result: JSON.stringify({ y: 2 }) }),
      onTier: c.on,
    });
    expect(v).toEqual({ y: 2 });
    expect(c.tiers[c.tiers.length - 1]).toBe("iq-fallback");
  });

  it("miss: neither tier has it → null, terminal tier is miss", async () => {
    const c = cap();
    const v = await recallContractVia("a", {
      kvGet: async () => null,
      findInLedger: async () => null,
      onTier: c.on,
    });
    expect(v).toBeNull();
    expect(c.tiers[c.tiers.length - 1]).toBe("miss");
  });

  it("kv-error: a thrown KV tier is SURFACED (not swallowed), then falls through", async () => {
    const c = cap();
    const v = await recallContractVia("a", {
      kvGet: async () => { throw new Error("kv down"); },
      findInLedger: async () => ({ result: JSON.stringify({ z: 3 }) }),
      onTier: c.on,
    });
    expect(v).toEqual({ z: 3 });            // recovered via IQ
    expect(c.tiers).toContain("kv-error");  // the error is OBSERVABLE, not a silent catch
    expect(c.tiers).toContain("iq-fallback");
  });

  it("backward-compat: no onTier observer must not throw", async () => {
    const v = await recallContractVia("a", { kvGet: async () => null, findInLedger: async () => null });
    expect(v).toBeNull();
  });
});
