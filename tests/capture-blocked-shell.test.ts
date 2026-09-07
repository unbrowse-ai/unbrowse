import { describe, expect, it } from "bun:test";
import { hasUsefulCapturedResponses, isBlockedAppShell } from "../src/capture/index.js";

describe("isBlockedAppShell", () => {
  it("detects x blocked shell markers", () => {
    const html = `
      <html>
        <body>
          <style>#placeholder, #react-root { display: none !important; }</style>
          <div class="errorContainer">
            <h1>JavaScript is not available.</h1>
            <p>Please enable JavaScript or switch to a supported browser.</p>
          </div>
        </body>
      </html>
    `;
    expect(isBlockedAppShell(html)).toBe(true);
  });

  it("does not flag a normal rendered x profile page", () => {
    const html = `
      <html>
        <head>
          <title>OpenAI (@OpenAI) / X</title>
          <meta property="og:title" content="OpenAI (@OpenAI) / X" />
        </head>
        <body>
          <div id="react-root">
            <span>OpenAI</span>
            <span>@OpenAI</span>
            <span>4.6M Followers</span>
          </div>
        </body>
      </html>
    `;
    expect(isBlockedAppShell(html)).toBe(false);
  });

  it("treats real x profile APIs as useful captured responses", () => {
    const urls = [
      "https://x.com/i/api/graphql/pLsOiyHJ1eFwPJlNmLp4Bg/UserByScreenName?variables=...",
      "https://x.com/i/api/graphql/ix7iRrsAvfXyGUQ06Z7krA/UserTweets?variables=...",
    ];
    expect(hasUsefulCapturedResponses(urls, "https://x.com/OpenAI", "get user profile")).toBe(true);
  });

  it("ignores noisy x bootstrap responses when deciding to retry", () => {
    const urls = [
      "https://x.com/i/api/1.1/graphql/user_flow.json",
      "https://x.com/i/api/graphql/xF6sXnKJfS2AOylzxRjf6A/DataSaverMode?variables=...",
      "https://x.com/i/api/1.1/graphql/ces/p2",
    ];
    expect(hasUsefulCapturedResponses(urls, "https://x.com/OpenAI", "get user profile")).toBe(false);
  });

  it("does not treat discord /channels/@me as a server-list capture hit", () => {
    const urls = [
      "https://discord.com/api/v9/channels/@me",
    ];
    expect(hasUsefulCapturedResponses(urls, "https://discord.com/channels/@me", "list my discord servers")).toBe(false);
    expect(hasUsefulCapturedResponses([
      "https://discord.com/api/v9/users/@me/guilds",
    ], "https://discord.com/channels/@me", "list my discord servers")).toBe(true);
  });

  it("allows sparse blocked-shell retries but not rich captures", () => {
    const sparseUrls = [
      "https://x.com/i/api/graphql/xF6sXnKJfS2AOylzxRjf6A/DataSaverMode?variables=...",
      "https://x.com/i/api/1.1/graphql/ces/p2",
    ];
    const richUrls = [
      ...sparseUrls,
      "https://x.com/i/api/graphql/7IgnUakthBSeOmeC87zOQg/ExplorePage?variables=...",
      "https://x.com/i/api/graphql/Cjgmbh_ZixfMc0IIUNjP7A/GenericTimelineById?variables=...",
      "https://x.com/i/api/graphql/pLsOiyHJ1eFwPJlNmLp4Bg/UserByScreenName?variables=...",
      "https://x.com/i/api/graphql/ix7iRrsAvfXyGUQ06Z7krA/UserTweets?variables=...",
      "https://x.com/i/api/graphql/vqu78dKcEkW-UAYLw5rriA/useFetchProfileSections_canViewExpandedProfileQuery?variables=...",
      "https://x.com/i/api/graphql/mzoqrVGwk-YTSGME1dRfXQ/ProfileSpotlightsQuery?variables=...",
      "https://x.com/i/api/graphql/X3WQ-9Sjj1mz7BChTCzMiA/ExploreSidebar?variables=...",
      "https://x.com/i/api/1.1/hashflags.json",
      "https://x.com/i/api/1.1/users/email_phone_info.json",
    ];
    expect(sparseUrls.length).toBeLessThan(10);
    expect(richUrls.length).toBeGreaterThanOrEqual(10);
    expect(hasUsefulCapturedResponses(sparseUrls, "https://x.com", "search tweets")).toBe(false);
    expect(hasUsefulCapturedResponses(richUrls, "https://x.com", "search tweets")).toBe(true);
  });

  it("treats a high-volume blocked-shell capture as progress even without direct timeline hints", () => {
    const proxseeOnlyUrls = Array.from({ length: 30 }, (_, i) =>
      `https://proxsee.pscp.tv/api/v2/bootstrap-${i}.json`
    );
    expect(proxseeOnlyUrls.length).toBeGreaterThanOrEqual(25);
    expect(hasUsefulCapturedResponses(proxseeOnlyUrls, "https://x.com", "search tweets")).toBe(false);
  });
});
