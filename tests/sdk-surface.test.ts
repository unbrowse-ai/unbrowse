// Folded SDK surface — the single `unbrowse` package IS the SDK (import from
// `unbrowse/sdk`). Guards the consolidation: no separate @unbrowse/sdk or
// @unbrowse/client needed. Imports from source so it does not depend on a build.
import { test, expect } from "bun:test";
import { Unbrowse, createFetch, UnbrowseError } from "../packages/skill/src/sdk/index.js";

test("unbrowse/sdk exposes the HTTP-first client surface", () => {
  const client = new Unbrowse({ apiKey: "test", baseUrl: "https://beta-api.unbrowse.ai" });
  expect(typeof client.search).toBe("function");
  expect(typeof client.resolve).toBe("function");
  expect(typeof client.execute).toBe("function");
});

test("unbrowse/sdk exposes fetch helper + error types", () => {
  expect(typeof createFetch).toBe("function");
  expect(typeof UnbrowseError).toBe("function");
});
