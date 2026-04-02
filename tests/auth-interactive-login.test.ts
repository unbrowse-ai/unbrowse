import { describe, expect, it } from "bun:test";
import { assessInteractiveLoginState } from "../src/auth/index.js";

describe("assessInteractiveLoginState", () => {
  it("marks target-page cookies as authenticated", () => {
    const result = assessInteractiveLoginState({
      currentUrl: "https://www.linkedin.com/feed/",
      targetDomain: "www.linkedin.com",
      initialCookieCount: 0,
      currentCookieCount: 3,
    });

    expect(result.status).toBe("authenticated");
  });

  it("marks Cloudflare challenge as blocked", () => {
    const result = assessInteractiveLoginState({
      currentUrl: "https://x.com/home",
      targetDomain: "x.com",
      initialCookieCount: 1,
      currentCookieCount: 2,
      hasCloudflareChallenge: true,
    });

    expect(result).toEqual({ status: "blocked", reason: "cloudflare_challenge" });
  });

  it("keeps login pages pending", () => {
    const result = assessInteractiveLoginState({
      currentUrl: "https://www.linkedin.com/login",
      targetDomain: "www.linkedin.com",
      initialCookieCount: 0,
      currentCookieCount: 1,
    });

    expect(result).toEqual({ status: "pending", reason: "still_on_login_path" });
  });
});
