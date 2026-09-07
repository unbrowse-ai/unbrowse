import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
  delete process.env.UNBROWSE_HOME;
});

describe("browser-path-config memory", () => {
  it("persists setBrowserPath + prefer under UNBROWSE_HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "unbrowse-browser-paths-"));
    tempDirs.push(home);
    process.env.UNBROWSE_HOME = home;

    // Re-import after env so getUnbrowseHome sees it — dynamic import of module.
    const mod = await import("../src/auth/browser-path-config.js");
    const profileDir = join(home, "fake-chromium");
    mkdirSync(profileDir, { recursive: true });

    mod.setBrowserPath("chromium", profileDir, { profile: "Default", prefer: true });
    const loaded = mod.loadBrowserPathConfig();
    expect(loaded.prefer).toBe("chromium");
    expect(loaded.browsers.chromium?.userDataDir).toBe(profileDir);
    expect(loaded.browsers.chromium?.profile).toBe("Default");
    expect(existsSync(mod.browserPathConfigFile())).toBe(true);

    // No secrets in file
    const raw = await Bun.file(mod.browserPathConfigFile()).text();
    expect(raw).not.toMatch(/session|cookie.?value|password/i);
    expect(raw).toContain("chromium");
    expect(raw).toContain(profileDir);
  });

  it("configuredRootsForFamily returns remembered chromium paths that exist", async () => {
    const home = mkdtempSync(join(tmpdir(), "unbrowse-browser-paths-"));
    tempDirs.push(home);
    process.env.UNBROWSE_HOME = home;
    const mod = await import("../src/auth/browser-path-config.js");
    const profileDir = join(home, "chromium-ud");
    mkdirSync(profileDir, { recursive: true });
    mod.setBrowserPath("chromium", profileDir);
    const roots = mod.configuredRootsForFamily("chromium");
    expect(roots).toContain(profileDir);
  });
});
