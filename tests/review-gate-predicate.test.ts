import { describe, expect, it } from "bun:test";
import { shouldPublishAfterIndex } from "../src/lib/indexer-core/index.js";

describe("shouldPublishAfterIndex — explicit consent + review gate", () => {
  it("no consent (share_pointers=false) keeps the capture local", () => {
    const decision = shouldPublishAfterIndex(
      { skill_id: "skill-x", reviewed_at: "2026-05-12T00:00:00Z" },
      { share_pointers: false },
    );
    expect(decision.publish).toBe(false);
    expect(decision.visibility).toBe("private");
    expect(decision.gate).toBe("share_pointers_off");
    expect(decision.reason).toContain("indexed locally only");
    expect(decision.reason).toContain("explicit marketplace consent");
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

  it("share_pointers=false keeps reviewed captures local", () => {
    const decision = shouldPublishAfterIndex(
      { skill_id: "skill-a", reviewed_at: "2026-05-12T02:00:00Z" },
      { share_pointers: false },
    );
    expect(decision.publish).toBe(false);
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

  it("auto_review=true does NOT override missing consent", () => {
    const decision = shouldPublishAfterIndex(
      { skill_id: "skill-auto-private" },
      { share_pointers: false, auto_review: true },
    );
    expect(decision.publish).toBe(false);
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
