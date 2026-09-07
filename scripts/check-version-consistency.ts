import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(root, path), "utf8")) as Record<string, unknown>;

const declared = [
  ["version.json", readJson("version.json").version],
  ["package.json", readJson("package.json").version],
  ["packages/skill/package.json", readJson("packages/skill/package.json").version],
  ["packages/sdk/package.json", readJson("packages/sdk/package.json").version],
] as const;
const expected = String(declared[0][1] ?? "");
const mismatches = declared.filter(([, version]) => version !== expected);
if (!expected || mismatches.length > 0) {
  console.error("version_consistency_failed", { expected, declared });
  process.exit(1);
}

const source = readFileSync(resolve(root, "src/build-info.generated.ts"), "utf8");
const field = (name: string): string => {
  const line = source.split("\n").find((candidate) => candidate.startsWith(`export const ${name} = `));
  if (!line) return "";
  const literal = line.slice(line.indexOf("=") + 1).trim().replace(/;$/, "");
  try { return JSON.parse(literal) as string; } catch { return ""; }
};
const embeddedVersion = field("BUILD_RELEASE_VERSION");
const encodedManifest = field("BUILD_RELEASE_MANIFEST_BASE64");
const signature = field("BUILD_RELEASE_MANIFEST_SIGNATURE");

// A checkout may carry the all-blank source sentinel. A release artifact may
// not be partial: version, manifest, and signature must appear together and
// agree with every package version.
const provenanceFields = [embeddedVersion, encodedManifest, signature];
const populated = provenanceFields.filter(Boolean).length;
if (populated !== 0 && populated !== provenanceFields.length) {
  console.error("build_info_partial", { embeddedVersion: Boolean(embeddedVersion), manifest: Boolean(encodedManifest), signature: Boolean(signature) });
  process.exit(1);
}
if (populated === provenanceFields.length) {
  let manifest: { release_version?: string };
  try {
    manifest = JSON.parse(Buffer.from(encodedManifest, "base64url").toString("utf8"));
  } catch {
    console.error("build_info_manifest_invalid");
    process.exit(1);
  }
  if (embeddedVersion !== expected || manifest.release_version !== expected) {
    console.error("build_info_version_mismatch", { expected, embeddedVersion, manifestVersion: manifest.release_version });
    process.exit(1);
  }
}
console.log(`version consistency ok: ${expected} (${populated ? "signed release provenance" : "source sentinel"})`);
