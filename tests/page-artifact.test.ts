import { describe, expect, it } from "bun:test";
import { buildPageArtifactCapture } from "../src/execution/index.js";

describe("page artifact capture", () => {
  it("creates a replayable page endpoint from structured html", () => {
    const html = `
      <html><body>
        <script type="application/json" data-target="react-app.embeddedData">
          {"payload":{"results":[
            {"followers":10000,"language":"TypeScript","hl_trunc_description":"Official SDK","repo":{"repository":{"owner_login":"openai","name":"openai-node"}}},
            {"followers":25000,"language":"Python","hl_trunc_description":"Python SDK","repo":{"repository":{"owner_login":"openai","name":"openai-python"}}}
          ]}}
        </script>
      </body></html>
    `;

    const artifact = buildPageArtifactCapture("https://github.com/search?q=openai&type=repositories", "search repositories", html);
    expect(artifact.endpoint?.dom_extraction?.extraction_method).toBe("repeated-elements");
    expect(Array.isArray(artifact.result?.data)).toBe(true);
  });
});
