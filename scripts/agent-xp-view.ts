#!/usr/bin/env bun
/**
 * agent-xp-view — render the agent-experience-test artifact as a flat
 * table the agent can read in-thread.
 *
 * NOT a judge. Per feedback_harness_makes_visible_agent_judges.md, the
 * harness never auto-classifies. This script only extracts the structured
 * fields from each task's output and presents them in a uniform shape so
 * the agent reading it can decide.
 *
 * What it shows per task:
 *   - task name
 *   - which expected task names are PRESENT vs MISSING from the artifact
 *     (a task expected by the test script but absent from the artifact is
 *     a "silent drop" and the agent should flag it)
 *   - the raw output fields that matter for judgment:
 *       status, ok, error, error_code, available_operations count,
 *       result key count, package_version, etc.
 *
 * Usage:
 *   bun scripts/agent-xp-view.ts                          # default path
 *   bun scripts/agent-xp-view.ts ./agent-xp.json          # explicit artifact
 */

import { existsSync, readFileSync } from "fs";

const DEFAULT_ARTIFACT = "/tmp/agent-xp-results.json";

// The set of tasks the test script EMITS on every run, with the failure
// path also recording. If any of these are missing from the artifact, the
// harness dropped evidence and the agent should treat that as a blocker.
const EXPECTED_TASKS = [
	"system_before",
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
	"system_after",
];

function summarizeField(output: unknown): Record<string, unknown> {
	if (output == null) return { _empty: true };
	if (typeof output === "string") {
		return { _type: "string", value: output.length > 120 ? output.slice(0, 120) + "…" : output };
	}
	if (typeof output !== "object") return { _type: typeof output };
	const o = output as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	// Pull every field an agent would look at. Zero interpretation.
	for (const k of [
		"status", "ok", "error", "success",
		"package_version",
		"binary_on_path", "config_exists", "has_api_key", "has_wallet",
		"server_http_code",
		"has_email_identity",
	]) {
		if (k in o) out[k] = o[k];
	}
	// Count collection-shaped fields without rendering them
	if ("available_operations" in o && Array.isArray(o.available_operations)) {
		out.available_operations_count = (o.available_operations as unknown[]).length;
	}
	if ("available_endpoints" in o && Array.isArray(o.available_endpoints)) {
		out.available_endpoints_count = (o.available_endpoints as unknown[]).length;
	}
	if ("result" in o && o.result != null && typeof o.result === "object") {
		out.result_keys_count = Object.keys(o.result as Record<string, unknown>).length;
	}
	// Drop verbose nested objects — agent can open the raw artifact if needed
	return out;
}

function main() {
	const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
	const artifactPath = args[0] ?? DEFAULT_ARTIFACT;

	if (!existsSync(artifactPath)) {
		console.error(`[agent-xp-view] artifact not found: ${artifactPath}`);
		process.exit(2);
	}

	let data: { tasks?: { task: string; output: unknown }[] };
	try {
		data = JSON.parse(readFileSync(artifactPath, "utf8"));
	} catch (e) {
		console.error(`[agent-xp-view] failed to parse artifact: ${(e as Error).message}`);
		process.exit(2);
	}

	const tasks = data.tasks ?? [];
	const present = new Set(tasks.map((t) => t.task));
	const missing = EXPECTED_TASKS.filter((n) => !present.has(n));
	const extra = tasks.map((t) => t.task).filter((n) => !EXPECTED_TASKS.includes(n));

	const rows = tasks.map((t) => ({
		task: t.task,
		expected: EXPECTED_TASKS.includes(t.task),
		fields: summarizeField(t.output),
	}));

	const report = {
		artifact: artifactPath,
		task_count: tasks.length,
		expected_count: EXPECTED_TASKS.length,
		missing_from_artifact: missing,
		unexpected_in_artifact: extra,
		rows,
	};

	console.log(JSON.stringify(report, null, 2));

	// Human-readable table on stderr. No pass/fail verdict — the agent
	// reading the artifact decides.
	console.error("");
	console.error(`artifact:       ${artifactPath}`);
	console.error(`tasks present:  ${tasks.length} / ${EXPECTED_TASKS.length} expected`);
	if (missing.length > 0) {
		console.error(`⚠ MISSING from artifact (silent drops — agent should investigate):`);
		for (const m of missing) console.error(`    ${m}`);
	}
	if (extra.length > 0) {
		console.error(`  extra tasks: ${extra.join(", ")}`);
	}
	console.error("");
	console.error(`  ${"task".padEnd(28)}  fields`);
	console.error(`  ${"─".repeat(28)}  ${"─".repeat(40)}`);
	for (const r of rows) {
		const marker = r.expected ? " " : "?";
		const f = Object.entries(r.fields)
			.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
			.join(", ");
		console.error(`${marker} ${r.task.padEnd(28)}  ${f.slice(0, 80)}`);
	}
	console.error("");
	console.error("[agent-xp-view] harness presents evidence. agent-in-thread judges.");
}

main();
