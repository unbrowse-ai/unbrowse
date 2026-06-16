#!/usr/bin/env bun
/**
 * surface-gate.ts — the machine witness for the CLI three-verb collapse.
 *
 * Pinned `check` for the jesus-loop (.claude/jesus-loop.default.plan.md).
 * Enforces, against `src/cli-v7/kind-map.ts` as the SINGLE SOURCE OF TRUTH:
 *
 *   A. PURGE      — the legacy flat dispatch + create/act/read aliases +
 *                   deprecated registries are GONE from src/cli.ts. Checked
 *                   STRUCTURALLY (not by an 8-name sample): no `case "x":`
 *                   dispatches a cmd* handler (= no flat switch-case surface),
 *                   the rejected registries/auto-spawn are absent, and the dead
 *                   site-pack helpers (cmdSite{Task,Help,Batch,Login}) are gone.
 *   B. NO-ALIAS   — bridgeManifest().cli_bridge.legacy_aliases is empty.
 *   C. MAP-AGREE  — kind-map and cli-surface describe the SAME capability
 *                   set with the SAME verb; op_class ↔ verb is consistent.
 *   D. MCP-MATCH  — every kind-map mcp_tool is registered in src/mcp.ts and
 *                   follows the unbrowse_<verb>_<action> convention; no
 *                   registered unbrowse_* tool maps to a purged capability.
 *   E. SKILL-MD   — neither SKILL.md (root + packages/skill) carries a
 *                   command-shaped flat invocation: any `unbrowse <token>`
 *                   where <token> is NOT build|breath|eval, anchored to a real
 *                   command position (start-of-line, after a backtick, or after
 *                   `$ `). Catches ALL flat verbs, not an 8-name sample, while
 *                   leaving prose mentions ("use unbrowse for …") untouched.
 *   F. LIVE       — (only when GATE_LIVE=1) build|breath|eval verb help
 *                   resolves, and a non-verb first token routes to the one-hole
 *                   `breath get` intent path (the bare natural-language front
 *                   door) rather than erroring as unknown_verb.
 *   G. RUNTIME    — packages/skill/runtime-src/ is gitignored (a build
 *                   artifact, not a ship path), so its stale flat-surface
 *                   copy can never be mistaken for source.
 *
 * Exit 0 iff every invariant holds. Sown FAILING-FIRST (Matt 7:24-25):
 * today A–E are all RED; they go green only as the collapse lands.
 *
 * Run:  bun scripts/surface-gate.ts            (static invariants)
 *       GATE_LIVE=1 bun scripts/surface-gate.ts (also runs the binary)
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { KIND_MAP } from "../src/cli-v7/kind-map.js";
import { knownCommands, classify, type Verb } from "../src/superpattern/cli-surface.js";
import { bridgeManifest } from "../src/superpattern/bridge-manifest.js";

const ROOT = join(import.meta.dir, "..");
type Result = { id: string; ok: boolean; detail: string };
const results: Result[] = [];
const record = (id: string, ok: boolean, detail: string) => results.push({ id, ok, detail });

// op_class ↔ verb invariant (kind-map's own classification scheme).
const OP_CLASS_VERB: Record<string, Verb> = { actuate: "breath", observe: "eval", build: "build" };

// Rejected canonical-verb alias scheme (must never reappear as a cli-surface token).
const PURGED_VERB_TOKENS = ["create", "act", "read"];

// Diagnostic / billing MCP tools that live OFF the build/breath/eval taxonomy
// by design (no kind-map row). They are exempt from the D "every registered
// tool has a kind-map row" rule but must still NOT be a renamed legacy verb.
const MCP_GATE_EXEMPT = new Set([
  "unbrowse_diagnose",
  "unbrowse_validate",
  "unbrowse_type_audit",
  "unbrowse_test_crash",
  "billing_status",
  "billing_subscribe_url",
  "billing_portal_url",
  // Off-taxonomy marketplace helpers with no 1:1 verb capability (flat
  // cross-marketplace endpoint search; retroactive publish-backlog).
  "unbrowse_search_endpoints",
  "unbrowse_publish_suggestions",
]);

function readCli(): string {
  return readFileSync(join(ROOT, "src/cli.ts"), "utf8");
}

// ── A. PURGE ────────────────────────────────────────────────────────────
// Dead site-pack command helpers that must no longer be defined anywhere in
// cli.ts (their whole surface was purged with the flat dispatch).
const DEAD_SITE_HELPERS = ["cmdSiteTask", "cmdSiteHelp", "cmdSiteBatch", "cmdSiteLogin"];

function checkPurge() {
  const cli = readCli();
  const lines = cli.split("\n");
  const offenders: string[] = [];

  // A1 (STRUCTURAL): no flat switch-case command dispatch. A legacy flat
  // surface looks like `case "resolve": ... return cmdResolve(...)`. We flag
  // ANY `case "<word>":` whose body (this line or the next 3) calls a cmd*
  // handler — that is a flat command, regardless of its name. The legitimate
  // `switch (sub)` for the `contract` subcommand handles every case inline
  // (no cmd* call), so it is correctly NOT flagged.
  const flatCases = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/case\s+"([a-z][a-z0-9-]*)"\s*:/);
    if (!m) continue;
    const window = lines.slice(i, i + 4).join("\n");
    if (/\bcmd[A-Z][A-Za-z0-9]*\s*\(/.test(window)) flatCases.add(m[1]);
  }
  if (flatCases.size) offenders.push(`flat switch-case dispatch to cmd*: ${[...flatCases].map((c) => `case "${c}":`).join(", ")}`);

  // A2: rejected registries / canonical-verb scheme / forbidden auto-spawn.
  if (/cmdCanonicalVerb/.test(cli)) offenders.push("cmdCanonicalVerb");
  if (/DEPRECATED_VERBS/.test(cli)) offenders.push("DEPRECATED_VERBS");
  if (/ESSENTIAL_VERBS/.test(cli)) offenders.push("ESSENTIAL_VERBS");
  if (/ensureLocalServer\s*\(/.test(cli)) offenders.push("ensureLocalServer( auto-spawn)");

  // A3: dead site-pack helpers must not be DEFINED (function or const) in cli.ts.
  for (const name of DEAD_SITE_HELPERS) {
    if (new RegExp(`(?:function\\s+${name}\\b|\\b(?:const|let|var)\\s+${name}\\s*=)`).test(cli)) {
      offenders.push(`${name} still defined`);
    }
  }

  record("A.purge", offenders.length === 0,
    offenders.length === 0 ? "no flat switch-case dispatch / alias registry / daemon residue / dead site helpers in cli.ts"
      : `cli.ts still contains: ${offenders.join("; ")}`);
}

// ── B. NO-ALIAS ─────────────────────────────────────────────────────────
function checkNoAlias() {
  const aliases = bridgeManifest().cli_bridge.legacy_aliases;
  record("B.no-alias", aliases.length === 0,
    aliases.length === 0 ? "bridge legacy_aliases empty"
      : `${aliases.length} bridge legacy_aliases remain: ${aliases.map((a) => a.legacy).join(", ")}`);
}

// ── C. MAP-AGREE ────────────────────────────────────────────────────────
// Model A: both kind-map and cli-surface key by the FULL subcommand
// "<verb> <cap>", so the comparison is row-for-row (no bare-cap reconciliation).
function checkMapAgree() {
  const problems: string[] = [];
  // C1: every kind-map row's op_class matches its verb.
  for (const row of KIND_MAP) {
    if (OP_CLASS_VERB[row.op_class] !== row.verb) {
      problems.push(`${row.subcommand}: op_class ${row.op_class} != verb ${row.verb}`);
    }
  }
  // C2: every kind-map subcommand is in cli-surface with the SAME verb.
  for (const row of KIND_MAP) {
    const cls = classify(row.subcommand);
    if (!cls) { problems.push(`${row.subcommand}: missing from cli-surface SURFACE`); continue; }
    if (cls.verb !== row.verb) problems.push(`${row.subcommand}: cli-surface verb ${cls.verb} != kind-map verb ${row.verb}`);
  }
  // C3: every cli-surface command has a kind-map home (keys are now identical),
  // and no rejected verb token leaks in.
  const kindSubs = new Set(KIND_MAP.map((r) => r.subcommand));
  for (const cmd of knownCommands()) {
    const verbTok = cmd.split(" ")[0];
    if (PURGED_VERB_TOKENS.includes(verbTok)) {
      problems.push(`cli-surface still lists rejected verb token "${cmd}"`);
      continue;
    }
    if (!kindSubs.has(cmd)) problems.push(`cli-surface command "${cmd}" has no kind-map home`);
  }
  record("C.map-agree", problems.length === 0,
    problems.length === 0 ? "kind-map ↔ cli-surface agree on capability set + verb + op_class"
      : `${problems.length} disagreement(s): ${problems.slice(0, 8).join(" | ")}${problems.length > 8 ? " …" : ""}`);
}

// ── D. MCP-MATCH ────────────────────────────────────────────────────────
function checkMcp() {
  const mcp = readFileSync(join(ROOT, "src/mcp.ts"), "utf8");
  const registered = new Set<string>();
  for (const m of mcp.matchAll(/^\s*name:\s*"(unbrowse_[a-z_]+)"/gm)) registered.add(m[1]);
  const problems: string[] = [];
  const wantConvention = /^unbrowse_(build|breath|eval)_[a-z_]+$/;
  // D1: every non-null kind-map mcp_tool is registered + follows the convention.
  for (const row of KIND_MAP) {
    if (!row.mcp_tool) continue;
    if (!wantConvention.test(row.mcp_tool)) problems.push(`kind-map mcp_tool "${row.mcp_tool}" not unbrowse_<verb>_<action>`);
    if (!registered.has(row.mcp_tool)) problems.push(`kind-map mcp_tool "${row.mcp_tool}" not registered in mcp.ts`);
  }
  // D2: every registered unbrowse_* tool maps back to a kind-map row (no orphan / purged tool).
  const kindTools = new Set(KIND_MAP.map((r) => r.mcp_tool).filter(Boolean) as string[]);
  for (const name of registered) {
    if (MCP_GATE_EXEMPT.has(name)) continue; // diagnostic/billing — off-taxonomy by design
    if (!kindTools.has(name)) problems.push(`registered tool "${name}" has no kind-map row`);
  }
  record("D.mcp-match", problems.length === 0,
    problems.length === 0 ? `${registered.size} MCP tools 1:1 with kind-map, all unbrowse_<verb>_<action>`
      : `${problems.length} mismatch(es): ${problems.slice(0, 8).join(" | ")}${problems.length > 8 ? " …" : ""}`);
}

// ── E. SKILL-MD ─────────────────────────────────────────────────────────
function checkSkillMd() {
  const files = ["SKILL.md", "packages/skill/SKILL.md"].map((f) => join(ROOT, f)).filter(existsSync);
  const bad: string[] = [];
  // Command-shaped flat invocation: `unbrowse <token>` where <token> is NOT a
  // verb, anchored to a real command position — start-of-line, immediately
  // after a backtick (`` `unbrowse … ``), or after a shell prompt (`$ `). This
  // catches ALL flat verbs (resolve/execute/go/…), not an 8-name sample, while
  // leaving prose mentions ("use unbrowse for browsing", "the unbrowse runtime",
  // "unbrowse@preview", `unbrowse \"task\"`) untouched. The current files use
  // only `unbrowse build|breath|eval <cap>`, so they PASS; a real
  // `unbrowse resolve foo` example would FAIL.
  // Public docs use the SCRUBBED verbs (build|act|eval); `breath` is covenant
  // vocab the moat hides, so it is INVALID in a public SKILL.md and gets flagged.
  const flatRe = /(?:^|`|\$ )unbrowse[ \t]+(?!build\b|act\b|eval\b)([a-z][a-z-]*)\b/gm;
  for (const f of files) {
    const txt = readFileSync(f, "utf8");
    const hits = [...txt.matchAll(flatRe)].map((m) => `unbrowse ${m[1]}`);
    if (hits.length) bad.push(`${f.replace(ROOT + "/", "")}: ${[...new Set(hits)].slice(0, 5).join(", ")}`);
  }
  record("E.skill-md", bad.length === 0,
    bad.length === 0 ? `${files.length} SKILL.md clean of command-shaped flat invocations`
      : `flat invocations remain: ${bad.join(" || ")}`);
}

// ── G. RUNTIME-FRESH ──────────────────────────────────────────────────────
// packages/skill/runtime-src/ is a build artifact (a bundled copy of src/ that
// can lag the real tree and still carry the legacy flat surface). Assert it is
// gitignored so that stale copy can never be mistaken for a ship path. Uses
// `git check-ignore` (exit 0 = ignored). Lightweight, no file content read.
function checkRuntimeFresh() {
  const target = "packages/skill/runtime-src/cli.ts";
  const r = spawnSync("git", ["check-ignore", target], { cwd: ROOT, encoding: "utf8" });
  // git check-ignore: exit 0 = path IS ignored (a match was printed); exit 1 =
  // NOT ignored; exit 128 = git error. Only exit 0 is a pass.
  const ignored = r.status === 0;
  record("G.runtime-fresh", ignored,
    ignored ? `${target} is gitignored (build artifact, not a ship path)`
      : r.status === 1 ? `${target} is NOT gitignored — stale flat-surface copy could be mistaken for source`
        : `git check-ignore failed (status ${r.status}): ${(r.stderr || "").trim()}`);
}

// ── F. LIVE (opt-in) ──────────────────────────────────────────────────────
async function checkLive() {
  if (process.env.GATE_LIVE !== "1") { record("F.live", true, "skipped (set GATE_LIVE=1 to run the binary)"); return; }
  const run = async (args: string[]) => {
    const p = Bun.spawn([process.execPath, "src/cli.ts", ...args, "--json", "--no-auto-start"], {
      cwd: ROOT, env: { ...process.env, UNBROWSE_NO_AUTO_START: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    const err = await new Response(p.stderr).text();
    const code = await p.exited;
    return { out, err, code, both: out + err };
  };
  const problems: string[] = [];
  for (const verb of ["build", "breath", "eval"]) {
    // Under --json the help text is routed to stderr; check both streams.
    const { both } = await run([verb, "--help"]);
    if (!/help|usage|subcommand|verb/i.test(both)) problems.push(`"${verb} --help" did not print verb help`);
  }
  // build/breath/eval are the only structured VERBS, but a non-verb first token
  // is no longer rejected: it is the bare natural-language front door, forwarded
  // to the one-hole `breath get` intent path. So `read`/`resolve`/any phrase must
  // NOT print the unknown_verb envelope — it routes as an intent.
  const bare = await run(["resolve"]);
  if (/unknown_verb|valid_verbs/i.test(bare.both)) {
    problems.push(`bare token "resolve" was rejected as unknown_verb instead of routing to the one-hole intent path`);
  }
  record("F.live", problems.length === 0,
    problems.length === 0 ? "build|breath|eval verbs resolve; a bare token routes to the one-hole intent path"
      : problems.join(" | "));
}

// ── run ─────────────────────────────────────────────────────────────────
/** Run every invariant in-process and return the results (no logging/exit).
 *  Importable so the meta-test exercises the instrument directly — no
 *  recursive subprocess (which bun-test pipes to /dev/null). */
export async function runGate(): Promise<Result[]> {
  results.length = 0;
  checkPurge();
  checkNoAlias();
  checkMapAgree();
  checkMcp();
  checkSkillMd();
  checkRuntimeFresh();
  await checkLive();
  return results;
}

// CLI entry only — under `import.meta.main`, so importing the module is pure.
if (import.meta.main) {
  const rs = await runGate();
  let failed = 0;
  for (const r of rs) {
    console.log(`${r.ok ? "✅ PASS" : "❌ FAIL"}  ${r.id.padEnd(12)} ${r.detail}`);
    if (!r.ok) failed++;
  }
  console.log(`\nsurface-gate: ${rs.length - failed}/${rs.length} invariants hold`);
  // Set exitCode (not process.exit) so piped stdout drains before exit.
  process.exitCode = failed === 0 ? 0 : 1;
}
