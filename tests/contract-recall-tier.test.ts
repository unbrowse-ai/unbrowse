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

describe("recallContractVia — edge + adversarial conditions", () => {
  const cap = () => {
    const tiers: RecallTier[] = [];
    return { tiers, on: (t: RecallTier) => tiers.push(t) };
  };

  it("malformed KV payload must NOT falsely report kv-hit (it never served a usable value)", async () => {
    const c = cap();
    const v = await recallContractVia("a", {
      kvGet: async () => "{not json",                       // corrupt cache value
      findInLedger: async () => ({ result: JSON.stringify({ ok: 1 }) }),
      onTier: c.on,
    });
    expect(v).toEqual({ ok: 1 });            // recovered via IQ
    expect(c.tiers).not.toContain("kv-hit"); // the lost sheep: a corrupt value must not look like a hit
    expect(c.tiers).toContain("kv-error");
    expect(c.tiers).toContain("iq-fallback");
  });

  it("malformed IQ payload → iq-error surfaced, terminal miss, null", async () => {
    const c = cap();
    const v = await recallContractVia("a", {
      kvGet: async () => null,
      findInLedger: async () => ({ result: "{not json" }),
      onTier: c.on,
    });
    expect(v).toBeNull();
    expect(c.tiers).toContain("iq-error");
    expect(c.tiers[c.tiers.length - 1]).toBe("miss");
  });

  it("both tiers error → both surfaced, terminal miss, null", async () => {
    const c = cap();
    const v = await recallContractVia("a", {
      kvGet: async () => { throw new Error("kv down"); },
      findInLedger: async () => { throw new Error("iq down"); },
      onTier: c.on,
    });
    expect(v).toBeNull();
    expect(c.tiers).toContain("kv-error");
    expect(c.tiers).toContain("iq-error");
    expect(c.tiers[c.tiers.length - 1]).toBe("miss");
  });

  it("concurrent recalls do not cross-talk (the pure core holds no shared state)", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const c = cap();
        const hit = i % 2 === 0;
        return recallContractVia(`id-${i}`, {
          kvGet: async () => (hit ? JSON.stringify({ i }) : null),
          findInLedger: async () => null,
          onTier: c.on,
        }).then((v) => ({ i, v, tiers: c.tiers }));
      }),
    );
    for (const { i, v, tiers } of results) {
      if (i % 2 === 0) { expect(v).toEqual({ i }); expect(tiers).toEqual(["kv-hit"]); }
      else { expect(v).toBeNull(); expect(tiers).toEqual(["miss"]); }
    }
  });
});
