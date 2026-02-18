import { describe, it, expect } from "bun:test";
import { extractAuthHeaders } from "@getfoundry/unbrowse-core";

describe("session-login auth header extraction", () => {
  it("captures non-standard request headers via blocklist filtering", () => {
    const captured: any[] = [
      {
        method: "GET",
        url: "https://www.linkedin.com/voyager/api/me",
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
          "csrf-token": "ajax:123",
          "x-li-track": "{\"clientVersion\":\"1\"}",
          "authorization": "Bearer abc",
          "sec-fetch-mode": "cors",
        },
        resourceType: "xhr",
        status: 200,
        responseHeaders: {},
        timestamp: Date.now(),
      },
    ];

    const out = extractAuthHeaders(captured as any, {}, {});

    expect(out["csrf-token"]).toBe("ajax:123");
    expect(out["x-li-track"]).toBe("{\"clientVersion\":\"1\"}");
    expect(out.authorization).toBe("Bearer abc");
    expect(out.accept).toBeUndefined();
    expect(out["content-type"]).toBeUndefined();
    expect(out["sec-fetch-mode"]).toBeUndefined();
  });

  it("promotes tokens from storage into auth headers", () => {
    const out = extractAuthHeaders(
      [],
      { accessToken: "eyJ.local.jwt", csrfToken: "csrf-local" },
      { authToken: "Bearer from-session" },
    );

    expect(out.authorization).toBe("Bearer from-session");
    expect(out["x-csrf-token"]).toBe("csrf-local");
  });
});
