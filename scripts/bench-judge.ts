#!/usr/bin/env bun
/**
 * bench-judge — LLM agent judge for ambiguous bench classifier cases.
 *
 * Reads a single per-URL .out file from .bench-local/, extracts the
 * captured_meta and intent, and asks a small LLM to classify the outcome
 * as pass | fail | block with a one-sentence reason.
 *
 * This is the "agent judges" layer of the harness-collects-agent-judges
 * pattern. Rules in bench-local.sh handle the clear cases (zero api calls +
 * tiny text + failing intent = block). This script handles the cases the
 * rules flag as "uncertain".
 *
 * Usage:
 *   bun scripts/bench-judge.ts .bench-local/5_*.out
 *   bun scripts/bench-judge.ts --all        # judge every fail in .bench-local
 *
 * Env:
 *   UNBROWSE_AGENT_JUDGE_MODEL (default: gpt-4.1-mini)
 *   UNBROWSE_AGENT_JUDGE_TIMEOUT_MS (default: 10000)
 *   OPENAI_API_KEY | NEBIUS_API_KEY
 *
 * Output: JSON to stdout, verdict field populated per file.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const CHAT_URL = "https://api.tokenfactory.nebius.com/v1/chat/completions";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.UNBROWSE_AGENT_JUDGE_MODEL ?? "gpt-4.1-mini";
const TIMEOUT_MS = Number(process.env.UNBROWSE_AGENT_JUDGE_TIMEOUT_MS ?? 10000);

type Meta = {
	html_bytes?: number;
	title?: string;
	text_bytes?: number;
	observed_api_calls?: number;
	intent_verdict?: string;
	intent_reason?: string;
};

type Verdict = {
	file: string;
	url: string;
	intent: string;
	rule_verdict: string;
	agent_verdict: "pass" | "fail" | "block" | "uncertain";
	agent_reason: string;
	meta: Meta;
};

function provider(): { url: string; key: string } | null {
	if (process.env.NEBIUS_API_KEY) return { url: CHAT_URL, key: process.env.NEBIUS_API_KEY };
	if (process.env.OPENAI_API_KEY) return { url: OPENAI_CHAT_URL, key: process.env.OPENAI_API_KEY };
	return null;
}

async function judgeOne(outPath: string): Promise<Verdict | null> {
	const raw = readFileSync(outPath, "utf8");
	// Extract the resolve response JSON (first object starting with {"trace")
	const m = raw.match(/\{"trace"[\s\S]*\}/);
	if (!m) return null;
	let d: any;
	try { d = JSON.parse(m[0]); } catch { return null; }
	const result = d.result ?? {};
	const meta: Meta = result.captured_meta ?? {};

	// Find the corresponding results.jsonl row to get intent + url + rule verdict
	// Fallback: parse the filename slug
	const fname = outPath.split("/").pop() ?? "";
	const url = fname.replace(/^\d+_/, "").replace(/\.out$/, "").replace(/_/g, "/").replace("https//", "https://").replace("http//", "http://");

	const intent = d.intent ?? d.trace?.intent ?? "(unknown intent)";

	const p = provider();
	if (!p) {
		return {
			file: outPath, url, intent,
			rule_verdict: "unknown",
			agent_verdict: "uncertain",
			agent_reason: "no LLM provider (set NEBIUS_API_KEY or OPENAI_API_KEY)",
			meta,
		};
	}

	const system = `You classify agent-browser capture outcomes.

Given an intent, a URL, and structured capture metadata (html_bytes, title, text_bytes, observed_api_calls, intent_verdict), output strict JSON:
  { "verdict": "pass" | "fail" | "block", "reason": "one sentence" }

Rules:
- "pass": the browser captured meaningful content OR API calls that match the intent
- "fail": the browser captured real content but it didn't match the intent (real product gap — we could improve extraction)
- "block": the browser captured a degraded/challenge/auth-wall/captcha/empty page, OR observed zero API calls with tiny text AND the intent match failed. These are browser-level defeats that need real-browser cookies, not product fixes.

Do not guess site identity. Classify purely on the signals.`;

	const user = JSON.stringify({ intent, url, captured_meta: meta }, null, 2);

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
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				temperature: 0,
			}),
			signal: ctrl.signal,
		});
		if (!res.ok) throw new Error(`llm ${res.status}`);
		const body = await res.json() as any;
		const content = body?.choices?.[0]?.message?.content ?? "{}";
		const parsed = JSON.parse(content);
		return {
			file: outPath, url, intent,
			rule_verdict: "delegated",
			agent_verdict: parsed.verdict ?? "uncertain",
			agent_reason: parsed.reason ?? "",
			meta,
		};
	} catch (err) {
		return {
			file: outPath, url, intent,
			rule_verdict: "unknown",
			agent_verdict: "uncertain",
			agent_reason: `llm error: ${(err as Error).message}`,
			meta,
		};
	} finally {
		clearTimeout(timer);
	}
}

async function main() {
	const args = process.argv.slice(2);
	let files: string[] = [];
	if (args[0] === "--all") {
		const dir = ".bench-local";
		files = readdirSync(dir).filter((f) => f.endsWith(".out")).map((f) => join(dir, f));
	} else {
		files = args;
	}
	if (files.length === 0) {
		console.error("usage: bun scripts/bench-judge.ts <file.out> [...]  OR  --all");
		process.exit(1);
	}
	const results: Verdict[] = [];
	for (const f of files) {
		const v = await judgeOne(f);
		if (v) results.push(v);
	}
	console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
