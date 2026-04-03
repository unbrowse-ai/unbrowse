import { afterEach, describe, expect, it } from "bun:test";
import { shouldImportBrowserCookies } from "../src/runtime/browser-auth.js";

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
