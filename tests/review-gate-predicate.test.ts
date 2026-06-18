import { describe, expect, it } from "bun:test";
import { shouldPublishAfterIndex } from "../src/lib/indexer-core/index.js";

describe("shouldPublishAfterIndex — review-gate + opt-out (private-store, submit later)", () => {
  it("opt-out (share_pointers=false) STORES PRIVATE — no longer drops the capture", () => {
    const decision = shouldPublishAfterIndex(
      { skill_id: "skill-x", reviewed_at: "2026-05-12T00:00:00Z" },
      { share_pointers: false },
    );
    expect(decision.publish).toBe(true); // still published (so the backend persists it)
    expect(decision.visibility).toBe("private"); // ...but privately, to the user's account
    expect(decision.gate).toBe("share_pointers_off");
    expect(decision.reason).toContain("private mode");
    expect(decision.reason).toContain("submit");
  });

  it("blocks publish when skill is not yet reviewed (default share_pointers=true)", () => {
    const decision = shouldPublishAfterIndex({ skill_id: "skill-y" }, { share_pointers: true });
    expect(decision.publish).toBe(false);
    expect(decision.gate).toBe("awaiting_review");
    expect(decision.reason).toContain("unbrowse_review");
  });

  it("publishes PUBLIC when reviewed AND share_pointers=true", () => {
    const decision = shouldPublishAfterIndex(
      { skill_id: "skill-z", reviewed_at: "2026-05-12T01:00:00Z" },
      { share_pointers: true },
    );
    expect(decision.publish).toBe(true);
    expect(decision.visibility).toBe("public");
    expect(decision.gate).toBe("ok");
  });

  it("share_pointers=false → private even when reviewed (opt-out wins on visibility, still stored)", () => {
    const decision = shouldPublishAfterIndex(
      { skill_id: "skill-a", reviewed_at: "2026-05-12T02:00:00Z" },
      { share_pointers: false },
    );
    expect(decision.publish).toBe(true);
    expect(decision.visibility).toBe("private");
    expect(decision.gate).toBe("share_pointers_off");
  });

  it("empty reviewed_at string is treated as unreviewed (gate stays closed)", () => {
    const decision = shouldPublishAfterIndex({ skill_id: "skill-b", reviewed_at: "" }, { share_pointers: true });
    expect(decision.publish).toBe(false);
    expect(decision.gate).toBe("awaiting_review");
  });

  it("auto_review=true bypasses the review gate → publishes PUBLIC", () => {
    const decision = shouldPublishAfterIndex({ skill_id: "skill-auto" }, { share_pointers: true, auto_review: true });
    expect(decision.publish).toBe(true);
    expect(decision.visibility).toBe("public");
    expect(decision.gate).toBe("auto_review");
    expect(decision.reason).toContain("auto_review=true");
  });

  it("auto_review=true does NOT override opt-out — still stored PRIVATE (not dropped)", () => {
    const decision = shouldPublishAfterIndex(
      { skill_id: "skill-auto-private" },
      { share_pointers: false, auto_review: true },
    );
    expect(decision.publish).toBe(true);
    expect(decision.visibility).toBe("private");
    expect(decision.gate).toBe("share_pointers_off");
  });

  it("auto_review=false + unreviewed (share_pointers=true) → review gate still closed", () => {
    const decision = shouldPublishAfterIndex({ skill_id: "skill-legacy" }, { share_pointers: true, auto_review: false });
    expect(decision.publish).toBe(false);
    expect(decision.gate).toBe("awaiting_review");
  });

  it("reviewed_at takes precedence over auto_review → gate=ok, public", () => {
    const decision = shouldPublishAfterIndex(
      { skill_id: "skill-reviewed", reviewed_at: "2026-05-14T00:00:00Z" },
      { share_pointers: true, auto_review: true },
    );
    expect(decision.publish).toBe(true);
    expect(decision.visibility).toBe("public");
    expect(decision.gate).toBe("ok");
  });
});
