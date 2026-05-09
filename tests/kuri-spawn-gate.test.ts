import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// Spawn-gate contract (Step 2 of the Jesus Loop):
//   "every kuri spawn routes through resolveKuriLaunchConfig; no caller passes
//    a literal `headless: false`; only src/auth/index.ts is whitelisted to set
//    HEADLESS=false in env, and only inside the interactive auth code path."
//
// This test walks the real source tree (no mocks, no globs of dist/, no skipped
// files) and asserts every .ts file outside the whitelist is free of:
//   1. an object literal `headless: false`
//   2. an env construction `HEADLESS: "false"` or `HEADLESS = "false"`
//   3. a direct runtime mutation `process.env.HEADLESS = "false"`
//
// Whitelist rationale:
//   - `src/auth/index.ts` and its skill mirror own the interactive auth flow
//     (resolveAuth around lines 238-354) where the user explicitly opts in to a
//     visible Chrome window. Both files own forceVisibleKuriEnv, which forces
//     HEADLESS and KURI_HEADLESS false inside bounded paths and restores them.
//   - `src/kuri/client.ts` and its skill mirror are the central spawn site.
//     They build the env from `launchConfig.headless` (a derived boolean from
//     resolveKuriLaunchConfig), so the literal "false" appears as the false
//     branch of a ternary -- not a hard-coded override. The regex below is
//     written to NOT match that ternary form (`HEADLESS: launchConfig.headless
//     ? "true" : "false"`) because there is no `:` or `=` immediately followed
//     by `"false"` -- the `?` token sits between them.

const REPO_ROOT = resolve(import.meta.dir, "..");

const SCAN_ROOTS = [
  join(REPO_ROOT, "src"),
  join(REPO_ROOT, "packages", "skill", "runtime-src"),
];

// Files allowed to contain the direct visible-browser env override. These are
// the shared visible Kuri env helpers and only those.
const HEADLESS_ENV_WRITE_WHITELIST = new Set([
  join("src", "auth", "index.ts"),
  join("packages", "skill", "runtime-src", "auth", "index.ts"),
]);

function* walkTs(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "build") continue;
      yield* walkTs(full);
    } else if (st.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      yield full;
    }
  }
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function findHits(content: string, regex: RegExp): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      hits.push({ line: i + 1, text: lines[i].trim() });
    }
  }
  return hits;
}

function collectAllFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const f of walkTs(root)) files.push(f);
  }
  return files;
}

function toRepoRel(absPath: string): string {
  return relative(REPO_ROOT, absPath);
}

function isWhitelisted(repoRel: string): boolean {
  return HEADLESS_ENV_WRITE_WHITELIST.has(repoRel);
}

describe("kuri spawn-gate contract", () => {
  const files = collectAllFiles();

  it("walked at least one file from each scan root", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.includes(`${sep}src${sep}`))).toBe(true);
    expect(files.some((f) => f.includes(`runtime-src`))).toBe(true);
  });

  it("no file contains a literal object property `headless: false` outside the whitelist", () => {
    const re = /\bheadless\s*:\s*false\b/i;
    const offenders: Hit[] = [];
    for (const abs of files) {
      const repoRel = toRepoRel(abs);
      if (isWhitelisted(repoRel)) continue;
      const content = readFileSync(abs, "utf8");
      const hits = findHits(content, re);
      for (const h of hits) offenders.push({ file: repoRel, line: h.line, text: h.text });
    }
    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n");
      throw new Error(
        `Spawn-gate violation: literal \`headless: false\` found outside whitelist.\n` +
          `Every kuri launch must derive \`headless\` from resolveKuriLaunchConfig.\n\n` +
          msg,
      );
    }
  });

  it('no file contains `HEADLESS: "false"` or `HEADLESS = "false"` outside the whitelist', () => {
    const re = /\bHEADLESS\s*[:=]\s*["']false["']/;
    const offenders: Hit[] = [];
    for (const abs of files) {
      const repoRel = toRepoRel(abs);
      if (isWhitelisted(repoRel)) continue;
      const content = readFileSync(abs, "utf8");
      const hits = findHits(content, re);
      for (const h of hits) offenders.push({ file: repoRel, line: h.line, text: h.text });
    }
    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n");
      throw new Error(
        `Spawn-gate violation: HEADLESS env literal "false" set outside whitelist.\n` +
          `Only src/auth/index.ts (and its skill mirror) may set HEADLESS=false, and only in the interactive auth flow.\n\n` +
          msg,
      );
    }
  });

  it('no file contains `process.env.HEADLESS = "false"` outside the whitelist', () => {
    const re = /process\.env\.HEADLESS\s*=\s*["']false["']/;
    const offenders: Hit[] = [];
    for (const abs of files) {
      const repoRel = toRepoRel(abs);
      if (isWhitelisted(repoRel)) continue;
      const content = readFileSync(abs, "utf8");
      const hits = findHits(content, re);
      for (const h of hits) offenders.push({ file: repoRel, line: h.line, text: h.text });
    }
    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n");
      throw new Error(
        `Spawn-gate violation: process.env.HEADLESS = "false" mutation outside the auth whitelist.\n` +
          `If a new code path needs a visible browser, gate it through resolveKuriLaunchConfig instead of mutating env.\n\n` +
          msg,
      );
    }
  });

  it("the auth whitelist files actually exist and contain the regulated mutation (so the whitelist is not stale)", () => {
    for (const rel of HEADLESS_ENV_WRITE_WHITELIST) {
      const abs = join(REPO_ROOT, rel);
      const content = readFileSync(abs, "utf8");
      expect(content).toContain("forceVisibleKuriEnv");
      expect(content).toContain('env.HEADLESS = "false"');
      expect(content).toContain('env.KURI_HEADLESS = "false"');
    }
  });
});
