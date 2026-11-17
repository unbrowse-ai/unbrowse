import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const [version, hashesText, updateSource, output] = process.argv.slice(2);
if (!version || !hashesText || !updateSource || !output) throw new Error("usage: sign-artifact-manifest.mjs <version> <hashes-json> <update.rs> <output>");
const privatePem = process.env.UNBROWSE_RELEASE_KEY;
if (!privatePem) throw new Error("UNBROWSE_RELEASE_KEY is not set");
const hashes = JSON.parse(hashesText);
if (!hashes || typeof hashes !== "object" || Array.isArray(hashes) || Object.keys(hashes).length === 0) throw new Error("artifact hashes are empty or invalid");
for (const [name, digest] of Object.entries(hashes)) {
  if (!/^(?:unbrowse-.*\.tgz|unbrowse-.*\.whl)$/.test(name) || !/^[0-9a-f]{64}$/.test(digest)) throw new Error(`invalid artifact hash entry: ${name}`);
}
const trusted = /^const RELEASE_KEY: &str = "([0-9a-f]{64})";$/m.exec(readFileSync(updateSource, "utf8"))?.[1];
if (!trusted) throw new Error(`no RELEASE_KEY in ${updateSource}`);
const privateKey = createPrivateKey(privatePem);
const publicKey = createPublicKey(privateKey);
const id = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
if (id !== trusted) throw new Error("release key does not match the node's built-in trust key");
const signed = { _type: "release-artifacts", version, artifacts: Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b))) };
const bytes = Buffer.from(canonical(signed));
const signature = sign(null, bytes, privateKey).toString("hex");
const outputValue = { signed, signatures: [{ keyid: id, sig: signature }] };
// Self-check before emitting a file that will gate publication.
if (!verify(null, bytes, publicKey, Buffer.from(signature, "hex"))) throw new Error("artifact manifest signature self-check failed");
writeFileSync(output, `${JSON.stringify(outputValue, null, 2)}\n`);
