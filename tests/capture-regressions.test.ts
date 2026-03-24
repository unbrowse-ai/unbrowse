import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  hasUsefulCapturedResponsesBeyondPageShell,
  isBlockedAppShell,
  matchesTriggerTargetUrl,
  shouldRestartKuriForError,
} from "../src/capture/index.js";

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

  it("does not treat the search page itself as a useful captured response for search flows", () => {
    const urls = [
      "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
    ];

    expect(
      hasUsefulCapturedResponsesBeyondPageShell(
        urls,
        "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
        "search Singapore case law for leave to adduce new evidence",
      ),
    ).toBe(false);

    expect(
      hasUsefulCapturedResponsesBeyondPageShell(
        [
          ...urls,
          "https://www.lawnet.sg/lawnet/group/lawnet/result-page?action=basicSearch",
        ],
        "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
        "search Singapore case law for leave to adduce new evidence",
      ),
    ).toBe(true);
  });

  it("treats full-page navigation to the target result page as trigger success", () => {
    expect(
      matchesTriggerTargetUrl(
        "https://www.lawnet.sg/lawnet/group/lawnet/result-page?p_p_id=legalresearchresultpage_WAR_lawnet3legalresearchportlet",
        "https://www.lawnet.sg/lawnet/group/lawnet/result-page",
        null,
      ),
    ).toBe(true);
  });
});
