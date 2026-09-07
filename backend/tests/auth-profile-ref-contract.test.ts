import { test, expect } from "bun:test";
import { validateSkillManifest } from "../src/services/validator";

// LUMINARY for the auth_profile_ref normalization (publishSkill, client/index.ts).
// The backend security validator requires auth_profile_ref == `auth:<skill.domain>`
// (self-scoped, so a skill cannot coerce the executor into loading another domain's
// cookies). The CLI's INTERNAL credential form is `<domain>-session` — publishing it
// raw is rejected (400) and the skill silently falls back to local cache, leaving the
// registry empty. The fix normalizes to `auth:<domain>` at the publish boundary.
// This test locks that contract: if either side drifts, it fails.

const hasAuthRefError = (authRef: string) =>
  validateSkillManifest({
    domain: "shop.example",
    auth_profile_ref: authRef,
    endpoints: [{ endpoint_id: "e1", method: "GET", url_template: "https://shop.example/x" }],
  }, { production: false }).hardErrors.some((e) => e.includes("auth_profile_ref"));

test("the CLI internal form `<domain>-session` is REJECTED (this is why un-normalized publishes 400'd)", () => {
  expect(hasAuthRefError("shop.example-session")).toBe(true);
});

test("the normalized form `auth:<domain>` is ACCEPTED (no auth_profile_ref error)", () => {
  expect(hasAuthRefError("auth:shop.example")).toBe(false);
});

test("a cross-domain auth_profile_ref is REJECTED (the security reason the rule exists)", () => {
  expect(hasAuthRefError("auth:victim-bank.com")).toBe(true);
});
