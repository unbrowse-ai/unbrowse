import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Deterministic version hash of all src/*.ts files.
// Computed once at startup. Same code = same hash.
// Used to stamp every trace so real user sessions become versioned evals.

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      results.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

function hashFiles(srcDir: string, files: string[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.slice(srcDir.length));
    hash.update(readFileSync(file, "utf-8"));
  }
  return hash.digest("hex").slice(0, 12);
}

export function resolveCodeHashSourceDir(moduleDir: string): string | null {
  const candidates = [
    moduleDir,
    join(moduleDir, "runtime-src"),
    join(moduleDir, "..", "runtime-src"),
    join(moduleDir, "src"),
    join(moduleDir, "..", "src"),
  ];

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const files = collectTsFiles(candidate);
      if (files.length > 0) return candidate;
    } catch {
      // ignore candidate
    }
  }

  return null;
}

export function computeCodeHashForDir(srcDir: string): string {
  const files = collectTsFiles(srcDir).sort();
  if (files.length === 0) throw new Error(`No TypeScript sources found in ${srcDir}`);
  return hashFiles(srcDir, files);
}

function computeCodeHash(): string {
  try {
    const srcDir = resolveCodeHashSourceDir(MODULE_DIR);
    if (srcDir) return computeCodeHashForDir(srcDir);
  } catch {
    // fall through
  }

  const pkgVersion = getPackageVersion();
  if (pkgVersion !== "unknown") {
    return createHash("sha256").update(`package:${pkgVersion}`).digest("hex").slice(0, 12);
  }

  // Compiled binary: filesystem not available, use a static hash
  return "compiled";
}

function getGitSha(): string {
  return "unknown";
}

function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(MODULE_DIR, "..", "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** 12-char hex hash of all source file contents */
export const CODE_HASH: string = computeCodeHash();

/** Short git commit SHA */
export const GIT_SHA: string = getGitSha();

/** package.json version for CLI/runtime mismatch checks */
export const PACKAGE_VERSION: string = getPackageVersion();

/** Combined version: "{code_hash}@{git_sha}" — stamped on every trace */
export const TRACE_VERSION: string = `${CODE_HASH}@${GIT_SHA}`;
