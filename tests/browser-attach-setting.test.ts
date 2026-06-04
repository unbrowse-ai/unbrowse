// Real test (no mocks, real temp config dir) for the persisted
// browser.attach_existing_chrome opt-out. Proves: North Star default is
// attach; an explicit false opts out; true restores; the env knob
// KURI_DISABLE_CDP_ATTACH still overrides regardless of the setting.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBrowserAttachEnabled, setBrowserAttachEnabled } from "../src/settings.ts";
import { resolveKuriLaunchConfig } from "../src/kuri/client.ts";

let dir = "";
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.UNBROWSE_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "attach-setting-"));
  process.env.UNBROWSE_CONFIG_DIR = dir;
});
afterEach(() => {
  if (prev !== undefined) process.env.UNBROWSE_CONFIG_DIR = prev;
  else delete process.env.UNBROWSE_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test("default (no setting) = attach (North Star preserved)", () => {
  expect(getBrowserAttachEnabled()).toBe(true);
  expect(resolveKuriLaunchConfig({}).attachToExistingChrome).toBe(true);
});

test("setBrowserAttachEnabled(false) opts out: no attach, managed Chrome", () => {
  setBrowserAttachEnabled(false);
  expect(getBrowserAttachEnabled()).toBe(false);
  expect(resolveKuriLaunchConfig({}).attachToExistingChrome).toBe(false);
  // headless default still true -> clean managed HEADLESS chrome
  expect(resolveKuriLaunchConfig({}).headless).toBe(true);
});

test("setBrowserAttachEnabled(true) restores attach", () => {
  setBrowserAttachEnabled(false);
  setBrowserAttachEnabled(true);
  expect(getBrowserAttachEnabled()).toBe(true);
  expect(resolveKuriLaunchConfig({}).attachToExistingChrome).toBe(true);
});

test("env KURI_DISABLE_CDP_ATTACH=1 overrides even when setting=true", () => {
  setBrowserAttachEnabled(true);
  expect(resolveKuriLaunchConfig({ KURI_DISABLE_CDP_ATTACH: "1" }).attachToExistingChrome).toBe(false);
});

test("setting false persists across reload (config.json)", () => {
  setBrowserAttachEnabled(false);
  // fresh read from disk (no in-memory cache) still false
  expect(getBrowserAttachEnabled()).toBe(false);
});
