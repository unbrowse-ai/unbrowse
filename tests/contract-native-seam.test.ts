/**
 * contract-native-seam.test — witness for the ONE safe, additive embedded-substrate wire:
 * resolutionContractVerdict (on the live `eval resolve` hot path) now calls the in-process
 * embedded substrate EMBEDDED-FIRST, but ONLY for the inherently-local, deterministic,
 * stateless `contract_bible_anchor` (no ledger write, no network, no cloud-ledger semantics).
 *
 * This proves both directions of the contract:
 *   (a) NATIVE PATH — when the embedded lib is available, the seam returns a correct result:
 *       a deterministic `anchor` verse index and `engine:"native"`, same intent → same anchor,
 *       different intents → (generally) different anchors.
 *   (b) BEHAVIOR PRESERVED — the EXISTING observable contract (terminal / settled / frontier)
 *       is byte-identical to the pure-TS three-shape drill, native or not; the native call only
 *       ATTACHES additive evidence and can NEVER flip the verdict. The fallback shape (no anchor,
 *       engine:"fallback") is also a valid output, so a build without the vendored lib is safe.
 */
import { describe, expect, it } from "bun:test";
import {
  resolutionContractVerdict,
  resolutionAsContractDrill,
} from "../src/values/resolution-contract.js";
import { bibleAnchorNative, nativeAvailable } from "../src/values/contract-native.js";

const NATIVE = nativeAvailable();

describe("embedded substrate wired into resolutionContractVerdict (embedded-first → fallback)", () => {
  it("the inherently-local bible-anchor is deterministic (pure, no ledger write/network)", () => {
    if (!NATIVE) {
      // honest skip — no vendored lib for this platform; the fallback path is exercised below
      expect(NATIVE).toBe(false);
      return;
    }
    const t = "reveal a value only when the bound wallet authenticates";
    const a = bibleAnchorNative(t);
    const b = bibleAnchorNative(t);
    // the GUARANTEED property: pure + deterministic — same text → same verse index, always.
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(a as number).toBeGreaterThanOrEqual(0);
    // a different text also returns a valid index (the anchor is real text → corpus, not a stub).
    // It is NOT asserted to differ: the anchor is the single most-relevant verse over a fixed
    // corpus, so two texts may legitimately share one — uniqueness is not a property to gate on.
    const c = bibleAnchorNative("list every product in the storefront");
    expect(c).not.toBeNull();
    expect(c as number).toBeGreaterThanOrEqual(0);
  });

  it("(a) NATIVE PATH — a fully-resolved verdict carries engine:'native' + a deterministic anchor", async () => {
    const intent = "reveal a value only when the bound wallet authenticates";
    const v = await resolutionContractVerdict({
      intent,
      skill: { skill_id: "skill-x", endpoints: [{ url: "https://x/api" }] },
    });
    // the three-shape contract settled to a real terminal
    expect(v.terminal).toBe(true);
    expect(v.settled).toEqual(["interpret", "verify", "adjudicate"]);
    expect(v.frontier).toBeNull();

    if (NATIVE) {
      expect(v.engine).toBe("native");
      expect(typeof v.anchor).toBe("number");
      // additive evidence is deterministic + decoupled from the verdict
      const v2 = await resolutionContractVerdict({
        intent,
        skill: { skill_id: "skill-x", endpoints: [{ url: "https://x/api" }] },
      });
      expect(v2.anchor).toBe(v.anchor);
    } else {
      expect(v.engine).toBe("fallback");
      expect(v.anchor).toBeUndefined();
    }
  });

  it("(b) BEHAVIOR PRESERVED — verdict (terminal/settled/frontier) == pure-TS drill, native unchanged", async () => {
    const cases: Array<{ intent: string; skill?: { skill_id?: string; endpoints?: unknown[] } | null; url?: string }> = [
      // terminal: interpret→verify→adjudicate
      { intent: "buy a coffee", skill: { skill_id: "s1", endpoints: [{ url: "u" }] } },
      // verified (url route) but no endpoints → adjudicate is the frontier
      { intent: "open a page", url: "https://example.com" },
      // interpreted only → verify is the frontier
      { intent: "do something", skill: null },
      // empty intent → interpret is the frontier
      { intent: "   ", skill: { skill_id: "s2", endpoints: [{ url: "u" }] } },
    ];
    for (const c of cases) {
      const v = await resolutionContractVerdict(c);
      // recompute the canonical pure-TS three-shape drill the seam is built on
      const skill = c.skill ?? null;
      const route = skill?.skill_id ? { skill_id: skill.skill_id } : c.url ? { url: c.url } : null;
      const winner =
        Array.isArray(skill?.endpoints) && skill.endpoints.length > 0 ? { endpoints: skill.endpoints } : null;
      const d = await resolutionAsContractDrill({ intent: c.intent, route, winner });

      // the OBSERVABLE existing fields are identical — the native call never changes the verdict
      expect(v.terminal).toBe(d.terminal);
      expect(v.settled).toEqual(d.settled);
      expect(v.frontier).toBe(d.frontier);
      // engine is always present + visible (fallbacks-never-silent)
      expect(v.engine === "native" || v.engine === "fallback").toBe(true);
    }
  });

  it("the fallback output shape is valid (a build without the vendored lib stays safe)", async () => {
    // We don't unload the lib; instead we assert the contract the fallback branch guarantees:
    // engine present, no anchor required, three-shape fields intact. (When NATIVE is false this
    // path is the live one.)
    const v = await resolutionContractVerdict({ intent: "x", skill: null });
    expect(["native", "fallback"]).toContain(v.engine);
    // anchor is OPTIONAL — never required for a valid verdict
    if (v.anchor !== undefined) expect(typeof v.anchor).toBe("number");
    expect(Array.isArray(v.settled)).toBe(true);
  });
});
