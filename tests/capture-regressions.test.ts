import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { isBlockedAppShell, shouldRestartKuriForError } from "../src/capture/index.js";

function isChromiumNavigationError(url: string, html?: string): boolean {
  if (!url.startsWith("chrome-error://")) return false;
  return /ERR_[A-Z_]+|This site can't be reached|chrome-error/i.test(html ?? "");
}

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

  it("keeps the capture interceptor script compact enough for stable target-page injection", () => {
    const source = readFileSync(new URL("../src/capture/index.ts", import.meta.url), "utf8");
    const match = source.match(/const INTERCEPTOR_SCRIPT = `([\s\S]*?)`;/);
    expect(typeof match?.[1]).toBe("string");
    expect(match![1].length).toBeLessThan(3000);
  });

  it("treats empty-kuri-tab failures as restartable transport errors", () => {
    expect(shouldRestartKuriForError(new Error("No tabs available and failed to create one"))).toBe(true);
  });
});
