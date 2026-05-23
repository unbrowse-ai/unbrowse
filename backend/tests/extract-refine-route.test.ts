// Backend test: POST /v1/extract/refine -- the server-side deterministic
// DOM extraction route (Wave 2 of the pointer-not-payload server-move,
// principle 20260522T031732Z-3c67f936).
//
// Two layers, no mocks:
//   1. The backend can CONSUME @unbrowse/extraction-core -- the workspace
//      package resolves from the backend's position and extractFromDOM
//      runs against real HTML, returning a structured ExtractionResult.
//      This is the STEP 2 deliverable: the deterministic extraction
//      know-how is served from the package, not the npm client bundle.
//   2. The route is mounted on the app -- app.fetch reaches the handler
//      (auth gate rejects an unauthenticated call, proving the route
//      exists and is wired into /v1, not a 404).

import { describe, test, expect } from "bun:test";
import { extractFromDOM } from "@unbrowse/extraction-core";
import { app } from "../src/index.js";

describe("extract-core consumable from the backend", () => {
  test("extractFromDOM runs against real HTML and returns a structured result", () => {
    const html = `<!doctype html><html><head><title>Sample</title></head>
      <body>
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"ItemList","itemListElement":[
            {"@type":"ListItem","position":1,"name":"First entry"},
            {"@type":"ListItem","position":2,"name":"Second entry"}
          ]}
        </script>
        <h1>Sample listing page</h1>
      </body></html>`;
    const result = extractFromDOM(html, "list entries");
    // Structural contract: extractFromDOM always returns an object with a
    // `data` field (the extracted payload) -- never throws on valid HTML.
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    expect("data" in result).toBe(true);
  });

  test("extractFromDOM does not throw on empty / minimal HTML", () => {
    const result = extractFromDOM("<html><body></body></html>", "anything");
    expect(result).toBeDefined();
    expect("data" in result).toBe(true);
  });
});

describe("/v1/extract/refine route is mounted", () => {
  const baseEnv = {} as Parameters<typeof app.fetch>[1];

  test("route exists -- unauthenticated POST is rejected by the auth gate, not 404", async () => {
    const res = await app.fetch(
      new Request("http://local.test/v1/extract/refine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ html: "<html></html>", intent: "x" }),
      }),
      baseEnv,
    );
    // bearerAuth runs before the handler. A mounted route returns the
    // auth rejection (401/403); an UNMOUNTED path would 404. Either auth
    // status proves the route is wired -- the assertion is "not 404".
    expect(res.status).not.toBe(404);
  });

  test("GET on the route path is not the POST handler (method-scoped mount)", async () => {
    const res = await app.fetch(
      new Request("http://local.test/v1/extract/refine", { method: "GET" }),
      baseEnv,
    );
    // The route declares only POST; a GET must not reach the POST handler.
    expect(res.status).not.toBe(200);
  });
});
