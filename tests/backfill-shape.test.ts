// Backfill shape gate: only well-shaped, indexable skill manifests are backfilled
// from the local cache; junk/malformed/non-indexable are skipped.
import { describe, it, expect } from "bun:test";
import { isBackfillableManifest, dedupeBackfill } from "../src/lib/backfill.js";

const good = { skill_id: "s1", domain: "old.reddit.com", endpoints: [{ url_template: "https://old.reddit.com/r/x.json" }] };

describe("isBackfillableManifest — format-shape gate", () => {
  it("accepts a well-shaped, indexable manifest", () => {
    expect(isBackfillableManifest(good)).toBe(true);
    expect(isBackfillableManifest({ skill_id: "s", domain: "hn.algolia.com", endpoints: [{}] })).toBe(true);
  });

  it("rejects missing/empty skill_id, domain, or endpoints", () => {
    expect(isBackfillableManifest({ domain: "old.reddit.com", endpoints: [{}] })).toBe(false);
    expect(isBackfillableManifest({ skill_id: "s", endpoints: [{}] })).toBe(false);
    expect(isBackfillableManifest({ skill_id: "s", domain: "old.reddit.com", endpoints: [] })).toBe(false);
    expect(isBackfillableManifest({ skill_id: "", domain: "x.com", endpoints: [{}] })).toBe(false);
  });

  it("rejects non-indexable domains (junk never backfilled)", () => {
    expect(isBackfillableManifest({ skill_id: "s", domain: "example.com", endpoints: [{}] })).toBe(false);
    expect(isBackfillableManifest({ skill_id: "s", domain: "localhost", endpoints: [{}] })).toBe(false);
    expect(isBackfillableManifest({ skill_id: "s", domain: "chromewebdata", endpoints: [{}] })).toBe(false);
  });

  it("rejects non-objects / junk", () => {
    expect(isBackfillableManifest(null)).toBe(false);
    expect(isBackfillableManifest("nope")).toBe(false);
    expect(isBackfillableManifest(42)).toBe(false);
  });

  it("dedupes by skill_id, first-seen wins", () => {
    const out = dedupeBackfill([{ skill_id: "a" }, { skill_id: "b" }, { skill_id: "a" }]);
    expect(out.map((x) => x.skill_id)).toEqual(["a", "b"]);
  });
});
