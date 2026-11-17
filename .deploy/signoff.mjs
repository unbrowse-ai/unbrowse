#!/usr/bin/env node
// A release candidate is signed off on evidence, not on a feeling: "review happens on the release candidate". Before a
// release branch is recorded on main, this asks the ledger and the repository what is actually known about it.
//
//   node signoff.mjs --notes notes.md [--since <the release before>] [--by "<name>" --evidence "<what was tried, where>"]
//                    [--require-person] [--repo owner/name]
//
// Run on the release branch's commit. Every line must hold:
//   - the gates of the last environment before production passed on exactly this code (preprod, or staging in a repo
//     with no preprod: a ledger record for this tree, outcome ok, with a gate count)
//   - the bundle that environment tested was written down (so production can be held to it: ledger.mjs artifact)
//   - the release has notes that say something
//   - it is known what production goes back to (the last recorded production deploy), or this is the first release
//   - no open issue is labelled release-blocker, and no test is in quarantine past its date
//   - with --require-person (or "signoff": { "person": true } in the manifest): someone who wrote none of its changes
//     tried it on a clean environment and says what they did (--by, --evidence of 20+ characters)
// Without a person required, the train signs for itself and says so: by=release-train. The sign-off goes on the ledger.
// Ends with a success-only marker:  SIGNOFF_OK tree=… by=… evidence=n/n       Else SIGNOFF_FAIL, exit 1.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { quarantineProblems } from "./flake.mjs";
import { load, save, testedEnv } from "./ledger.mjs";

/** Each thing a sign-off rests on, and whether it holds: [{ ok, text }]. Pure. */
export function evaluate({ tree, records = [], notes = "", blockers = [], quarantine = {}, today, person = false, by = "", evidence = "", authors = [], tested = "preprod", bundleDiffers = "" }) {
  const out = [], add = (ok, text) => out.push({ ok: !!ok, text });
  // `tested`: the last environment gated before production (preprod, or staging in a repo with no preprod). Only a
  // deploy counts as its record: a rollback drill or an adoption of what was live is neither.
  const pre = records.filter((r) => r.env === tested && r.tree === tree && ["ok", "failed", "rolled_back"].includes(r.outcome)).at(-1), gates = Number(String(pre?.gate ?? "").split("/")[0]);
  add(pre?.outcome === "ok" && gates > 0, pre ? `${tested}'s gates passed on this code (${pre.gate || "no gate ran"}, ${pre.outcome}, ${pre.at})` : `${tested}'s gates passed on this code (there is no record of ${tested} running it)`);
  if (bundleDiffers) add(true, `production is not held to ${tested}'s bundle, by the manifest's own word: ${bundleDiffers}`);
  else add(pre && Object.keys(pre.digests ?? {}).length, `the bundle ${tested} tested is written down (ledger.mjs artifact --env ${tested}, before the deploy is recorded)`);
  add(/^- \S/m.test(notes) || /^Also \d+ change/m.test(notes), "the release has notes: at least one change named, or the count of changes with nothing to notice");
  const prod = records.filter((r) => r.env === "production" && Object.values(r.workers ?? {}).some(Boolean)).at(-1);
  add(true, prod ? `production goes back to ${Object.entries(prod.workers).map(([n, v]) => `${n}@${String(v).slice(0, 8)}`).join(", ")} (${prod.at})` : "this is the first recorded release: there is nothing to go back to");
  add(blockers !== null && !blockers.length, blockers === null ? "no open issue is labelled release-blocker (the issues could not be read)" : `no open issue is labelled release-blocker${blockers.length ? ` (open: ${blockers.slice(0, 5).join(", ")})` : ""}`);
  const q = quarantineProblems(quarantine, today);
  add(!q.length, `no test is in quarantine past its date, without a reason or without an issue${q.length ? ` (${q.length}: ${q[0]})` : ` (${Object.keys(quarantine).length} in quarantine, all dated)`}`);
  if (person) {
    const who = by.trim().toLowerCase(), wrote = authors.some((a) => who && a.toLowerCase().includes(who));
    add(who && !wrote, !who ? "a person who wrote none of it tried it (--by <name>)" : wrote ? `${by} wrote changes in this release: the person who signs it off is someone else` : `${by}, who wrote none of it, tried it`);
    add(evidence.trim().length >= 20, "they say what they tried and where (--evidence, 20+ characters: a clean environment, real data on a second input)");
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2), arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const root = resolve(arg("root", process.cwd()));
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" }).stdout?.trim() ?? "", read = (f, d) => (existsSync(join(root, f)) ? JSON.parse(readFileSync(join(root, f), "utf8")) : d);
  const tree = git("rev-parse", "HEAD^{tree}"), m = read(".deploy/manifest.json", {}), person = argv.includes("--require-person") || !!m.signoff?.person;
  const repo = process.env.LEDGER_GITHUB === "off" ? "" : arg("repo", process.env.GITHUB_REPOSITORY || m.repo || "");
  if (!tree) { console.error("signoff.mjs runs in the repository, on the release branch's commit"); process.exit(2); }
  // A sign-off already on the ledger for exactly this code stands (a person gave it by hand; the train does not ask twice).
  const given = load(root, repo).filter((r) => r.env === "signoff" && r.tree === tree && r.outcome === "ok").at(-1);
  if (given && !argv.includes("--again")) { console.log(`SIGNOFF_OK tree=${tree.slice(0, 7)} by=${given.by} evidence=${given.items?.length ?? 0}/${given.items?.length ?? 0} (signed ${given.at})`); return; }
  let blockers = [];
  if (repo) { const r = spawnSync(process.env.GH_BIN ?? "gh", ["issue", "list", "--repo", repo, "--label", "release-blocker", "--state", "open", "--json", "number,title"], { encoding: "utf8" }); try { blockers = r.status ? null : JSON.parse(r.stdout).map((i) => `#${i.number} ${i.title}`); } catch { blockers = null; } }
  const notesFile = arg("notes"), by = arg("by", ""), since = arg("since");
  const found = evaluate({ tree, records: load(root, repo), notes: notesFile && existsSync(join(root, notesFile)) ? readFileSync(join(root, notesFile), "utf8") : "", blockers, quarantine: read(".deploy/quarantine.json", {}),
    today: new Date().toISOString().slice(0, 10), person, by, tested: m.signoff?.env ?? testedEnv(m), bundleDiffers: typeof m.artifact?.differs === "string" && m.artifact.differs.trim().length >= 15 ? m.artifact.differs.trim() : "", evidence: arg("evidence", ""), authors: git("log", "--format=%an <%ae>", ...(since ? [`${since}..HEAD`] : ["-200"])).split("\n").filter(Boolean) });
  for (const f of found) console.log(`${f.ok ? "ok  " : "FAIL"} ${f.text}`);
  const bad = found.filter((f) => !f.ok), signer = person ? by : "release-train";
  if (bad.length) { console.log(`SIGNOFF_FAIL ${bad.length} of ${found.length} do not hold: this release candidate is not signed off`); process.exit(1); }
  const at = new Date().toISOString(), store = save(root, repo, { train: 1, id: `signoff-${at}`, env: "signoff", at, sha: git("rev-parse", "HEAD"), tree, outcome: "ok", by: signer, evidence: arg("evidence", ""), items: found.map((f) => f.text) });
  console.log(`SIGNOFF_OK tree=${tree.slice(0, 7)} by=${signer} evidence=${found.length}/${found.length} store=${store}`);
}

// Run as a command (through a symlinked path too: the skills folder is one), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) main();
