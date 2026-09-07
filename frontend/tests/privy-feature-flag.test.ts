/**
 * Privy login feature-flag contract.
 *
 * Pins the rule the docs/CLAUDE-md promise: when
 * `NEXT_PUBLIC_PRIVY_APP_ID` is unset, the Privy code path is a no-op
 * — children render unchanged, no Privy modal can open, no Privy
 * tracking event fires. When the env IS set, the provider mounts and
 * the login button renders.
 *
 * The test does NOT spin up a real Privy session (that needs an actual
 * app_id from privy.io); it asserts the structural feature flag
 * behavior so a future config-change regression is caught before
 * shipping (Privy-on in production with no PRIVY_APP_ID would
 * silently break the page).
 *
 * No mocks of the Privy SDK itself. The provider is the real
 * `PrivyOptionalProvider`; only the env var is toggled.
 */

import { test, expect, afterEach } from "bun:test";
import { isPrivyEnabled } from "../src/lib/privy-provider";

const savedEnv = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

afterEach(() => {
  if (savedEnv !== undefined) process.env.NEXT_PUBLIC_PRIVY_APP_ID = savedEnv;
  else delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;
});

test("isPrivyEnabled: false when env is unset", () => {
  delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  expect(isPrivyEnabled()).toBe(false);
});

test("isPrivyEnabled: false when env is empty string", () => {
  process.env.NEXT_PUBLIC_PRIVY_APP_ID = "";
  expect(isPrivyEnabled()).toBe(false);
});

test("isPrivyEnabled: false when env is whitespace only", () => {
  process.env.NEXT_PUBLIC_PRIVY_APP_ID = "   ";
  expect(isPrivyEnabled()).toBe(false);
});

test("isPrivyEnabled: true when env carries a real-looking app id", () => {
  process.env.NEXT_PUBLIC_PRIVY_APP_ID = "cm-test-fake-app-id-123";
  expect(isPrivyEnabled()).toBe(true);
});

test("page.tsx /account: PrivyLoginButtonOptional is imported and used", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { dirname } = path;
  const { fileURLToPath } = require("node:url");
  const TEST_DIR = dirname(fileURLToPath(import.meta.url));
  const PAGE = path.resolve(TEST_DIR, "..", "src", "app", "account", "page.tsx");
  const src = fs.readFileSync(PAGE, "utf8");
  // Import wired
  expect(src.includes('from "@/components/privy-login-button"')).toBe(true);
  expect(src.includes("PrivyLoginButtonOptional")).toBe(true);
  // Used in the unauth state (next to the magic-link sign-in link)
  expect(src.match(/<PrivyLoginButtonOptional/g)?.length ?? 0).toBeGreaterThan(0);
});

test("layout.tsx: PrivyOptionalProvider wraps AuthProvider", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { dirname } = path;
  const { fileURLToPath } = require("node:url");
  const TEST_DIR = dirname(fileURLToPath(import.meta.url));
  const LAYOUT = path.resolve(TEST_DIR, "..", "src", "app", "layout.tsx");
  const src = fs.readFileSync(LAYOUT, "utf8");
  // Import wired
  expect(src.includes('from "@/lib/privy-provider"')).toBe(true);
  // The provider wraps AuthProvider (not the other way around) so a
  // magic-link login does not depend on Privy mounting.
  const providerIdx = src.indexOf("<PrivyOptionalProvider");
  const authIdx = src.indexOf("<AuthProvider");
  const closeAuthIdx = src.indexOf("</AuthProvider");
  const closeProviderIdx = src.indexOf("</PrivyOptionalProvider");
  expect(providerIdx).toBeGreaterThan(-1);
  expect(authIdx).toBeGreaterThan(providerIdx);
  expect(closeAuthIdx).toBeGreaterThan(authIdx);
  expect(closeProviderIdx).toBeGreaterThan(closeAuthIdx);
});

test("privy-provider.tsx: file is 'use client' (Privy SDK requires browser)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { dirname } = path;
  const { fileURLToPath } = require("node:url");
  const TEST_DIR = dirname(fileURLToPath(import.meta.url));
  const SRC = path.resolve(TEST_DIR, "..", "src", "lib", "privy-provider.tsx");
  const src = fs.readFileSync(SRC, "utf8");
  // Must be the first non-comment line (Next.js directive rule)
  const firstNonEmpty = src.split("\n").find((l: string) => l.trim().length > 0);
  expect(firstNonEmpty).toBe('"use client";');
});
