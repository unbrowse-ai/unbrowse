/**
 * readable-markdown — main-content extraction for fetch. Proves cleanDOM-before-
 * turndown strips page chrome and raises extraction fidelity (ROUGE-L to the
 * clean source), the concrete gap the exa micro-benchmark measured (unbrowse
 * fetch = 0.74 vs Exa 0.828, due to ~50% chrome noise).
 */
import { describe, it, expect } from "bun:test";
import { htmlToReadableMarkdown, htmlToPlainMarkdown } from "../src/extraction/readable-markdown.js";

// ROUGE-L (token LCS F1) — the exact metric the webcode-benchmark uses.
function rougeL(golden: string, extracted: string): number {
	const g = golden.split(/\s+/).filter(Boolean);
	const e = extracted.split(/\s+/).filter(Boolean);
	if (!g.length || !e.length) return 0;
	const m = g.length, n = e.length;
	let prev = new Array(n + 1).fill(0);
	for (let i = 1; i <= m; i++) {
		const curr = new Array(n + 1).fill(0);
		for (let j = 1; j <= n; j++) {
			curr[j] = g[i - 1] === e[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
		}
		prev = curr;
	}
	const lcs = prev[n];
	const p = lcs / n, r = lcs / m;
	return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

// A page with heavy chrome (nav/header/footer) wrapping a small main region —
// the worst case for whole-page conversion (chrome dwarfs the content).
const FIXTURE = `<!DOCTYPE html><html><head><title>Docs</title></head><body>
<nav>Home Products Pricing Documentation Blog Careers Sign in Sign up Search the entire site navigation menu here</nav>
<header>Acme Corporation banner advertisement subscribe to our newsletter today accept all cookies consent gdpr privacy</header>
<main>
<h1>Installing the Widget</h1>
<p>Run the install command to add the package. Then import it and call configure with your api key.</p>
<pre><code>npm install acme-widget</code></pre>
<p>The configure function accepts a timeout and a retry count for resilient requests.</p>
</main>
<footer>Terms of Service Privacy Policy Copyright 2026 Acme follow us on social media contact sales about careers press</footer>
</body></html>`;

// The clean source (what the golden would be) — main content only.
const GOLDEN = `Installing the Widget Run the install command to add the package. Then import it and call configure with your api key. npm install acme-widget The configure function accepts a timeout and a retry count for resilient requests.`;

describe("htmlToReadableMarkdown — strips chrome, keeps main content", () => {
	it("keeps the main content", async () => {
		const md = await htmlToReadableMarkdown(FIXTURE);
		expect(md).toContain("Installing the Widget");
		expect(md).toContain("npm install acme-widget");
		expect(md).toContain("configure");
	});

	it("drops the page chrome (nav, header banner, footer)", async () => {
		const md = await htmlToReadableMarkdown(FIXTURE);
		expect(md).not.toContain("navigation menu");
		expect(md).not.toContain("cookies consent");
		expect(md).not.toContain("follow us on social media");
		expect(md).not.toContain("Sign up");
	});

	it("raises ROUGE-L fidelity vs the whole-page conversion", async () => {
		const readable = await htmlToReadableMarkdown(FIXTURE);
		const plain = await htmlToPlainMarkdown(FIXTURE);
		const rReadable = rougeL(GOLDEN, readable);
		const rPlain = rougeL(GOLDEN, plain);
		// the whole page carries the chrome → lower precision → lower ROUGE-L
		expect(rPlain).toBeLessThan(rReadable);
		expect(rReadable).toBeGreaterThan(0.8); // clean main content is close to source
	});

	it("safe fallback: a chrome-less page is not degraded", async () => {
		const bare = `<html><body><article><h1>Title</h1><p>Just the content here, nothing else at all.</p></article></body></html>`;
		const md = await htmlToReadableMarkdown(bare);
		expect(md).toContain("Just the content here");
		expect(md).toContain("Title");
	});
});
