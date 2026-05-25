import { describe, expect, test } from "bun:test";
import { buildPageArtifactCapture } from "../src/execution/index.js";

describe("GitHub profile DOM extraction", () => {
  test("profile pages are not relabeled as search-form artifacts because of the global header search", () => {
    const html = `<!doctype html>
      <html>
        <head>
          <link rel="canonical" href="https://github.com/octocat">
          <meta property="og:type" content="profile">
          <meta property="og:title" content="The Octocat (@octocat)">
          <meta property="og:description" content="GitHub mascot and test profile">
        </head>
        <body>
          <header>
            <form action="/search"><input type="search" name="q"><button type="submit">Search</button></form>
          </header>
          <main>
            <h1>The Octocat</h1>
            <p>GitHub mascot and test profile</p>
          </main>
        </body>
      </html>`;

    const artifact = buildPageArtifactCapture(
      "https://github.com/octocat",
      "get github profile",
      html,
    );

    expect(artifact.endpoint).toBeDefined();
    expect(artifact.endpoint?.description).toBe("Captured page artifact for get github profile");
    expect(artifact.endpoint?.dom_extraction?.search_form).toBeUndefined();
    expect(artifact.result?._extraction).not.toHaveProperty("search_form_detected");
    expect(artifact.result?.data).toMatchObject({
      name: "The Octocat",
      username: "octocat",
      public_identifier: "octocat",
    });
  });
});
