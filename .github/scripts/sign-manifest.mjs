// Signs a release's manifest with Unbrowse's release key (UNBROWSE_RELEASE_KEY, an Ed25519 key in PEM), and checks the
// signature against the public key the node trusts (RELEASE_KEY in unbrowse-node/app/src/update.rs), so a release never
// ships a signature its nodes would refuse. Node's own crypto only: nothing else runs beside the key.
//
//   usage: node sign-manifest.mjs <manifest.json> <update.rs>    writes <manifest.json>'s folder/manifest.sig (hex)
import { createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [manifestPath, source] = process.argv.slice(2);
const key = process.env.UNBROWSE_RELEASE_KEY;
if (!key) {
  console.error("sign-manifest: UNBROWSE_RELEASE_KEY isn't set");
  process.exit(1);
}
const trusted = /^const RELEASE_KEY: &str = "([0-9a-f]{64})";$/m.exec(readFileSync(source, "utf8"))?.[1];
if (!trusted) {
  console.error(`sign-manifest: no RELEASE_KEY in ${source}`);
  process.exit(1);
}
const manifest = readFileSync(manifestPath);
const signature = sign(null, manifest, key);
// An Ed25519 public key as DER: the algorithm's fixed prefix, then its 32 bytes.
const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(trusted, "hex")]);
if (!verify(null, manifest, createPublicKey({ key: spki, format: "der", type: "spki" }), signature)) {
  console.error("sign-manifest: the release key secret isn't the key the node trusts");
  process.exit(1);
}
writeFileSync(join(dirname(manifestPath), "manifest.sig"), signature.toString("hex"));
console.log("signed the manifest with the release key the node trusts");
