import { createHash } from "crypto";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

// Deterministic version hash of all src/*.ts files.
// Computed once at startup. Same code = same hash.
// Used to stamp every trace so real user sessions become versioned evals.

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

function computeCodeHash(): string {
  const srcDir = join((import.meta as any).dir ?? __dirname, ".");
  const files = collectTsFiles(srcDir).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.slice(srcDir.length)); // relative path for determinism
    hash.update(readFileSync(file, "utf-8"));
  }
  return hash.digest("hex").slice(0, 12);
}

function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8", cwd: (import.meta as any).dir ?? __dirname }).trim();
  } catch {
    return "unknown";
  }
}

/** 12-char hex hash of all source file contents */
export const CODE_HASH: string = computeCodeHash();

/** Short git commit SHA */
export const GIT_SHA: string = getGitSha();

/** Combined version: "{code_hash}@{git_sha}" — stamped on every trace */
export const TRACE_VERSION: string = `${CODE_HASH}@${GIT_SHA}`;
