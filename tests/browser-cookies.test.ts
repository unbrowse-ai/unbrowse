import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeChromiumCookieValue, extractDefaultBrowserBundleIdFromLaunchServicesData, prioritizeChromiumCandidates, resolveChromiumCookiesPath } from "../src/auth/browser-cookies.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveChromiumCookiesPath", () => {
  it("prefers profile Network/Cookies when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "unbrowse-browser-cookies-"));
    tempDirs.push(dir);

    const cookieDb = join(dir, "Default", "Network", "Cookies");
    mkdirSync(join(dir, "Default", "Network"), { recursive: true });
    writeFileSync(cookieDb, "");

    expect(resolveChromiumCookiesPath({ userDataDir: dir })).toBe(cookieDb);
  });

  it("falls back to profile Cookies when Network/Cookies is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "unbrowse-browser-cookies-"));
    tempDirs.push(dir);

    const cookieDb = join(dir, "Profile 3", "Cookies");
    mkdirSync(join(dir, "Profile 3"), { recursive: true });
    writeFileSync(cookieDb, "");

    expect(resolveChromiumCookiesPath({ userDataDir: dir, profile: "Profile 3" })).toBe(cookieDb);
  });

  it("returns explicit cookie DB path unchanged", () => {
    const explicit = join(tmpdir(), "custom-electron", "Cookies");
    expect(resolveChromiumCookiesPath({ cookieDbPath: explicit })).toBe(explicit);
    expect(existsSync(explicit)).toBe(false);
  });
});

describe("decodeChromiumCookieValue", () => {
  it("prefers plaintext value when present", () => {
    expect(decodeChromiumCookieValue("plaintext-cookie", "", {})).toBe("plaintext-cookie");
  });
});

describe("extractDefaultBrowserBundleIdFromLaunchServicesData", () => {
  it("prefers https handler when present", () => {
    expect(extractDefaultBrowserBundleIdFromLaunchServicesData({
      LSHandlers: [
        { LSHandlerURLScheme: "http", LSHandlerRoleAll: "com.google.chrome" },
        { LSHandlerURLScheme: "https", LSHandlerRoleAll: "company.thebrowser.dia" },
      ],
    })).toBe("company.thebrowser.dia");
  });

  it("falls back to http handler", () => {
    expect(extractDefaultBrowserBundleIdFromLaunchServicesData({
      LSHandlers: [
        { LSHandlerURLScheme: "http", LSHandlerRoleAll: "com.google.chrome" },
      ],
    })).toBe("com.google.chrome");
  });
});

describe("prioritizeChromiumCandidates", () => {
  it("moves the preferred browser to the front", () => {
    const ordered = prioritizeChromiumCandidates([
      { name: "Chrome", userDataDir: "/tmp/chrome", safeStorageService: "Chrome Safe Storage", bundleId: "com.google.chrome" },
      { name: "Dia", userDataDir: "/tmp/dia", safeStorageService: "Dia Safe Storage", bundleId: "company.thebrowser.dia" },
      { name: "Arc", userDataDir: "/tmp/arc", safeStorageService: "Arc Safe Storage", bundleId: "company.thebrowser.Browser" },
    ], "company.thebrowser.dia");
    expect(ordered.map((candidate) => candidate.name)).toEqual(["Dia", "Chrome", "Arc"]);
  });
});
