#!/usr/bin/env node
// Did a deploy cost anyone a connection? A product that holds people's sign-ins to other apps (OAuth grants, API keys,
// webhooks) can break one without a single failed request: the grant is revoked at the next token renewal, the data
// behind it quietly stops updating, and only a person signing in again fixes it. So the broken ones are written down
// before a deploy and compared after it, and again once tokens have had time to renew.
//
//   node connections.mjs snapshot --cmd '<prints one line per broken connection>' --out .deploy/.connections-production.json
//   node connections.mjs compare  --cmd '<the same command>' --baseline .deploy/.connections-production.json
//   node connections.mjs daily    --cmd '<the same command>' --state <file> [--notify '<command>']
//
// daily is for a timer: a connection can die on any day, not only after a deploy. It compares with what it saw last
// time, keeps that up to date, and runs --notify when the list changed (a new one broke, or one came back) with
// CONNECTIONS_BROKEN, CONNECTIONS_NEW and CONNECTIONS_FIXED in its environment (one `name: why` per line), so someone
// is told once, the tracked item stays open while anything is broken, and it closes itself when all are back.
// Ends with  CONNECTIONS_DAILY broken=… new=… fixed=… notified=yes|no|failed
//
// --cmd is the repo's own: it prints `name: why` for every connection that needs a person or has stopped updating
// (nothing when all is well) and exits non-zero when it could not look. One name per line; the name is what is compared.
// snapshot ends with  CONNECTIONS_SNAPSHOT broken=…        compare ends with a success-only marker:
//   CONNECTIONS_OK broken=… new=0 fixed=…      or      CONNECTIONS_FAIL new=…: name (why); …      (exit 1)
// A connection that was already broken is listed every time ("still needs a person"): never a pass in silence.
// Could not look (the command failed, no baseline): CONNECTIONS_UNKNOWN, exit 2. Never a pass.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

/** The command's lines as {name: why}. A line is `name: why` or just `name`; blank lines and `#` comments are skipped. */
export function parseBroken(text) {
  const out = {};
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(": "), name = (i < 0 ? line : line.slice(0, i)).trim();
    if (name) out[name] = i < 0 ? "" : line.slice(i + 2).trim().slice(0, 300);
  }
  return out;
}
/** What changed since the baseline: connections broken now that were not then, and ones that have come back. */
export function diffBroken(before, now) {
  return { fresh: Object.keys(now).filter((n) => !(n in before)).sort(), fixed: Object.keys(before).filter((n) => !(n in now)).sort(),
           still: Object.keys(now).filter((n) => n in before).sort() };
}

function main() {
  const argv = process.argv.slice(2), mode = argv[0];
  const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
  const cmd = arg("cmd"), file = arg(mode === "snapshot" ? "out" : mode === "daily" ? "state" : "baseline");
  if (!["snapshot", "compare", "daily"].includes(mode) || !cmd || !file) { console.error("usage: connections.mjs snapshot --cmd '…' --out <file>   |   compare --cmd '…' --baseline <file>   |   daily --cmd '…' --state <file> [--notify '…']"); process.exit(2); }
  const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8", timeout: Number(arg("timeout-s", "300")) * 1000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) { console.log(`CONNECTIONS_UNKNOWN the command could not look (exit ${r.status}): ${`${r.stderr ?? ""}${r.stdout ?? ""}`.trim().slice(-300)}`); process.exit(2); }
  const now = parseBroken(r.stdout);
  if (mode === "daily") {
    const first = !existsSync(file), before = first ? {} : JSON.parse(readFileSync(file, "utf8")).broken ?? {}, d = diffBroken(before, now);
    for (const n of d.fresh) console.log(`     needs a person, new since last time: ${n}${now[n] ? ` (${now[n]})` : ""}`);
    for (const n of d.still) console.log(`     still needs a person: ${n}${now[n] ? ` (${now[n]})` : ""}`);
    for (const n of d.fixed) console.log(`     back: ${n}`);
    const lines = (names, from) => names.map((n) => `${n}${from[n] ? `: ${from[n]}` : ""}`).join("\n");
    let notified = "no";
    if (arg("notify") && (d.fresh.length || d.fixed.length)) {
      const n = spawnSync("sh", ["-c", arg("notify")], { encoding: "utf8", timeout: 120_000,
        env: { ...process.env, CONNECTIONS_BROKEN: lines(Object.keys(now).sort(), now), CONNECTIONS_NEW: lines(d.fresh, now), CONNECTIONS_FIXED: lines(d.fixed, before) } });
      notified = n.status === 0 ? "yes" : "failed";
      if (n.status !== 0) console.log(`     the notice could not be sent (exit ${n.status}): ${`${n.stderr ?? ""}${n.stdout ?? ""}`.trim().slice(-200)}`);
    }
    // What was seen is kept only once the notice went out: a notice that failed is tried again next time.
    if (notified !== "failed") { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), broken: now }, null, 2)); }
    console.log(`CONNECTIONS_DAILY broken=${Object.keys(now).length} new=${d.fresh.length} fixed=${d.fixed.length} notified=${notified}`);
    process.exit(notified === "failed" ? 1 : 0);
  }
  if (mode === "snapshot") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), broken: now }, null, 2));
    for (const [n, why] of Object.entries(now)) console.log(`     already needs a person: ${n}${why ? ` (${why})` : ""}`);
    console.log(`CONNECTIONS_SNAPSHOT broken=${Object.keys(now).length} at=${new Date().toISOString()}`);
    return;
  }
  if (!existsSync(file)) { console.log(`CONNECTIONS_UNKNOWN no baseline at ${file}: take a snapshot before the deploy`); process.exit(2); }
  const base = JSON.parse(readFileSync(file, "utf8")), d = diffBroken(base.broken ?? {}, now);
  for (const n of d.still) console.log(`     still needs a person (since before ${base.at}): ${n}${now[n] ? ` (${now[n]})` : ""}`);
  for (const n of d.fixed) console.log(`     back since ${base.at}: ${n}`);
  if (d.fresh.length) { console.log(`CONNECTIONS_FAIL new=${d.fresh.length}: ${d.fresh.map((n) => `${n}${now[n] ? ` (${now[n]})` : ""}`).join("; ")}`); process.exit(1); }
  console.log(`CONNECTIONS_OK broken=${Object.keys(now).length} new=0 fixed=${d.fixed.length} since=${base.at}`);
}
// Run as a command (through a symlinked path too), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) main();
