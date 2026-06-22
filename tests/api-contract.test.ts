/**
 * api-contract witness — every API call becomes /contract muscle memory.
 * Load-bearing proof (no fabricated green): an identical call RECALLS from the contract ledger and
 * the legacy API does NOT re-run (apiCalls stays 1); a different call (miss) falls to the legacy
 * internet. That is "unbrowse dependent on /contract as the internet ledger, legacy as fallback."
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiContract, apiContractId } from "../src/values/api-contract.ts";

describe("apiContract — every API becomes /contract muscle memory", () => {
  it("MUSCLE MEMORY: an identical call recalls; the legacy API runs exactly ONCE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apictr-"));
    let apiCalls = 0;
    const produce = async () => {
      apiCalls++;
      return { temp: 31 };
    };
    const r1 = await apiContract({ api: "weather.get", args: { city: "sg" }, dir, produce });
    const r2 = await apiContract({ api: "weather.get", args: { city: "sg" }, dir, produce });
    expect(r1.recalled).toBe(false); // first call → the legacy internet ran (the producer)
    expect(r2.recalled).toBe(true); // second call → muscle memory (recalled from the ledger)
    expect(apiCalls).toBe(1); // THE LOAD-BEARING PROOF: the legacy API fired once, not twice
    expect(r2.value).toEqual({ temp: 31 });
    expect(r2.contractId).toBe(r1.contractId); // same (api,args) → same content-addressed pointer
  });

  it("LEGACY FALLBACK: a different call (cache miss) runs the legacy internet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apictr-"));
    let calls = 0;
    const produce = async () => {
      calls++;
      return { n: calls };
    };
    await apiContract({ api: "x.get", args: { a: 1 }, dir, produce });
    await apiContract({ api: "x.get", args: { a: 2 }, dir, produce }); // different args → miss → legacy runs
    expect(calls).toBe(2);
  });

  it("content-addressed id: stable for same (api,args), differs for different args", () => {
    expect(apiContractId("a", { x: 1 })).toBe(apiContractId("a", { x: 1 }));
    expect(apiContractId("a", { x: 1 })).not.toBe(apiContractId("a", { x: 2 }));
    expect(apiContractId("a")).not.toBe(apiContractId("b"));
  });

  it("the result carries the /contract verdict shape (shaped + embedded all the way)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apictr-"));
    const r = await apiContract({ api: "y.get", dir, produce: async () => ({ ok: true }) });
    expect(r._contract).toBeDefined();
    expect(typeof r._contract.terminal).toBe("boolean");
  });
});
