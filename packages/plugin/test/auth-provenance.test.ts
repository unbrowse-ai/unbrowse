import { describe, expect, it } from "bun:test";
import { applyCsrfProvenance, inferCsrfProvenance } from "@getfoundry/unbrowse-core";

describe("auth-provenance", () => {
  it("infers csrf header source from matching cookie value", () => {
    const provenance = inferCsrfProvenance({
      authHeaders: { "csrf-token": "ajax:12345" },
      cookies: { JSESSIONID: "ajax:12345" },
    });
    expect(provenance).toBeTruthy();
    expect(provenance?.rules[0]?.targetHeader).toBe("csrf-token");
    expect(provenance?.rules[0]?.sourceType).toBe("cookie");
    expect(provenance?.rules[0]?.sourceKey).toBe("JSESSIONID");
  });

  it("applies cookie-backed csrf rule to refresh request header", () => {
    const provenance = inferCsrfProvenance({
      authHeaders: { "x-csrf-token": "abc-old" },
      cookies: { _csrf: "abc-old" },
    });
    const applied = applyCsrfProvenance({
      authHeaders: { "x-csrf-token": "abc-old" },
      cookies: { _csrf: "abc-new" },
      csrfProvenance: provenance,
    });
    expect(applied.authHeaders["x-csrf-token"]).toBe("abc-new");
    expect(applied.applied.length).toBeGreaterThan(0);
  });
});
