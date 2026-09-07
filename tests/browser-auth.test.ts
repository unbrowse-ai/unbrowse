import { afterEach, describe, expect, it } from "bun:test";
// The single live definition. `src/runtime/browser-auth.ts` carried a second,
// byte-equivalent copy with no production caller — this test was its only
// importer — so it was deleted and this file repointed at the one the product
// actually consults (src/cli-v7/breath/go.ts, src/orchestrator/direct-document.ts,
// and importBrowserCookiesIntoTab itself all import from here).
import { shouldImportBrowserCookies } from "../src/auth/index.js";

const ORIGINAL = process.env.UNBROWSE_IMPORT_BROWSER_COOKIES;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.UNBROWSE_IMPORT_BROWSER_COOKIES;
  else process.env.UNBROWSE_IMPORT_BROWSER_COOKIES = ORIGINAL;
});

describe("browser auth runtime flags", () => {
  it("imports browser cookies by default", () => {
    delete process.env.UNBROWSE_IMPORT_BROWSER_COOKIES;
    expect(shouldImportBrowserCookies()).toBe(true);
  });

  it("allows explicit opt-out for clean browser sessions", () => {
    process.env.UNBROWSE_IMPORT_BROWSER_COOKIES = "0";
    expect(shouldImportBrowserCookies()).toBe(false);

    process.env.UNBROWSE_IMPORT_BROWSER_COOKIES = "false";
    expect(shouldImportBrowserCookies()).toBe(false);
  });
});
