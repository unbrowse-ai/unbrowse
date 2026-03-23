import { describe, expect, it } from "bun:test";
import { detectAuthWallFromPage } from "../src/execution/index.js";

describe("detectAuthWallFromPage", () => {
  it("classifies blocked x home shells as auth required", () => {
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

    expect(
      detectAuthWallFromPage("https://x.com/home", "https://x.com/home", html),
    ).toEqual({
      provider: "x.com",
      login_url: "https://x.com/i/flow/login",
      reason: "blocked app shell",
    });
  });

  it("classifies linkedin feed login prompts as auth required", () => {
    const html = `
      <html>
        <head><title>LinkedIn</title></head>
        <body>
          <main>
            <h1>Sign in</h1>
            <p>Join now to see posts from people you know.</p>
          </main>
        </body>
      </html>
    `;

    expect(
      detectAuthWallFromPage("https://www.linkedin.com/feed/", "https://www.linkedin.com/feed/", html),
    ).toEqual({
      provider: "linkedin.com",
      login_url: "https://www.linkedin.com/uas/login",
      reason: "login prompt",
    });
  });

  it("does not classify public landing pages with auth ctas as protected auth walls", () => {
    const html = `
      <html>
        <head><title>X. It’s what’s happening</title></head>
        <body>
          <main>
            <p>See what’s happening in the world right now.</p>
            <a href="/i/flow/login">Sign in</a>
            <a href="/i/flow/signup">Create account</a>
          </main>
        </body>
      </html>
    `;

    expect(
      detectAuthWallFromPage("https://x.com/", "https://x.com/", html),
    ).toBeNull();
  });
});
