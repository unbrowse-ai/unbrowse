import { createPublicKey, verify } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const [directory, version, expectedText, updateSource, manifestPath] = process.argv.slice(2);
if (!directory || !version || !expectedText || !updateSource || !manifestPath) throw new Error("usage: verify-artifact-manifest.mjs <dir> <version> <hashes-json> <update.rs> <manifest>");
const expected = JSON.parse(expectedText);
const envelope = JSON.parse(readFileSync(manifestPath, "utf8"));
if (envelope.signed?._type !== "release-artifacts" || envelope.signed.version !== version) throw new Error("artifact manifest has the wrong type or version");
const trusted = /^const RELEASE_KEY: &str = "([0-9a-f]{64})";$/m.exec(readFileSync(updateSource, "utf8"))?.[1];
if (!trusted) throw new Error(`no RELEASE_KEY in ${updateSource}`);
const signature = envelope.signatures?.find((item) => item.keyid === trusted)?.sig;
if (!signature) throw new Error("artifact manifest has no signature by the node's trusted key");
const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(trusted, "hex")]), format: "der", type: "spki" });
if (!verify(null, Buffer.from(canonical(envelope.signed)), publicKey, Buffer.from(signature, "hex"))) throw new Error("artifact manifest signature is invalid");
if (JSON.stringify(Object.fromEntries(Object.entries(envelope.signed.artifacts).sort(([a], [b]) => a.localeCompare(b)))) !== JSON.stringify(Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b))))) throw new Error("signed artifact list differs from the build job output");
const actualNames = readdirSync(directory).filter((name) => name.endsWith(".tgz") || name.endsWith(".whl"));
const expectedNames = Object.keys(expected).sort();
if (JSON.stringify(actualNames.sort()) !== JSON.stringify(expectedNames)) throw new Error("published artifact set differs from signed artifact list");
for (const [name, digest] of Object.entries(expected)) {
  const actual = createHash("sha256").update(readFileSync(join(directory, name))).digest("hex");
  if (actual !== digest) throw new Error(`${name} does not match the signed build artifact`);
}
