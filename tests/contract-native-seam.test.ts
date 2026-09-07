/**
 * contract-native-seam.test — witness for the resolutionContractVerdict seam:
 * the CLI/orchestrator call it on every resolve, and it maps a resolved skill +
 * intent into the three-shape /contract verdict, ready to attach as `_contract`.
 *
 * Contract under test:
 *   (a) VERDICT SHAPE — terminal / settled / frontier equal the pure-TS
 *       three-shape drill, on every input class.
 *   (b) FALLBACK SAFETY — the output shape is valid on every build (no vendored
 *       lib required); the verdict never throws, fail-open by construction.
 */
import { describe, expect, it } from "bun:test";
import {
  resolutionContractVerdict,
  resolutionAsContractDrill,
} from "../src/values/resolution-contract.js";

describe("resolutionContractVerdict (three-shape contract seam)", () => {
  it("(a) a fully-resolved verdict settles terminal with the three shapes", async () => {
    const intent = "reveal a value only when the bound wallet authenticates";
    const v = await resolutionContractVerdict({
      intent,
      skill: { skill_id: "skill-x", endpoints: [{ url: "https://x/api" }] },
    });
    // the three-shape contract settled to a real terminal
    expect(v.terminal).toBe(true);
    expect(v.settled).toEqual(["interpret", "verify", "adjudicate"]);
    expect(v.frontier).toBeNull();
    expect(v.engine).toBe("fallback");
  });

  it("(a) verdict (terminal/settled/frontier) == pure-TS drill on every input class", async () => {
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

      // the OBSERVABLE existing fields are identical on every path
      expect(v.terminal).toBe(d.terminal);
      expect(v.settled).toEqual(d.settled);
      expect(v.frontier).toBe(d.frontier);
      // engine is always present + visible (fallbacks-never-silent)
      expect(v.engine === "native" || v.engine === "fallback").toBe(true);
    }
  });

  it("(b) the fallback output shape is valid (a build without the vendored lib stays safe)", async () => {
    const v = await resolutionContractVerdict({ intent: "x", skill: null });
    expect(["native", "fallback"]).toContain(v.engine);
    expect(Array.isArray(v.settled)).toBe(true);
  });
});
