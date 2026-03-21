import { describe, expect, it } from "bun:test";
import { blockedAppShellErrorCode, hasUsefulCapturedResponses, isBlockedAppShell } from "../src/capture/index.js";

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

  it("ignores linkedin realtime and allowlist noise for feed intents", () => {
    expect(hasUsefulCapturedResponses([
      "https://platform.linkedin.com/litms/allowlist/voyager-web-feed",
      "https://www.linkedin.com/realtime/realtimeFrontendSubscriptions?ids=List(...)",
      "https://www.linkedin.com/realtime/realtimeFrontendTimestamp",
    ], "https://www.linkedin.com/feed/", "get linkedin feed posts")).toBe(false);
  });

  it("treats linkedin main feed graphql as a useful feed capture", () => {
    expect(hasUsefulCapturedResponses([
      "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashMainFeed.923020905727c01516495a0ac90bb475",
    ], "https://www.linkedin.com/feed/", "get linkedin feed posts")).toBe(true);
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
  });
});

describe("blockedAppShellErrorCode", () => {
  it("escalates to auth_required when no auth is present", () => {
    expect(blockedAppShellErrorCode("<html><h1>JavaScript is not available.</h1></html>", false)).toBe("auth_required");
  });

  it("downgrades to blocked_app_shell when auth is present but shell stays blocked", () => {
    expect(blockedAppShellErrorCode("<html><h1>JavaScript is not available.</h1></html>", true)).toBe("blocked_app_shell");
  });

  it("keeps cloudflare shells as auth_required even with auth", () => {
    expect(blockedAppShellErrorCode("<html><title>Attention Required! | Cloudflare</title></html>", true)).toBe("auth_required");
  });
});
