/**
 * micro_rouge_readable — validate the d50 `--main` readable extraction on REAL
 * benchmark data (not just the synthetic fixture).
 *
 * d48 measured `unbrowse fetch` (whole-page → markdown) at ROUGE-L 0.74 on the
 * 7 github-blob URLs, the chrome-noise gap. d50 wired cleanDOM into fetch
 * (--main). This runs BOTH the new readable path (cleanDOM→turndown) and the
 * old plain path over the SAME fetched HTML for those 7 URLs and reports the
 * real before/after vs the raw-file golden. No LLM, no funds.
 *
 *   golden    = curl raw.githubusercontent file (authoritative)
 *   html      = unbrowse fetch <blob> --raw     (the HTML unbrowse sees)
 *   plain     = htmlToPlainMarkdown(html)        (d48 baseline ~0.74)
 *   readable  = htmlToReadableMarkdown(html)      (d50 capability)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { htmlToReadableMarkdown, htmlToPlainMarkdown } from "../../src/extraction/readable-markdown.js";

const run = promisify(execFile);
const UNBROWSE = process.env.UNBROWSE_BIN ?? "/Users/lekt9/.bun/bin/unbrowse";
const CORPUS = new URL("./vendor/benchmarks/webcode-benchmark/data/contents/code_contents.jsonl", import.meta.url).pathname;

function rougeL(golden: string, extracted: string): number {
	const g = golden.split(/\s+/).filter(Boolean).slice(0, 10000);
	const e = extracted.split(/\s+/).filter(Boolean).slice(0, 10000);
	if (!g.length || !e.length) return 0;
	const m = g.length, n = e.length;
	let prev = new Array(n + 1).fill(0);
	for (let i = 1; i <= m; i++) {
		const curr = new Array(n + 1).fill(0);
		for (let j = 1; j <= n; j++) curr[j] = g[i - 1] === e[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
		prev = curr;
	}
	const lcs = prev[n], p = lcs / n, r = lcs / m;
	return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

const rawUrl = (blob: string) => blob.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/");

async function sh(cmd: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await run(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 90_000 });
		return stdout;
	} catch {
		return "";
	}
}

const rows = readFileSync(CORPUS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const gh = rows.filter((r: { url: string }) => r.url.includes("github.com") && r.url.includes("/blob/"));
console.log(`[readable] ${gh.length} github-blob URLs — plain (d48 baseline) vs readable (d50 --main)\n`);

const plains: number[] = [];
const readables: number[] = [];
for (const r of gh) {
	const golden = await sh("curl", ["-sL", rawUrl(r.url)]);
	if (!golden.trim()) { console.log(`  [skip] ${r.id}: golden failed`); continue; }
	const html = await sh(UNBROWSE, ["fetch", r.url, "--raw"]);
	if (!html.trim()) { console.log(`  [skip] ${r.id}: fetch --raw empty`); continue; }
	const plain = await htmlToPlainMarkdown(html);
	const readable = await htmlToReadableMarkdown(html);
	const rp = rougeL(golden, plain), rr = rougeL(golden, readable);
	plains.push(rp); readables.push(rr);
	const arrow = rr > rp ? "↑" : rr < rp ? "↓" : "=";
	console.log(`  ${r.id}: plain=${rp.toFixed(4)} readable=${rr.toFixed(4)} ${arrow}  ${r.url.split("/").pop()}`);
}

const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
console.log(`\n[readable] n=${readables.length}  plain_avg=${avg(plains).toFixed(4)}  readable_avg=${avg(readables).toFixed(4)}  (Exa published = 0.828)`);
console.log(`[readable] delta=${(avg(readables) - avg(plains)).toFixed(4)} — does --main close the chrome-noise gap?`);
