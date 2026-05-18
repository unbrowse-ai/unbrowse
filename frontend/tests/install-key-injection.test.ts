/**
 * Soft-gate install: pure-function contract for baking UNBROWSE_API_KEY
 * into the three install command shapes.
 *
 * No mocks. The helpers are pure string transforms — call, assert.
 * Structural test at the bottom pins that the `<InstallInstructions />`
 * component actually uses these helpers (no copy-paste regression where
 * the toggle UI renders but the commands stay un-keyed).
 */

import { test, expect } from "bun:test";
import {
  injectKeyIntoCommandText,
  injectKeyIntoCopyText,
  maskApiKey,
} from "../src/lib/install-key-injection";

const REAL_KEY = "uk_live_AbCdEf1234567890XYZ";
const MASKED = maskApiKey(REAL_KEY); // uk_••••0XYZ

// ---------------------------------------------------------------------------
// maskApiKey
// ---------------------------------------------------------------------------

test("maskApiKey: keeps last 4 chars after a `uk_••••` prefix", () => {
  expect(maskApiKey("uk_live_AbCdEf1234567890XYZ")).toBe("uk_••••0XYZ");
});

test("maskApiKey: short keys (under 4 chars) get the whole key as tail", () => {
  expect(maskApiKey("ab")).toBe("uk_••••ab");
});

// ---------------------------------------------------------------------------
// injectKeyIntoCommandText — operates on the on-screen terminal-line text
// ---------------------------------------------------------------------------

test("commandText: noop when key is null", () => {
  expect(
    injectKeyIntoCommandText("  $  npx unbrowse setup --mcp", null),
  ).toBe("  $  npx unbrowse setup --mcp");
  expect(
    injectKeyIntoCommandText("  $  claude mcp add unbrowse -- npx -y unbrowse mcp", null),
  ).toBe("  $  claude mcp add unbrowse -- npx -y unbrowse mcp");
});

test("commandText: `npx unbrowse setup --mcp` gets env-var prefix", () => {
  const out = injectKeyIntoCommandText("  $  npx unbrowse setup --mcp", MASKED);
  expect(out).toBe(`  $  UNBROWSE_API_KEY=${MASKED} npx unbrowse setup --mcp`);
});

test("commandText: `claude mcp add unbrowse` gets `-e KEY=v` between `add` and `unbrowse`", () => {
  const out = injectKeyIntoCommandText(
    "  $  claude mcp add unbrowse -- npx -y unbrowse mcp",
    MASKED,
  );
  expect(out).toBe(
    `  $  claude mcp add -e UNBROWSE_API_KEY=${MASKED} unbrowse -- npx -y unbrowse mcp`,
  );
});

test("commandText: mcp.json snippet gets an `env` field spliced in", () => {
  const json = `  {  "unbrowse": { "command": "npx", "args": ["-y", "unbrowse", "mcp"] }  }`;
  const out = injectKeyIntoCommandText(json, MASKED);
  expect(out).toContain(`"args": ["-y", "unbrowse", "mcp"]`);
  expect(out).toContain(`"env": { "UNBROWSE_API_KEY": "${MASKED}" }`);
  // Order: env field lands AFTER args, inside the same object.
  expect(out.indexOf(`"args"`)).toBeLessThan(out.indexOf(`"env"`));
});

test("commandText: comment lines and verify commands are NOT mutated", () => {
  expect(injectKeyIntoCommandText("  ##  one command", MASKED)).toBe("  ##  one command");
  expect(injectKeyIntoCommandText("  $  claude mcp list", MASKED)).toBe("  $  claude mcp list");
});

// ---------------------------------------------------------------------------
// injectKeyIntoCopyText — ships the FULL key (not masked) to the clipboard
// ---------------------------------------------------------------------------

test("copyText: noop when key is null", () => {
  expect(injectKeyIntoCopyText("npx unbrowse setup --mcp", null)).toBe(
    "npx unbrowse setup --mcp",
  );
});

