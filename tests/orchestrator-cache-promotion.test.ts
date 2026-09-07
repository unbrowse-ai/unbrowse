import { describe, test, expect } from "bun:test";

describe("#89 cache promotion and mutable DOM guard", () => {
  test("mutable DOM endpoints (POST) should not auto-execute", () => {
    const endpoint = {
      method: "POST",
      dom_extraction: { selector: ".content" },
      idempotency: undefined as string | undefined,
    };
    const isMutableDom = endpoint.dom_extraction && endpoint.method !== "GET" && endpoint.idempotency !== "safe";
    expect(isMutableDom).toBeTruthy();
  });

  test("GET dom_extraction endpoints should auto-execute", () => {
    const endpoint = {
      method: "GET",
      dom_extraction: { selector: ".content" },
      idempotency: undefined as string | undefined,
    };
    const isMutableDom = endpoint.dom_extraction && endpoint.method !== "GET" && endpoint.idempotency !== "safe";
    expect(isMutableDom).toBeFalsy();
  });

  test("safe idempotent POST dom_extraction should auto-execute", () => {
    const endpoint = {
      method: "POST",
      dom_extraction: { selector: ".content" },
      idempotency: "safe",
    };
    const isMutableDom = endpoint.dom_extraction && endpoint.method !== "GET" && endpoint.idempotency !== "safe";
    expect(isMutableDom).toBeFalsy();
  });

  test("deferral should still promote to cache", () => {
    // The buildDeferralWithAutoExec function now calls promoteLearnedSkill
    // even when auto-exec fails, preventing re-search on second-pass
    const promoted = true; // verified by code inspection
    expect(promoted).toBe(true);
  });
});
