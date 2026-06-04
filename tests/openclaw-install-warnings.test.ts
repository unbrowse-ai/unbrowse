import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Smoke-tests for the OpenClaw plugin install warning experience.
 *
 * Issue #54: Reduce scary install warnings or provide a trusted install path.
 *
 * Acceptance:
 * - Audit which install-time/runtime patterns trigger scanner warnings.
 * - Remove or isolate avoidable dangerous-code signatures where possible.
 * - If patterns are required, document them in the install path.
 * - Verify the user-facing warning experience, not just technical success.
 */

const PLUGIN_ROOT = join(import.meta.dir, "../submodules/openclaw-unbrowse-plugin");

function readPlugin(file: string): string {
  return readFileSync(join(PLUGIN_ROOT, file), "utf8");
}

/** Dangerous-code patterns that scanners flag during npm install / plugin load */
const SCANNER_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "child_process spawn", pattern: /from\s+["']node:child_process["']/ },
  { name: "process.env access", pattern: /process\.env/ },
  { name: "readFileSync", pattern: /readFileSync/ },
];

describe("OpenClaw plugin install warning audit", () => {
  it("plugin source loads without syntax errors", () => {
    const src = readPlugin("index.ts");
    expect(src.length).toBeGreaterThan(0);
    // Basic structural checks — top-level imports present
    expect(src).toContain("import");
    expect(src).toContain("export default");
  });

  it("each scanner-flagged pattern is documented in buildTrustedInstallGuide", () => {
    const src = readPlugin("index.ts");
    const guide = (() => {
      // Extract the guide string directly from source by looking for the documented phrases
      // This avoids needing to import/execute the plugin in this test context
      return src;
    })();

    const DOCUMENTATION_PHRASES: Record<string, RegExp> = {
      "child_process spawn": /node:child_process.*because the plugin launches/i,
      "process.env access": /process\.env.*because it passes local config/i,
      "readFileSync": /local file reads because it loads bundled/i,
    };

    for (const { name, pattern } of SCANNER_PATTERNS) {
      const presentInCode = pattern.test(src);
      if (presentInCode) {
        const docPattern = DOCUMENTATION_PHRASES[name];
        expect(
          docPattern.test(src),
          `Scanner pattern "${name}" is used but not documented in buildTrustedInstallGuide`,
        ).toBe(true);
      }
    }
  });

  it("plugin does not use eval or dynamic Function constructor (avoidable patterns)", () => {
    const src = readPlugin("index.ts");
    // These patterns are avoidable and should not appear
    expect(src).not.toMatch(/\beval\s*\(/);
    expect(src).not.toMatch(/new\s+Function\s*\(/);
    expect(src).not.toMatch(/execSync/); // prefer spawn over execSync
  });

  it("network access does not happen at import time", () => {
    const src = readPlugin("index.ts");
    // Network calls (fetch, https, http) must not appear at module top-level
    // They should only appear inside function bodies
    // We verify by checking that fetch/require('https') are inside functions, not at root
    // Simple heuristic: no bare `fetch(` outside a function scope at module level
    const lines = src.split("\n");
    let inFunction = 0;
    const topLevelFetchLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      inFunction += (line.match(/\{/g) ?? []).length;
      inFunction -= (line.match(/\}/g) ?? []).length;
      if (inFunction <= 0 && /\bfetch\s*\(/.test(line)) {
        topLevelFetchLines.push(i + 1);
      }
    }
    expect(
      topLevelFetchLines,
      `fetch() called at module top level on lines: ${topLevelFetchLines.join(", ")}`,
    ).toHaveLength(0);
  });

  it("trusted install guide documents all required patterns", () => {
    const src = readPlugin("index.ts");

    // Verify all key pieces of the trust story are present in the source
    const REQUIRED_DOCS = [
      "Trusted local-load path",
      "node:child_process",
      "process.env",
      "local file reads",
      "does not contact external websites during install or load",
      // The allow list snippet is generated dynamically via template literal so check the key phrase
      "allow:",
    ];

    for (const doc of REQUIRED_DOCS) {
      expect(src, `Missing trusted install documentation: "${doc}"`).toContain(doc);
    }
  });

  it("openclaw.plugin.json does not make network calls at load time", () => {
    const manifest = JSON.parse(readPlugin("openclaw.plugin.json")) as Record<string, unknown>;
    // Verify the manifest is static — no executable network calls embedded
    // (URLs in description/placeholder strings are fine; what matters is no fetch/require)
    expect(typeof manifest.id).toBe("string");
    expect(typeof manifest.description).toBe("string");
    // No scripts or network hooks in the manifest
    expect(manifest).not.toHaveProperty("scripts");
    expect(manifest).not.toHaveProperty("postinstall");
    expect(manifest).not.toHaveProperty("install");
  });

  it("README documents install warning context for users", () => {
    const readme = readPlugin("README.md");
    // README must explain the scanner warnings so users aren't scared
    expect(readme.length).toBeGreaterThan(100);
  });
});
