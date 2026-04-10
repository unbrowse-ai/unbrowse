#!/usr/bin/env bun
/**
 * harness-audit — LLM-judged review of harness scripts for silent drops.
 *
 * A "false harness" is one that records evidence only on the happy path
 * and silently drops tasks on failure, so the downstream judge can't tell
 * "task failed" from "task never ran". Pattern detection for this is a
 * code-review job, which means the judge must be an LLM reading the full
 * file — not grep/awk patterns on source text.
 *
 * Per memory feedback_no_heuristics_in_judge_jobs.md — classification on
 * unstructured input (source code IS unstructured from a review standpoint)
 * must be LLM-judged, never heuristic.
 *
 * Usage:
 *   bun scripts/harness-audit.ts                         # audit every harness
 *   bun scripts/harness-audit.ts scripts/foo.sh          # audit one file
 *   bun scripts/harness-audit.ts --strict                # exit 1 on findings
 *
 * Env:
 *   UNBROWSE_AGENT_JUDGE_MODEL  (default: gpt-4.1-mini)
 *   OPENAI_API_KEY | NEBIUS_API_KEY
 *
 * Output:
 *   JSON report to stdout: { file, verdict, findings, raw_response }
 *   Human summary to stderr
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const CHAT_URL = "https://api.tokenfactory.nebius.com/v1/chat/completions";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.UNBROWSE_AGENT_JUDGE_MODEL ?? "gpt-4.1-mini";
const TIMEOUT_MS = Number(process.env.UNBROWSE_AGENT_JUDGE_TIMEOUT_MS ?? 30000);
const MAX_FILE_BYTES = 48_000; // fits comfortably in gpt-4.1-mini context

type AuditResult = {
	file: string;
	verdict: "clean" | "silent_drop" | "suspicious" | "error";
	findings: string[];
	raw_response?: string;
};

function provider(): { url: string; key: string } | null {
	if (process.env.NEBIUS_API_KEY) return { url: CHAT_URL, key: process.env.NEBIUS_API_KEY };
	if (process.env.OPENAI_API_KEY) return { url: OPENAI_CHAT_URL, key: process.env.OPENAI_API_KEY };
	return null;
}

const SYSTEM_PROMPT = `You audit bash/TypeScript harness scripts for "silent drop" bugs.

A harness collects evidence (writes records/JSON artifacts) that a downstream judge reviews. A FALSE HARNESS silently drops evidence on some failure path — it only records a task when things work, so failures disappear from the artifact instead of being recorded as structured failures. The judge then reports "all green" because the failing task was never recorded.

Classic silent-drop patterns:
  - \`record "name"\` called only inside an \`if success\` branch with no else
  - Retry loop (\`for attempt in 1 2 3\`) that only records inside the happy branch and \`break\`s, with no final record on failure
  - \`|| true\` or \`2>/dev/null\` that swallow errors on a command whose output feeds into \`record\`, producing empty recorded values
  - Conditionals that skip a \`record\` call entirely when a precondition fails (e.g. \`if [ -n "$SKILL" ]; then record ...; fi\` with no else)
  - Task names in a judge's REQUIRED_TASKS list that aren't emitted anywhere in the harness (drift)
  - Any path where a task the judge expects to see could simply not appear in the artifact

Output STRICT JSON:
{
  "verdict": "clean" | "silent_drop" | "suspicious",
  "findings": ["one sentence per problem found, cite line numbers if visible"]
}

Rules:
- "clean" = every task is recorded on every path you can reach (success + failure)
- "silent_drop" = you can point to a specific path where a task the judge expects would vanish
- "suspicious" = you can't prove it's broken but the pattern looks risky
- Empty findings array for "clean". At least one finding for the other verdicts.
- Do not mention line numbers you can't actually see in the pasted source.
- If the file is not a harness (no record/artifact-writing), return verdict="clean" with findings=["not a harness — no evidence collection"].`;

async function auditOne(filePath: string): Promise<AuditResult> {
	if (!existsSync(filePath)) {
		return { file: filePath, verdict: "error", findings: ["file not found"] };
	}
	let content = readFileSync(filePath, "utf8");
	if (content.length > MAX_FILE_BYTES) {
		content = content.slice(0, MAX_FILE_BYTES) + "\n... [truncated]";
	}

	const p = provider();
	if (!p) {
		return {
			file: filePath,
			verdict: "error",
			findings: ["no LLM provider (set NEBIUS_API_KEY or OPENAI_API_KEY)"],
		};
	}

	const user = `File: ${filePath}\n\n\`\`\`\n${content}\n\`\`\``;

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(p.url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
			body: JSON.stringify({
				model: MODEL,
				response_format: { type: "json_object" },
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: user },
				],
				temperature: 0,
			}),
			signal: ctrl.signal,
		});
		if (!res.ok) throw new Error(`llm status ${res.status}`);
		const body = (await res.json()) as any;
		const text = body?.choices?.[0]?.message?.content ?? "{}";
		let parsed: { verdict?: string; findings?: string[] } = {};
		try {
			parsed = JSON.parse(text);
		} catch {
			return { file: filePath, verdict: "error", findings: ["llm returned non-JSON"], raw_response: text };
		}
		const verdict = (["clean", "silent_drop", "suspicious"].includes(parsed.verdict ?? "")
			? parsed.verdict
			: "error") as AuditResult["verdict"];
		return {
			file: filePath,
			verdict,
			findings: Array.isArray(parsed.findings) ? parsed.findings : [],
			raw_response: text,
		};
	} catch (err) {
		return {
			file: filePath,
			verdict: "error",
			findings: [`llm call failed: ${(err as Error).message}`],
		};
	} finally {
		clearTimeout(timer);
	}
}

async function main() {
	const args = process.argv.slice(2);
	const strict = args.includes("--strict");
	const files = args.filter((a) => !a.startsWith("--"));

	let toAudit: string[] = files;
	if (toAudit.length === 0) {
		// default: every .sh and .ts file in scripts/ that looks like a harness
		const dir = "scripts";
		toAudit = readdirSync(dir)
			.filter((f) => /\.(sh|ts)$/.test(f))
			.filter((f) => f !== "harness-audit.ts" && f !== "harness-audit.sh")
			.map((f) => join(dir, f))
			.filter((p) => {
				try {
					const content = readFileSync(p, "utf8");
					return /\brecord\s+["']/.test(content) || /results\.jsonl|agent-xp|bench-local|captured_meta/.test(content);
				} catch {
					return false;
				}
			});
	}

	console.error(`[harness-audit] auditing ${toAudit.length} file(s) via ${MODEL}`);
	const results: AuditResult[] = [];
	for (const f of toAudit) {
		console.error(`  reviewing ${f}`);
		const r = await auditOne(f);
		results.push(r);
	}

	console.log(JSON.stringify({ model: MODEL, results }, null, 2));

	console.error("");
	let bad = 0;
	for (const r of results) {
		const marker = r.verdict === "clean" ? "✓" : r.verdict === "silent_drop" ? "✗" : r.verdict === "suspicious" ? "?" : "·";
		console.error(`  ${marker} ${r.file} [${r.verdict}]`);
		for (const f of r.findings) console.error(`      ${f}`);
		if (r.verdict === "silent_drop" || r.verdict === "error") bad++;
	}
	console.error("");
	console.error(`[harness-audit] ${bad} problematic harness(es) out of ${results.length}`);
	if (strict && bad > 0) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
