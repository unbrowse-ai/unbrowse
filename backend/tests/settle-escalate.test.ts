import { describe, expect, it } from "bun:test";
import { settleOrEscalate, type SettleCandidate } from "../src/services/settle.js";

describe("settleOrEscalate — settlement / abstention layer", () => {
  it("settles a strong agreeing low-energy candidate", () => {
    const candidates: SettleCandidate[] = [
      { id: "a", energy: -0.9, witnesses: [0.8, 0.7], agree: true }, // best: covers + concurs
      { id: "b", energy: -0.3, witnesses: [0.4, 0.5], agree: true },
    ];
    const result = settleOrEscalate(candidates);
    expect(result.escalate).toBe(false);
    expect(result.reason).toBe("settled");
    expect(result.settled).toEqual({ id: "a" });
  });

  it("escalates when the top (lowest-energy) candidate's witnesses disagree", () => {
    const candidates: SettleCandidate[] = [
      // Lowest energy, but the witnesses disagree (e.g. strong lexical, weak dense).
      { id: "a", energy: -0.9, witnesses: [0.9, 0.1], agree: false },
      { id: "b", energy: -0.4, witnesses: [0.5, 0.6], agree: true },
    ];
    const result = settleOrEscalate(candidates);
    expect(result.escalate).toBe(true);
    expect(result.reason).toBe("no_quorum");
    expect(result.settled).toBeNull();
  });

  it("escalates with reason 'empty' on an empty candidate list", () => {
    const result = settleOrEscalate([]);
    expect(result.escalate).toBe(true);
    expect(result.reason).toBe("empty");
    expect(result.settled).toBeNull();
  });

  it("escalates when the best candidate's energy is above the coverage ceiling", () => {
    const candidates: SettleCandidate[] = [
      // Agreeing witnesses, but energy >= 0 (no real coverage — least-bad of a bad list).
      { id: "a", energy: 0.1, witnesses: [0.55, 0.55], agree: true },
      { id: "b", energy: 0.3, witnesses: [0.6, 0.6], agree: true },
    ];
    const result = settleOrEscalate(candidates);
    expect(result.escalate).toBe(true);
    expect(result.reason).toBe("below_coverage");
    expect(result.settled).toBeNull();
  });

  // --- edge / adversarial cases ---

  it("exact tie: identical lowest energy, both agree → deterministic first/canonical pick", () => {
    // Tie-break is documented by the strict `<` in the single pass: the FIRST
    // candidate in canonical (input) order keeps the `best` slot, since a later
    // equal-energy candidate is not strictly less. So 'a' wins, deterministically.
    const candidates: SettleCandidate[] = [
      { id: "a", energy: -0.7, witnesses: [0.8, 0.8], agree: true },
      { id: "b", energy: -0.7, witnesses: [0.9, 0.9], agree: true }, // equal energy, later
    ];
    const result = settleOrEscalate(candidates);
    expect(result.escalate).toBe(false);
    expect(result.reason).toBe("settled");
    expect(result.settled).toEqual({ id: "a" });

    // Reversing input order flips the winner to the new first — proves the
    // tie-break is "first in canonical order", not value-dependent.
    const reversed = settleOrEscalate([candidates[1], candidates[0]]);
    expect(reversed.settled).toEqual({ id: "b" });
  });

  it("energy exactly AT the ceiling escalates (boundary is STRICTLY below)", () => {
    // energyCeil default is 0; a candidate at energy === 0 is NOT < 0, so it is
    // treated as non-covering. The boundary is consistent: below settles, at
    // the ceiling escalates.
    const atCeil: SettleCandidate[] = [
      { id: "a", energy: 0, witnesses: [0.6, 0.6], agree: true },
    ];
    const atResult = settleOrEscalate(atCeil);
    expect(atResult.escalate).toBe(true);
    expect(atResult.reason).toBe("below_coverage");
    expect(atResult.settled).toBeNull();

    // Just below the same ceiling settles — confirms the boundary is exactly at
    // energyCeil and only strictly-below clears it.
    const belowCeil: SettleCandidate[] = [
      { id: "a", energy: -1e-9, witnesses: [0.6, 0.6], agree: true },
    ];
    const belowResult = settleOrEscalate(belowCeil);
    expect(belowResult.escalate).toBe(false);
    expect(belowResult.reason).toBe("settled");
    expect(belowResult.settled).toEqual({ id: "a" });

    // Same boundary with a non-zero ceiling: at the ceiling escalates.
    const customAtCeil: SettleCandidate[] = [
      { id: "a", energy: 0.5, witnesses: [0.6, 0.6], agree: true },
    ];
    expect(settleOrEscalate(customAtCeil, { energyCeil: 0.5 }).reason).toBe(
      "below_coverage",
    );
  });

  it("all candidates agree:false → escalate no_quorum", () => {
    const candidates: SettleCandidate[] = [
      { id: "a", energy: -0.9, witnesses: [0.9, 0.1], agree: false },
      { id: "b", energy: -0.5, witnesses: [0.6, 0.2], agree: false },
      { id: "c", energy: -0.2, witnesses: [0.3, 0.4], agree: false },
    ];
    const result = settleOrEscalate(candidates);
    expect(result.escalate).toBe(true);
    expect(result.reason).toBe("no_quorum");
    expect(result.settled).toBeNull();
  });

  it("single candidate that agrees + low energy → settles", () => {
    const candidates: SettleCandidate[] = [
      { id: "solo", energy: -0.6, witnesses: [0.7, 0.7], agree: true },
    ];
    const result = settleOrEscalate(candidates);
    expect(result.escalate).toBe(false);
    expect(result.reason).toBe("settled");
    expect(result.settled).toEqual({ id: "solo" });
  });

  it("adversarial: a NaN-energy candidate is never settled on (treated as non-settling)", () => {
    // A lone NaN candidate is garbage — must escalate, never settle on NaN.
    const loneNaN: SettleCandidate[] = [
      { id: "nan", energy: Number.NaN, witnesses: [0.9, 0.9], agree: true },
    ];
    const loneResult = settleOrEscalate(loneNaN);
    expect(loneResult.escalate).toBe(true);
    expect(loneResult.settled).toBeNull();

    // Adversarial poison: a NaN candidate FIRST must not block a valid
    // low-energy settling candidate that follows. NaN compares false against
    // everything, so a naive `energy < best.energy` scan would keep the NaN as
    // `best` and wrongly escalate. The fixed scan skips NaN and settles 'good'.
    const poisoned: SettleCandidate[] = [
      { id: "nan", energy: Number.NaN, witnesses: [0.9, 0.9], agree: true },
      { id: "good", energy: -0.9, witnesses: [0.8, 0.8], agree: true },
    ];
    const poisonedResult = settleOrEscalate(poisoned);
    expect(poisonedResult.escalate).toBe(false);
    expect(poisonedResult.reason).toBe("settled");
    expect(poisonedResult.settled).toEqual({ id: "good" });
  });
});
