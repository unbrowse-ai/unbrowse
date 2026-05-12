import { describe, expect, it } from "bun:test";
import { shouldPublishAfterIndex } from "../src/indexer/index.js";

describe("shouldPublishAfterIndex — review-gate + opt-out", () => {
  it("blocks publish when share_pointers=false (private mode)", () => {
    const decision = shouldPublishAfterIndex(
      { skill_id: "skill-x", reviewed_at: "2026-05-12T00:00:00Z" },
      { share_pointers: false },
    );
    expect(decision.publish).toBe(false);
    expect(decision.gate).toBe("share_pointers_off");
    expect(decision.reason).toContain("private mode");
  });

  it("blocks publish when skill is not yet reviewed (default share_pointers=true)", () => {
    const decision = shouldPublishAfterIndex(
      { skill_id: "skill-y" },
      { share_pointers: true },
    );
    expect(decision.publish).toBe(false);
    expect(decision.gate).toBe("awaiting_review");
    expect(decision.reason).toContain("unbrowse_review");
  });

  it("allows publish when reviewed AND share_pointers=true (default opt-out path)", () => {
    const decision = shouldPublishAfterIndex(
      { skill_id: "skill-z", reviewed_at: "2026-05-12T01:00:00Z" },
      { share_pointers: true },
    );
    expect(decision.publish).toBe(true);
    expect(decision.gate).toBe("ok");
  });

  it("share_pointers=false takes precedence over reviewed_at — opt-out wins", () => {
    const decision = shouldPublishAfterIndex(
      { skill_id: "skill-a", reviewed_at: "2026-05-12T02:00:00Z" },
      { share_pointers: false },
    );
    expect(decision.publish).toBe(false);
    expect(decision.gate).toBe("share_pointers_off");
  });

  it("empty reviewed_at string is treated as unreviewed (gate stays closed)", () => {
    const decision = shouldPublishAfterIndex(
      { skill_id: "skill-b", reviewed_at: "" },
      { share_pointers: true },
    );
    expect(decision.publish).toBe(false);
    expect(decision.gate).toBe("awaiting_review");
  });
});
