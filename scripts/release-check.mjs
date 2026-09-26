// Release gate: both packages carry the tag's version; prints the npm dist-tag to publish under.
// Usage: node scripts/release-check.mjs v12.0.0-alpha.0
import { readFileSync } from "node:fs";

const tag = (process.argv[2] ?? "").replace(/^refs\/tags\//, "");
const want = tag.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(want)) {
  console.error(`release-check: "${tag}" is not a vX.Y.Z[-pre] tag`);
  process.exit(1);
}
let bad = false;
for (const dir of ["packages/sdk", "packages/cli"]) {
  const { name, version } = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
  if (version !== want) {
    console.error(`release-check: ${name} is ${version}, tag is ${want}`);
    bad = true;
  }
}
if (bad) process.exit(1);
console.log(want.includes("-") ? "next" : "latest");
