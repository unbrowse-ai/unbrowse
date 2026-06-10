import { test, expect } from "bun:test";
import { mapPublishError } from "../src/routes/publish-error-map";

// Witness for the masked-500 fix: every known publish refusal surfaces its OWN reason,
// not a generic 500. Before the fix, not_owner and taken_down fell through to 500.

test("not_owner → 403 with the ownership reason (was a masked 500)", () => {
  const r = mapPublishError("publish_forbidden_not_owner");
  expect(r.status).toBe(403);
  expect(r.body.error).toBe("publish_forbidden_not_owner");
  expect(String(r.body.message)).toContain("verified owner");
});

test("taken_down → 403 with the domain (was a masked 500)", () => {
  const r = mapPublishError("publish_forbidden_taken_down:shop.example");
  expect(r.status).toBe(403);
  expect(r.body.error).toBe("publish_forbidden_taken_down");
  expect(r.body.domain).toBe("shop.example");
});

test("reserved_domain → 403 (already handled, still mapped)", () => {
  const r = mapPublishError("publish_forbidden_reserved_domain:stripe.com");
  expect(r.status).toBe(403);
  expect(r.body.reserved_domain).toBe("stripe.com");
});

test("domain_unverified → 403 with the verify next_step", () => {
  const r = mapPublishError("publish_forbidden_domain_unverified:shop.example");
  expect(r.status).toBe(403);
  expect(String(r.body.next_step)).toContain("verify/challenge");
});

test("release_manifest_* → 400", () => {
  expect(mapPublishError("release_manifest_bad_sig").status).toBe(400);
});

test("a genuinely unexpected error STILL falls through to 500 (don't over-map)", () => {
  const r = mapPublishError("TypeError: cannot read x of undefined");
  expect(r.status).toBe(500);
  expect(r.body.error).toBe("Failed to publish skill");
});
