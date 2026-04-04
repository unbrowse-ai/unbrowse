import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, parse } from "path";
import { fileURLToPath } from "url";
import {
  BUILD_CODE_HASH,
  BUILD_DEFAULT_BACKEND_URL,
  BUILD_GIT_SHA,
  BUILD_RELEASE_MANIFEST_BASE64,
  BUILD_RELEASE_MANIFEST_SIGNATURE,
  BUILD_RELEASE_VERSION,
} from "./build-info.generated.js";

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
  return BUILD_GIT_SHA?.trim() || "unknown";
}

function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    if (!value) return null;
    return JSON.parse(Buffer.from(value, "base64url").toString("utf-8")) as T;
  } catch {
    return null;
  }
}

export function getEmbeddedReleaseVersion(): string | null {
  if (BUILD_RELEASE_VERSION?.trim()) return BUILD_RELEASE_VERSION.trim();
  const manifest = decodeBase64UrlJson<{ release_version?: string }>(BUILD_RELEASE_MANIFEST_BASE64?.trim() || "");
  return typeof manifest?.release_version === "string" && manifest.release_version.trim()
    ? manifest.release_version.trim()
    : null;
}

export function getPackageVersionForModuleDir(moduleDir: string): string {
  let dir = moduleDir;
  const root = parse(dir).root;

  while (true) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { version?: string };
      return typeof pkg.version === "string" ? pkg.version : "unknown";
    } catch {
      // keep walking
    }

    if (dir === root) return "unknown";
    dir = dirname(dir);
  }
}

function getPackageVersion(): string {
  const packageVersion = getPackageVersionForModuleDir(MODULE_DIR);
  if (packageVersion !== "unknown") return packageVersion;
  return getEmbeddedReleaseVersion() ?? "unknown";
}

/** 12-char hex hash of all source file contents */
export const CODE_HASH: string = BUILD_CODE_HASH?.trim() || computeCodeHash();

/** Short git commit SHA */
export const GIT_SHA: string = getGitSha();

/** package.json version for CLI/runtime mismatch checks */
export const PACKAGE_VERSION: string = getPackageVersion();

/** Embedded default backend target; preview binaries override this at build time. */
export const DEFAULT_BACKEND_URL: string = BUILD_DEFAULT_BACKEND_URL?.trim() || "https://beta-api.unbrowse.ai";

/** Combined version: "{code_hash}@{git_sha}" — stamped on every trace */
export const TRACE_VERSION: string = `${CODE_HASH}@${GIT_SHA}`;

/** Signed release attestation; embedded in compiled binaries when available. */
export const RELEASE_MANIFEST_BASE64: string = BUILD_RELEASE_MANIFEST_BASE64?.trim() || "";
export const RELEASE_MANIFEST_SIGNATURE: string = BUILD_RELEASE_MANIFEST_SIGNATURE?.trim() || "";
