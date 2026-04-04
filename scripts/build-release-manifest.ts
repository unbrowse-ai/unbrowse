import { createHmac } from "crypto";
import { execSync } from "child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { CODE_HASH } from "../src/version.ts";

interface ReleaseManifestPayload {
  schema_version: 1;
  release_version: string;
  git_sha: string;
  code_hash: string;
  trace_version: string;
  issued_at: string;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, "..");
const distDir = join(rootDir, "dist");
const manifestPath = join(distDir, "release-manifest.json");
const signaturePath = join(distDir, "release-manifest.sig");
const generatedBuildInfoPath = join(rootDir, "src", "build-info.generated.ts");

function readVersion(): string {
  const raw = readFileSync(join(rootDir, "version.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "0.0.0";
}

function readGitSha(): string {
  try {
    return execSync("git rev-parse --short=12 HEAD", {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signManifest(manifestJson: string, secret: string | undefined): string {
  if (!secret) return "";
  return createHmac("sha256", secret).update(manifestJson).digest("base64url");
}

function writeGeneratedBuildInfo(build: {
  git_sha: string;
  code_hash: string;
  release_version: string;
  manifest_base64: string;
  signature: string;
  default_backend_url: string;
}) {
  const content = [
    `export const BUILD_RELEASE_VERSION = ${JSON.stringify(build.release_version)};`,
    `export const BUILD_GIT_SHA = ${JSON.stringify(build.git_sha)};`,
    `export const BUILD_CODE_HASH = ${JSON.stringify(build.code_hash)};`,
    `export const BUILD_RELEASE_MANIFEST_BASE64 = ${JSON.stringify(build.manifest_base64)};`,
    `export const BUILD_RELEASE_MANIFEST_SIGNATURE = ${JSON.stringify(build.signature)};`,
    `export const BUILD_DEFAULT_BACKEND_URL = ${JSON.stringify(build.default_backend_url)};`,
    "",
  ].join("\n");
  writeFileSync(generatedBuildInfoPath, content);
}

const manifest: ReleaseManifestPayload = {
  schema_version: 1,
  release_version: readVersion(),
  git_sha: process.env.UNBROWSE_BUILD_GIT_SHA?.trim() || readGitSha(),
  code_hash: process.env.UNBROWSE_BUILD_CODE_HASH?.trim() || CODE_HASH,
  trace_version: "",
  issued_at: new Date().toISOString(),
};
manifest.trace_version = `${manifest.code_hash}@${manifest.git_sha}`;

const manifestJson = JSON.stringify(manifest);
const manifestBase64 = encodeBase64Url(manifestJson);
const signature = signManifest(manifestJson, process.env.UNBROWSE_RELEASE_MANIFEST_SIGNING_SECRET?.trim());
const defaultBackendUrl = process.env.UNBROWSE_BUILD_DEFAULT_BACKEND_URL?.trim() || "https://beta-api.unbrowse.ai";

mkdirSync(distDir, { recursive: true });
writeFileSync(manifestPath, `${manifestJson}\n`);
if (signature) {
  writeFileSync(signaturePath, `${signature}\n`);
} else {
  rmSync(signaturePath, { force: true });
  writeFileSync(signaturePath, "\n");
}
writeGeneratedBuildInfo({
  git_sha: manifest.git_sha,
  code_hash: manifest.code_hash,
  release_version: manifest.release_version,
  manifest_base64: manifestBase64,
  signature,
  default_backend_url: defaultBackendUrl,
});

if (process.argv.includes("--shell-env")) {
  console.log(`export UNBROWSE_BUILD_GIT_SHA=${manifest.git_sha}`);
  console.log(`export UNBROWSE_BUILD_CODE_HASH=${manifest.code_hash}`);
  console.log(`export UNBROWSE_RELEASE_MANIFEST_BASE64=${manifestBase64}`);
  console.log(`export UNBROWSE_RELEASE_MANIFEST_SIGNATURE=${signature}`);
}
