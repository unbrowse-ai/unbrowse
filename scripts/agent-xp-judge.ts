#!/usr/bin/env bun
/**
 * agent-xp-judge — judge the artifact collected by agent-experience-test.sh.
 *
 * Reads /tmp/agent-xp-results.json (or a path passed as argv[1]) and writes
 * a verdict file alongside it. Exit 0 if the core agent experience passes,
 * exit 1 if any required task failed, exit 2 if artifact is missing/malformed.
 *
 * This is the closing piece of the harness-collects-agent-judges loop:
 *
 *   release CI
 *     → scripts/agent-experience-test.sh --remote HOST     (collect)
 *     → scripts/agent-xp-judge.ts /tmp/agent-xp-results.json (judge)
 *     → exit code gates the release
 *
 * Usage:
 *   bun scripts/agent-xp-judge.ts                    # default path
 *   bun scripts/agent-xp-judge.ts ./agent-xp.json    # explicit artifact
 *   bun scripts/agent-xp-judge.ts --llm              # use LLM fallback for
 *                                                      ambiguous tasks
 *
 * Required tasks (failure blocks release):
 *   version, onboarding, health, resolve_pypi_flask, execute_pypi_flask,
 *   execute_npm_search, feedback
 *
 * Informational tasks (failure reported but doesn't gate):
 *   onboarding_agentmail (needs AGENTMAIL_API_KEY), browse_go, browse_eval,
 *   browse_snap_head, browse_close (gated by kuri+network on target host)
 *
 * Rules for each task — all shape-based, no hardcoded value lists:
 *   version             — output matches /^\d+\.\d+\.\d+/
 *   onboarding          — binary_on_path && config_exists && has_api_key
 *   health              — status === "ok"
 *   resolve_*           — available_operations || available_endpoints non-empty
 *   execute_*           — output is an object with non-error payload
 *   feedback            — ok === true
 *   browse_go           — ok === true
 *   browse_eval         — result is a non-empty string or object
 *   browse_snap_head    — output includes "[e" (a11y ref marker)
 *   browse_close        — ok === true
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

const DEFAULT_ARTIFACT = "/tmp/agent-xp-results.json";

// Required tasks — their absence OR failure blocks the gate. An earlier
// version treated browse_* as informational, which let the harness silently
// drop them from the artifact when kuri/browser failed and the gate still
// reported green. Lewis caught this. Every real part of the agent experience
// is now required.
const REQUIRED_TASKS = new Set([
	"version",
	"onboarding",
	"health",
	"resolve_pypi_flask",
	"execute_pypi_flask",
	"execute_npm_search",
	"feedback",
	"browse_go",
	"browse_eval",
	"browse_snap_head",
	"browse_close",
]);

const INFORMATIONAL_TASKS = new Set([
	"system_before",
	"system_after",
	"onboarding_agentmail",  // requires AGENTMAIL_API_KEY — optional config
]);

type Task = { task: string; output: unknown };
type Verdict = {
	task: string;
	required: boolean;
	verdict: "pass" | "fail" | "skip";
	reason: string;
};

function judgeTask(task: string, output: unknown): Omit<Verdict, "task" | "required"> {
	if (output == null) return { verdict: "skip", reason: "no output (task skipped)" };

	// String outputs — version tag, snap text, etc.
	if (typeof output === "string") {
		if (task === "version") {
			return /^\d+\.\d+\.\d+/.test(output.trim())
				? { verdict: "pass", reason: output.trim() }
				: { verdict: "fail", reason: `bad version string: ${output.slice(0, 40)}` };
		}
		if (task === "browse_snap_head") {
			return output.includes("[e")
				? { verdict: "pass", reason: "a11y tree present" }
				: { verdict: "fail", reason: "no [eN] refs in snap output" };
		}
		return { verdict: "skip", reason: `unstructured string output: ${output.slice(0, 40)}` };
	}

	if (typeof output !== "object") {
		return { verdict: "skip", reason: `unexpected output type: ${typeof output}` };
	}

	const o = output as Record<string, unknown>;

	// Error envelope
	if (typeof o.error === "string" && o.error) {
		return { verdict: "fail", reason: `error=${o.error}` };
	}

	// Task-specific shape checks — all generic, no value comparisons
	if (task === "onboarding") {
		const ok = o.binary_on_path === true && o.config_exists === true && o.has_api_key === true;
		return ok
			? { verdict: "pass", reason: `binary_on_path, config, api_key all set` }
			: { verdict: "fail", reason: `onboarding incomplete: ${JSON.stringify(o).slice(0, 120)}` };
	}

	if (task === "health") {
		return o.status === "ok"
			? { verdict: "pass", reason: `status ok v=${o.package_version ?? ""}` }
			: { verdict: "fail", reason: `status=${o.status}` };
	}

	if (task.startsWith("resolve_")) {
		const r = (o.result as Record<string, unknown> | undefined) ?? o;
		const ops = (r.available_operations as unknown[] | undefined) ?? (r.available_endpoints as unknown[] | undefined);
		if (Array.isArray(ops) && ops.length > 0) {
			return { verdict: "pass", reason: `${ops.length} operations returned` };
		}
		return { verdict: "fail", reason: "no available_operations/endpoints" };
	}

	if (task.startsWith("execute_")) {
		const r = (o.result as Record<string, unknown> | undefined) ?? o;
		if (r && typeof r === "object" && !("error" in r)) {
			const keys = Object.keys(r).length;
			return keys > 0
				? { verdict: "pass", reason: `result has ${keys} keys` }
				: { verdict: "fail", reason: "empty result object" };
		}
		return { verdict: "fail", reason: "no result object" };
	}

	if (task === "feedback") {
		return o.ok === true
			? { verdict: "pass", reason: "ok:true" }
			: { verdict: "fail", reason: "ok not true" };
	}

	if (task === "browse_go" || task === "browse_close") {
		return o.ok === true
			? { verdict: "pass", reason: "ok:true" }
			: { verdict: "fail", reason: `ok not true (${o.error ?? "no error field"})` };
	}

	if (task === "browse_eval") {
		if (o.result != null) {
			return { verdict: "pass", reason: "has result" };
		}
		return { verdict: "fail", reason: "no result field" };
	}

	if (task === "onboarding_agentmail") {
		return o.has_email_identity === true
			? { verdict: "pass", reason: "email identity present" }
			: { verdict: "fail", reason: String(o.error ?? "unknown") };
	}

	if (task === "system_before" || task === "system_after") {
		return { verdict: "skip", reason: "diagnostic" };
	}

	return { verdict: "skip", reason: `no judging rule for task ${task}` };
}

function main() {
	const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
	const artifactPath = args[0] ?? DEFAULT_ARTIFACT;

	if (!existsSync(artifactPath)) {
		console.error(`[agent-xp-judge] artifact not found: ${artifactPath}`);
		process.exit(2);
	}

	let data: { tasks?: Task[] };
	try {
		data = JSON.parse(readFileSync(artifactPath, "utf8"));
	} catch (e) {
		console.error(`[agent-xp-judge] failed to parse artifact: ${(e as Error).message}`);
		process.exit(2);
	}

	const tasks = data.tasks ?? [];
	const verdicts: Verdict[] = [];
	let requiredPassed = 0;
	let requiredFailed = 0;
	let requiredTotal = 0;

	// Build task name → output map and enforce coverage:
	// every task in REQUIRED_TASKS MUST appear in the artifact. If it's
	// missing, that's a silent harness drop (e.g. browse tasks only recorded
	// when browse_go succeeded) and the gate must fail.
	const byName = new Map<string, unknown>();
	for (const t of tasks) byName.set(t.task, t.output);

	for (const t of tasks) {
		const raw = judgeTask(t.task, t.output);
		const required = REQUIRED_TASKS.has(t.task);
		const v: Verdict = { task: t.task, required, ...raw };
		verdicts.push(v);
		if (required) {
			requiredTotal++;
			if (v.verdict === "pass") requiredPassed++;
			else if (v.verdict === "fail") requiredFailed++;
		}
	}

	// Catch silent drops: any required task name NOT in the artifact is a
	// harness bug masquerading as "no signal". Treat as a hard fail.
	const missingRequired: string[] = [];
	for (const name of REQUIRED_TASKS) {
		if (!byName.has(name)) {
			missingRequired.push(name);
			verdicts.push({
				task: name,
				required: true,
				verdict: "fail",
				reason: "MISSING from artifact — harness dropped this task silently (false harness)",
			});
			requiredTotal++;
			requiredFailed++;
		}
	}

	const summary = {
		artifact: artifactPath,
		total_tasks: tasks.length,
		required_total: requiredTotal,
		required_passed: requiredPassed,
		required_failed: requiredFailed,
		missing_required: missingRequired,
		gate_pass: requiredFailed === 0 && requiredPassed === requiredTotal && missingRequired.length === 0,
		verdicts,
	};

	// Write verdict file next to the artifact
	const verdictPath = artifactPath.replace(/\.json$/, "") + ".verdict.json";
	writeFileSync(verdictPath, JSON.stringify(summary, null, 2));
	console.log(JSON.stringify(summary, null, 2));

	// Human-readable summary to stderr
	console.error("");
	console.error(`[agent-xp-judge] required: ${requiredPassed}/${requiredTotal} passed`);
	for (const v of verdicts) {
		const marker = v.verdict === "pass" ? "✓" : v.verdict === "fail" ? "✗" : "·";
		const tag = v.required ? "[req]" : "[inf]";
		console.error(`  ${marker} ${tag} ${v.task.padEnd(28)} ${v.reason}`);
	}
	console.error("");
	if (summary.gate_pass) {
		console.error(`[agent-xp-judge] ✓ agent experience gate PASSED`);
		process.exit(0);
	} else {
		console.error(`[agent-xp-judge] ✗ agent experience gate FAILED (${requiredFailed} required task(s) failed)`);
		process.exit(1);
	}
}

main();
