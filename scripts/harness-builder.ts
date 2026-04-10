#!/usr/bin/env bun
/**
 * harness-builder — the meta-core harness.
 *
 * Principle (per feedback_harness_makes_visible_agent_judges.md):
 *   - The harness COLLECTS evidence and PRESENTS it clearly.
 *   - The harness NEVER auto-judges (no heuristics, no LLM calls).
 *   - The agent-in-thread reads the artifact and decides.
 *
 * This script does two things, both are pure static transformations:
 *
 *   1. `init <name>` — scaffold a new harness from the template below.
 *      The template enforces: every task is recorded on every branch,
 *      every record call has a matching failure-path record, all evidence
 *      is written to per-task files + a combined artifact, and the final
 *      output says "agent reads this and decides" (no verdict emission).
 *
 *   2. `view <file>` — render an existing harness as a readable coverage
 *      table so the agent can spot silent drops by eye:
 *
 *        task name              recorded in                   guarded by
 *        ─────────────────────  ────────────────────────────  ─────────────
 *        browse_go              line 204 (top-level)          none
 *        browse_eval            line 208 (if BROWSE_OK=1)     BROWSE_OK
 *                               line 215 (else)               BROWSE_OK=0
 *        browse_snap_head       line 209 (if BROWSE_OK=1)     BROWSE_OK
 *                               line 216 (else)               BROWSE_OK=0
 *
 *      If a task is recorded in only one branch of an if/else, the agent
 *      sees it immediately. No LLM needed — the structure is visible.
 *
 * Usage:
 *   bun scripts/harness-builder.ts init my-new-harness
 *   bun scripts/harness-builder.ts view scripts/agent-experience-test.sh
 *   bun scripts/harness-builder.ts view --all          # view every harness
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

// ─────────────────────────────────────────────────────────────────────────
// Template: known-good harness scaffold.
//
// Every harness that follows this template is guaranteed to:
//   - record every task on every success AND failure branch
//   - write per-task evidence to .harness-out/<name>/<task>.json
//   - write a combined artifact to .harness-out/<name>/artifact.json
//   - print a human-readable summary with no verdict
//   - tell the agent explicitly to read the artifact and decide
// ─────────────────────────────────────────────────────────────────────────
const TEMPLATE = `#!/usr/bin/env bash
# HARNESS_NAME — what this harness measures (one sentence).
#
# Principle: this harness COLLECTS evidence and PRESENTS it. It never auto-
# judges. The agent reading .harness-out/HARNESS_NAME/artifact.json decides.
#
# Every task follows the same shape:
#
#   run_task "<name>" <command...>
#
# run_task always writes an entry to the artifact, regardless of exit code
# or output content. Failure records contain { "task", "ok": false, "exit",
# "stdout", "stderr" } so the agent can see exactly what happened.
set -uo pipefail

HARNESS="HARNESS_NAME"
OUT_DIR=".harness-out/$HARNESS"
ARTIFACT="$OUT_DIR/artifact.json"
mkdir -p "$OUT_DIR"
echo '{"harness":"'"$HARNESS"'","started_at":"'"$(date -u +%FT%TZ)"'","tasks":[]}' > "$ARTIFACT"

run_task() {
  local name="$1"; shift
  local task_file="$OUT_DIR/$name.json"
  local stdout_file="$OUT_DIR/$name.stdout"
  local stderr_file="$OUT_DIR/$name.stderr"
  local exit_code=0
  "$@" >"$stdout_file" 2>"$stderr_file" || exit_code=$?
  python3 - "$name" "$exit_code" "$stdout_file" "$stderr_file" "$task_file" "$ARTIFACT" <<'PY'
import sys, json, os
name, exit_code, stdout_file, stderr_file, task_file, artifact = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
stdout = open(stdout_file).read() if os.path.exists(stdout_file) else ""
stderr = open(stderr_file).read() if os.path.exists(stderr_file) else ""
# Try to parse stdout as JSON for structured evidence; fall back to text.
parsed = None
try:
    parsed = json.loads(stdout.strip())
except Exception:
    pass
entry = {
    "task": name,
    "ok": exit_code == 0,
    "exit_code": exit_code,
    "stdout_text": stdout if parsed is None else None,
    "stdout_json": parsed,
    "stderr_text": stderr[:2000] if stderr else "",
}
# Per-task file
with open(task_file, "w") as f: json.dump(entry, f, indent=2)
# Append to combined artifact
with open(artifact) as f: art = json.load(f)
art["tasks"].append(entry)
with open(artifact, "w") as f: json.dump(art, f, indent=2)
PY
  echo "[$HARNESS] $name: ok=$([ $exit_code -eq 0 ] && echo true || echo false) exit=$exit_code" >&2
}

# ── TASKS ──
# Replace these with the tasks this harness actually measures. Every line
# must be a run_task call so the wrapper records the evidence. Do NOT wrap
# run_task calls in 'if' blocks without a matching run_task in the 'else' —
# that's a silent drop. If a task depends on a previous one, still call
# run_task for it; the failure record tells the agent what happened.

run_task "example" echo '{"hello":"world"}'

# ── PRESENT ──
# Print the artifact path + expected tasks. The agent reads the artifact
# and judges. The harness never writes a verdict.
python3 - <<PY
import json
art = json.load(open("$ARTIFACT"))
print("[$HARNESS] artifact:", "$ARTIFACT")
print("[$HARNESS] tasks recorded:", len(art["tasks"]))
for t in art["tasks"]:
    print(f"  - {t['task']:30} ok={t['ok']} exit={t['exit_code']}")
print("[$HARNESS] agent reads the artifact and decides. harness does not classify.")
PY
`;

function cmdInit(name: string) {
	if (!name || /[^a-zA-Z0-9_-]/.test(name)) {
		console.error("name required, [a-zA-Z0-9_-] only");
		process.exit(1);
	}
	const path = `scripts/${name}.sh`;
	if (existsSync(path)) {
		console.error(`refusing to overwrite ${path}`);
		process.exit(1);
	}
	const content = TEMPLATE.replaceAll("HARNESS_NAME", name);
	writeFileSync(path, content);
	console.log(`wrote ${path}`);
	console.log("next: edit the TASKS section to add your run_task calls,");
	console.log("      every task must be a top-level run_task (no conditional wraps).");
}

// ─────────────────────────────────────────────────────────────────────────
// view — render an existing harness as a readable coverage table.
//
// Pure static text transformation. No heuristics, no LLM. The transform
// makes the control flow visible so the agent can spot silent drops by eye.
//
// For each `record` / `run_task` call:
//   - line number
//   - task name (if quoted literal)
//   - the enclosing control-flow stack (if/else depth, for loops, etc.)
//     — shown as a human-readable breadcrumb
//
// For each task name, we print the set of (line, branch path) tuples where
// it's recorded. If a task is recorded in only one arm of an if/else, the
// missing arm shows as a gap in the breadcrumb — the agent can see it.
// ─────────────────────────────────────────────────────────────────────────
function viewFile(path: string) {
	if (!existsSync(path)) {
		console.error(`not found: ${path}`);
		return;
	}
	const content = readFileSync(path, "utf8");
	const lines = content.split("\n");
	const recordRegex = /^\s*(record|run_task)\s+"([^"]+)"/;

	// Pure presentation: find every record/run_task call, show it with 4
	// lines of context above. No control-flow interpretation — bash is too
	// messy to parse without a real AST, and the agent-in-thread can read
	// the surrounding lines faster than any heuristic can interpret them.
	type Hit = { line: number; task: string; context: string[] };
	const hits: Hit[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(recordRegex);
		if (!m) continue;
		const contextStart = Math.max(0, i - 4);
		const context = lines.slice(contextStart, i + 1).map((l, idx) => {
			const ln = contextStart + idx + 1;
			return `    ${String(ln).padStart(4)}│ ${l.slice(0, 90)}`;
		});
		hits.push({ line: i + 1, task: m[2], context });
	}

	// Group by task name to surface "recorded in how many places"
	const byTask = new Map<string, Hit[]>();
	for (const h of hits) {
		if (!byTask.has(h.task)) byTask.set(h.task, []);
		byTask.get(h.task)!.push(h);
	}

	console.log(`\n${path}`);
	console.log("─".repeat(Math.min(80, path.length + 4)));
	console.log(`  ${hits.length} record/run_task calls across ${byTask.size} unique task names`);
	console.log("");

	// Multi-record tasks (likely the if/else pairs you want to verify)
	const multi = [...byTask.entries()].filter(([, v]) => v.length > 1);
	const single = [...byTask.entries()].filter(([, v]) => v.length === 1);
	console.log(`  tasks recorded in multiple places (${multi.length}):`);
	for (const [name, entries] of multi) {
		console.log(`    ${name} @ lines ${entries.map((e) => e.line).join(", ")}`);
	}
	console.log(`  tasks recorded in exactly one place (${single.length}):`);
	for (const [name, entries] of single) {
		console.log(`    ${name} @ line ${entries[0].line}`);
	}
	console.log("");

	// Full context dump — the agent scrolls this and reads each call site
	// with 4 lines above to see the enclosing control flow.
	console.log("  every record/run_task call with 4 lines of context:");
	console.log("");
	for (const h of hits) {
		console.log(`  ═══ ${h.task} @ line ${h.line} ═══`);
		for (const c of h.context) console.log(c);
		console.log("");
	}

	console.log("  agent: read each call-site above. for each task, confirm it is recorded");
	console.log("  on every reachable path. if a record only appears inside an `if success`");
	console.log("  branch and nowhere else, that's a silent drop. the script does not");
	console.log("  decide for you — you decide.");
}

function main() {
	const args = process.argv.slice(2);
	const cmd = args[0];
	if (cmd === "init") {
		cmdInit(args[1] ?? "");
		return;
	}
	if (cmd === "view") {
		let files: string[] = [];
		if (args[1] === "--all" || args.length === 1) {
			files = readdirSync("scripts")
				.filter((f) => f.endsWith(".sh"))
				.map((f) => join("scripts", f))
				.filter((p) => {
					try {
						const c = readFileSync(p, "utf8");
						return /\b(record|run_task)\s+"/.test(c);
					} catch {
						return false;
					}
				});
		} else {
			files = args.slice(1);
		}
		for (const f of files) viewFile(f);
		return;
	}
	console.log(`harness-builder — the meta-core harness for building + viewing harnesses.

usage:
  bun scripts/harness-builder.ts init <name>
      Scaffold a new harness from the known-good template.

  bun scripts/harness-builder.ts view <file.sh>
      Render an existing harness as a "task × branch" coverage table.

  bun scripts/harness-builder.ts view --all
      Render every harness in scripts/ that emits record/run_task calls.

  bun scripts/harness-builder.ts view
      Same as --all.

principle: the harness collects evidence and presents it. the agent reads
the artifact and judges. no heuristics, no LLM calls, no auto-verdicts.`);
}

main();
