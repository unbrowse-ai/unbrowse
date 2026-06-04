// Regression: when the resolve race fires a marketplace lookup with a HOSTNAME
// (e.g. "stackoverflow.com") as if it were a skill_id, the backend's
// /v1/skills/<hostname> returns 404, and src/client/index.ts:1185-1196 falls
// back to listSkills() which fetches the entire skill catalog and searches by
// skill_id (NEVER matches hostnames). Net effect: every cold-domain resolve
// waits 5+ seconds for the listSkills() round-trip before the race settles
// all-losers.
//
// Live evidence: stackoverflow.com resolve returned total_ms:5986 in
// decision_trace.budget_race; marketplace racer lost ms:5986 reason:not_found.
//
// Fix: src/client/index.ts exports a `looksLikeSkillId` predicate and short
// circuits the listSkills fallback for hostname/path/URL-shaped inputs. The
// catch-block runs `listSkills` only when the input has the shape of a real
// skill_id (a 21-char alphanumeric/dash/underscore nanoid).

import { describe, expect, it } from "bun:test";
import { looksLikeSkillId } from "../src/client/index.js";

describe("looksLikeSkillId (skill_id shape predicate)", () => {
  it("returns true for nanoid-shaped values", () => {
    expect(looksLikeSkillId("jERQ-T3VPZ6YlAzWtedOx")).toBe(true);
    expect(looksLikeSkillId("dkit6mkV6c9SFLmN1ZdEF")).toBe(true);
    expect(looksLikeSkillId("V1StGXR8_Z5jdHi6B-myT")).toBe(true);
  });

  it("returns false for hostnames (contain a dot)", () => {
    expect(looksLikeSkillId("stackoverflow.com")).toBe(false);
    expect(looksLikeSkillId("www.reddit.com")).toBe(false);
    expect(looksLikeSkillId("api.unbrowse.ai")).toBe(false);
    expect(looksLikeSkillId("foo.bar.baz.example")).toBe(false);
  });

  it("returns false for URL-shaped values (contain a slash or colon)", () => {
    expect(looksLikeSkillId("https://example.com/x")).toBe(false);
    expect(looksLikeSkillId("/foo/bar")).toBe(false);
    expect(looksLikeSkillId("scheme:thing")).toBe(false);
  });

  it("returns false for empty or whitespace strings", () => {
    expect(looksLikeSkillId("")).toBe(false);
    expect(looksLikeSkillId("   ")).toBe(false);
  });

  it("returns false for absurdly short strings", () => {
    expect(looksLikeSkillId("a")).toBe(false);
    expect(looksLikeSkillId("abc")).toBe(false);
  });

  it("returns false for absurdly long strings (defensive cap)", () => {
    expect(looksLikeSkillId("a".repeat(200))).toBe(false);
  });

  it("returns true for the boundary case of a 21-char alphanumeric/dash/underscore", () => {
    expect(looksLikeSkillId("a".repeat(21))).toBe(true);
    expect(looksLikeSkillId("AaBbCcDdEeFfGgHhIiJ_-")).toBe(true);
  });
});
