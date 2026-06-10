import { test, expect } from "bun:test";
import { normalizePublishedAuthRef } from "../src/client/index";

// CREATURES — exercise the publish-boundary auth_profile_ref normalization under real
// behavior: golden path, edges, and the adversarial case that is the security reason
// the rule exists. Chase the one that would leak.

test("golden: <domain>-session is normalized to auth:<domain>", () => {
  expect(normalizePublishedAuthRef("shop.example-session", "shop.example")).toBe("auth:shop.example");
});

test("edge: already auth:<domain> passes through unchanged (idempotent, no double-prefix)", () => {
  expect(normalizePublishedAuthRef("auth:shop.example", "shop.example")).toBe("auth:shop.example");
});

test("edge: no auth_profile_ref stays undefined (no-auth skills publish cleanly)", () => {
  expect(normalizePublishedAuthRef(undefined, "shop.example")).toBeUndefined();
});

test("edge: missing domain leaves the ref untouched (cannot self-scope without a domain)", () => {
  expect(normalizePublishedAuthRef("shop.example-session", undefined)).toBe("shop.example-session");
});

test("ADVERSARIAL: a cross-domain ref is FORCED to the skill's own domain (never loads another's cookies)", () => {
  // The attack the validator guards against: a publisher setting auth_profile_ref to a
  // victim domain to coerce the executor into loading victim cookies. Normalization
  // rewrites it to the skill's own domain, so the attack is structurally impossible.
  expect(normalizePublishedAuthRef("victim-bank.com-session", "shop.example")).toBe("auth:shop.example");
});
