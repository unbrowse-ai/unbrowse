// Says whether npm can take a release, before anything is built or tagged. Trusted publishing can't create a package, so
// each is published once by hand (docs/OPERATIONS.md §10), and npm-publish.sh stops at the first one missing, after every
// program is built: eleven missing packages would be eleven failed runs, each naming one. This names them all at once,
// from the machines pack-platforms.sh packs, so a machine added there is asked about here. Whether a
// package has a trusted publisher isn't public: npm-publish.sh says so when npm refuses.
//
// It also says whether npm can still take the release's version, which npm never takes twice. A version is fixed before
// the run starts (release-version.sh): a production release's is its tag's, and a prerelease's ends in the run's own
// number. So a version npm already holds is refused, not moved off: a run that stopped part way through publishing is
// rerun (npm-publish.sh leaves what it published alone), and a tag whose version is spent is tagged again at the next
// patch.
//
//   node npm-preflight.mjs [version]            exits 1 with one ::error:: naming every package npm doesn't have; with a
//                                               version, writes it to $GITHUB_OUTPUT as `version`, or exits 1 when npm
//                                               holds it
//
// UNBROWSE_REGISTRY stands in for npmjs.org. Reads only, with no key and no token: Node's own fetch.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));

/** The machines in pack-platforms.sh's table: `<platform> <archive> <os> <cpu> <browser archive>` a line. */
export function machinesIn(text) {
  return [...text.matchAll(/^(?:machines=")?([a-z0-9]+-[a-z0-9]+) \S+ (?:darwin|linux|win32) \S+ \S+"?$/gm)].map((m) => m[1]);
}

/** Every package a release publishes, each machine's programs and browser add-on among them. */
export const packagesOf = (machines) => ["unbrowse", ...machines.flatMap((m) => [`@unbrowse/${m}`, `@unbrowse/browser-${m}`]), "@unbrowse/updates"];

/** The update metadata's versions are its own count, not a release's. */
const METADATA = "@unbrowse/updates";

/**
 * What the registry says of each package: which it doesn't have, which it couldn't say, and the release versions any of
 * them holds. `ask` answers `{ status, versions }`.
 */
export async function survey(names, ask) {
  const missing = [];
  const unknown = [];
  const held = new Set();
  await Promise.all(
    names.map(async (name) => {
      const { status, versions = [] } = await ask(name).catch(() => ({ status: 0 }));
      if (status === 404) missing.push(name);
      else if (status < 200 || status >= 300) unknown.push(name);
      else if (name !== METADATA) versions.forEach((v) => held.add(v));
    }),
  );
  return { missing: names.filter((n) => missing.includes(n)), unknown: names.filter((n) => unknown.includes(n)), held: [...held] };
}

/** The lines to print, and whether a release can go on. A registry that didn't answer stops nothing: the publish asks again. */
export function verdict({ missing, unknown }, repository) {
  const lines = [];
  if (unknown.length) lines.push(`::warning::the registry didn't say whether it has ${unknown.join(", ")}: going on, and npm-publish.sh asks again`);
  if (missing.length) {
    lines.push(
      `::error::npm has no ${missing.join(", ")} (${missing.length} packages), and trusted publishing can't create a package, so nothing is built or tagged. As a member of the npm org, publish each once by hand (npm publish --access public, any version), give each a trusted publisher (GitHub Actions, ${repository}, workflow release.yml, environment release; @unbrowse/updates also workflow updates.yml), then run this workflow again: docs/OPERATIONS.md §10`,
    );
  }
  return { lines, ok: missing.length === 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const registry = (process.env.UNBROWSE_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
  const names = packagesOf(machinesIn(readFileSync(join(scripts, "pack-platforms.sh"), "utf8")));
  const found = await survey(names, async (name) => {
    const r = await fetch(`${registry}/${name.replace("/", "%2f")}`, { headers: { accept: "application/vnd.npm.install-v1+json" }, signal: AbortSignal.timeout(20_000) });
    return { status: r.status, versions: r.ok ? Object.keys((await r.json()).versions ?? {}) : [] };
  });
  const { lines, ok } = verdict(found, process.env.GITHUB_REPOSITORY || "the repository");
  lines.forEach((l) => console.log(l));
  if (!ok) process.exit(1);
  console.log(`npm has all ${names.length - found.unknown.length} packages it was asked about`);
  const wanted = process.argv[2];
  if (wanted) {
    if (found.held.includes(wanted)) {
      console.log(
        `::error::npm holds ${wanted} already, and npm never takes a version twice. Rerun the failed jobs of the run that published it (npm-publish.sh finishes what it started), or for a tag, tag the next patch on main`,
      );
      process.exit(1);
    }
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${wanted}\n`);
  }
}
