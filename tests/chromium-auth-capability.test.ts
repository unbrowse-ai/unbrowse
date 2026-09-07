import { describe, expect, it } from "bun:test";
import { getAuthCaptureCapability } from "../src/cli-v7/breath/auth-capture.js";
import { loginWithBrowserFallback } from "../src/auth/index.js";

describe("Chromium auth-capture capability", () => {
  it("refuses before launch when the credential sink is unavailable", () => {
    const capability = getAuthCaptureCapability();

    expect(capability.browser_family).toBe("chromium");
    expect(capability.credential_store).toBe("macos-keychain");
    if (process.platform !== "darwin") {
      expect(capability).toEqual({
        available: false,
        browser_family: "chromium",
        credential_store: "macos-keychain",
        reason: "unsupported_platform",
      });
    }
  });
});

describe("Chromium interactive auth fallback", () => {
  it("propagates the target domain to interactive capture", async () => {
    let receivedDomain: string | undefined;

    await loginWithBrowserFallback(
      "https://accounts.example.com/login",
      { browser: "chrome", interactiveOnly: true },
      {
        interactiveLogin: async (_url, domain) => {
          receivedDomain = domain;
          return { success: false, domain: domain!, cookies_stored: 0 };
        },
      },
    );

    expect(receivedDomain).toBe("accounts.example.com");
  });
});
