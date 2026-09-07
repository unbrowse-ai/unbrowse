/**
 * contract-browse witness — kuri browser primitives mirrored on the unbrowse CLI in /contract shape.
 * Load-bearing proof (no fabricated green, no false witness):
 *  - a READ primitive (snap) RECALLS — the live browser runs exactly ONCE across two identical snaps.
 *  - an ACT primitive (click) is NEVER memoized — the live browser runs EVERY time (a recalled act
 *    would be false witness: clicking twice is two clicks).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractBrowse, isReadPrimitive } from "../src/values/contract-browse.ts";

describe("contractBrowse — kuri primitives in /contract shape (read recalls, act re-runs)", () => {
  it("READ (snap): an identical snap recalls; the live browser runs exactly ONCE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cbrowse-"));
    let runs = 0;
    const run = async () => {
      runs++;
      return { a11y: "<page>" };
    };
    const r1 = await contractBrowse({ primitive: "snap", url: "https://x.com", run, dir });
    const r2 = await contractBrowse({ primitive: "snap", url: "https://x.com", run, dir });
    expect(r1.recalled).toBe(false); // first snap → live browser ran
    expect(r2.recalled).toBe(true); // second snap → muscle memory (recalled)
    expect(runs).toBe(1); // THE PROOF: the browser snapped once, not twice
    expect(r2.value).toEqual({ a11y: "<page>" });
  });

  it("ACT (click): NEVER memoized — the live browser runs EVERY call (no false witness)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cbrowse-"));
    let clicks = 0;
    const run = async () => {
      clicks++;
      return { ok: true };
    };
    const r1 = await contractBrowse({ primitive: "click", url: "https://x.com#btn", run, dir });
    const r2 = await contractBrowse({ primitive: "click", url: "https://x.com#btn", run, dir });
    expect(r1.recalled).toBe(false);
    expect(r2.recalled).toBe(false); // an act is NEVER recalled
    expect(clicks).toBe(2); // THE PROOF: two clicks fired live — clicking twice is two clicks
  });

  it("classifies kuri primitives: snap/fetch/read are READ; go/click/type/eval are ACT", () => {
    expect(isReadPrimitive("snap")).toBe(true);
    expect(isReadPrimitive("fetch")).toBe(true);
    expect(isReadPrimitive("read")).toBe(true);
    expect(isReadPrimitive("click")).toBe(false);
    expect(isReadPrimitive("go")).toBe(false);
    expect(isReadPrimitive("type")).toBe(false);
    expect(isReadPrimitive("eval")).toBe(false); // may mutate the page → never memoized
  });

  it("carries the /contract verdict shape on every primitive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cbrowse-"));
    const r = await contractBrowse({ primitive: "snap", url: "u", run: async () => 1, dir });
    expect(typeof r._contract.terminal).toBe("boolean");
  });
});
