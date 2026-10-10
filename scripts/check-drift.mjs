// Drift alarm: this repo's skill against what users actually get. Run daily (drift.yml) and by hand.
//   live: https://unbrowse.ai/skill/SKILL.md is the server's own skill. Different = the server-to-public sync did not run.
//   npm:  the SKILL.md inside `unbrowse@latest`. Different = main changed and no release was cut.
// Prints DRIFT_OK, or one DRIFT line per difference and exits 1.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = process.env.UNBROWSE_ORIGIN ?? "https://unbrowse.ai";
const local = readFileSync("skill/SKILL.md", "utf8");
const problems = [];

const firstDiff = (a, b) => {
  const x = a.split("\n"), y = b.split("\n");
  let n = x.findIndex((line, i) => line !== y[i]);
  if (n < 0) n = Math.min(x.length, y.length);
  const [p, q] = [x[n] ?? "", y[n] ?? ""];
  let c = 0;
  while (c < p.length && p[c] === q[c]) c++;
  const near = (t) => JSON.stringify(t.slice(Math.max(0, c - 20), c + 40));
  return `line ${n + 1} col ${c + 1}: repo ${near(p)} vs ${near(q)}`;
};

const live = await fetch(`${origin}/skill/SKILL.md`, { signal: AbortSignal.timeout(30_000) }).then((r) => (r.ok ? r.text() : `HTTP ${r.status}`));
if (live !== local) problems.push(`DRIFT live: ${origin}/skill/SKILL.md differs from skill/SKILL.md (${firstDiff(local, live)}). Sync: scripts/public-surface/sync.mjs in the server repo, or set its PUBLIC_CLIENT_TOKEN.`);

const dir = mkdtempSync(join(tmpdir(), "ub-drift-"));
try {
  const tgz = execFileSync("npm", ["pack", "unbrowse@latest", "--silent", "--pack-destination", dir], { encoding: "utf8" }).trim().split("\n").pop();
  const shipped = execFileSync("tar", ["-xzOf", join(dir, tgz), "package/SKILL.md"], { encoding: "utf8" });
  const version = tgz.replace(/^unbrowse-|\.tgz$/g, "");
  if (shipped !== local) problems.push(`DRIFT npm: unbrowse@latest (${version}) ships another SKILL.md (${firstDiff(local, shipped)}). Cut a release: docs/release.md.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

for (const p of problems) console.log(p);
if (problems.length) process.exit(1);
console.log("DRIFT_OK");