test("copyText: `npx unbrowse setup --mcp` gets the REAL key as env prefix", () => {
  expect(injectKeyIntoCopyText("npx unbrowse setup --mcp", REAL_KEY)).toBe(
    `UNBROWSE_API_KEY=${REAL_KEY} npx unbrowse setup --mcp`,
  );
});

test("copyText: `claude mcp add unbrowse -- npx -y unbrowse mcp` gets the REAL key via -e", () => {
  expect(
    injectKeyIntoCopyText(
      "claude mcp add unbrowse -- npx -y unbrowse mcp",
      REAL_KEY,
    ),
  ).toBe(
    `claude mcp add -e UNBROWSE_API_KEY=${REAL_KEY} unbrowse -- npx -y unbrowse mcp`,
  );
});

test("copyText: unrecognized commands pass through unchanged", () => {
  expect(injectKeyIntoCopyText("ls -la", REAL_KEY)).toBe("ls -la");
});

// ---------------------------------------------------------------------------
// Display key NEVER equals the real key — masking guarantee
// ---------------------------------------------------------------------------

test("masking: the on-screen command never contains the real key when callers pass the masked one", () => {
  const screen = injectKeyIntoCommandText("  $  npx unbrowse setup --mcp", MASKED);
  expect(screen).not.toContain(REAL_KEY);
  expect(screen).toContain(MASKED);
});

// ---------------------------------------------------------------------------
// Structural: <InstallInstructions /> actually wires these helpers in
// ---------------------------------------------------------------------------

test("install-instructions.tsx imports and uses the injection helpers + useAuth", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { fileURLToPath } = require("node:url");
  const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
  const COMP = path.resolve(
    TEST_DIR,
    "..",
    "src",
    "components",
    "install-instructions.tsx",
  );
  const src = fs.readFileSync(COMP, "utf8");
  // Imports
  expect(src.includes('from "@/lib/auth-context"')).toBe(true);
  expect(src.includes('from "@/lib/install-key-injection"')).toBe(true);
  expect(src.includes("injectKeyIntoCommandText")).toBe(true);
  expect(src.includes("injectKeyIntoCopyText")).toBe(true);
  // useAuth is read for apiKey + auth state
  expect(/useAuth\(\)/.test(src)).toBe(true);
  // Toggle state is wired
  expect(src.includes("connectAccount")).toBe(true);
  expect(src.includes("setConnectAccount")).toBe(true);
  // Copy button ships the transformed value, not the raw tab.copyText
  expect(/clipboard\.writeText\(copyValue\)/.test(src)).toBe(true);
  // Account-handoff row is testable
  expect(src.includes('data-testid="install-account-row"')).toBe(true);
  // Sign-in link is surfaced when unauthenticated
  expect(src.includes('href="/login"')).toBe(true);
});

test("install-instructions.tsx fires install_command_copied telemetry on COPY with tab_id + baked_account", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { fileURLToPath } = require("node:url");
  const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
  const COMP = path.resolve(
    TEST_DIR,
    "..",
    "src",
    "components",
    "install-instructions.tsx",
  );
  const src = fs.readFileSync(COMP, "utf8");
  // The funnel-event helper is imported
  expect(src.includes('from "@/lib/web-telemetry"')).toBe(true);
  // Event name matches the one hero-cta.tsx already uses (single source
  // of truth for "user copied an install command" across surfaces).
  // The regex enforces the call is LIVE — a line that starts with
  // whitespace + `trackWebEvent(` — not `// trackWebEvent(`. Without this
  // guard the test passes against commented-out code (painted lamp).
  expect(/^\s*trackWebEvent\("install_command_copied"/m.test(src)).toBe(true);
  // The event payload carries the tab_id (which host) and baked_account
  // (whether the soft-gate actually baked the user's API key).
  expect(/^\s*tab_id:\s*tab\.id/m.test(src)).toBe(true);
  expect(/^\s*baked_account:\s*Boolean\(baked\)/m.test(src)).toBe(true);
  // surface distinguishes this widget from the hero CTA in analytics
  expect(/^\s*surface: "install-instructions"/m.test(src)).toBe(true);
});
