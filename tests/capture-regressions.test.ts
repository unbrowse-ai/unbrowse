import { describe, expect, it } from "bun:test";
import { isBlockedAppShell, isChromiumNavigationError } from "../src/capture/index.js";

describe("capture regressions", () => {
  it("recognizes chromium net-error pages as navigation failures", () => {
    const html = `
      <html>
        <head><title>www.linkedin.com</title></head>
        <body>
          <div id="main-message">This site can't be reached</div>
          <div class="error-code">ERR_TUNNEL_CONNECTION_FAILED</div>
        </body>
      </html>
    `;

    expect(isChromiumNavigationError("chrome-error://chromewebdata/", html)).toBe(true);
    expect(isBlockedAppShell(html)).toBe(false);
  });

  it("does not classify normal html as chromium navigation error", () => {
    const html = "<html><body><main><article>hello world</article></main></body></html>";
    expect(isChromiumNavigationError("https://www.linkedin.com/feed/", html)).toBe(false);
  });
});
