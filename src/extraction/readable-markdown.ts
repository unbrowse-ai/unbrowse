/**
 * readable-markdown — main-content extraction for `unbrowse fetch`.
 *
 * The default fetch path converts the WHOLE HTML body to markdown, which carries
 * page chrome (nav, sidebar, header, footer, cookie/consent banners) on top of
 * the real content. For extraction fidelity — a doc page's prose, a code file —
 * that chrome is noise: the exa webcode-benchmark micro-run (bench/exa/
 * micro_rouge.py) measured `unbrowse fetch` at ROUGE-L 0.74 vs the clean source
 * because the extracted markdown ran ~50% longer than the golden, diluting
 * precision.
 *
 * `cleanDOM` (src/extraction/index.ts) already strips chrome + ads + hidden
 * elements and isolates the main content region (main / article / [role=main] /
 * #content / .content, falling back to <body>), but it was only wired into the
 * structured-extraction path, never into fetch. This applies it before turndown,
 * so a caller that wants clean main content (the `--main` fetch flag, the bench
 * adapter) gets it. The default fetch path is unchanged — opt-in only.
 */
import { cleanDOM } from "./index.js";

async function turndownService() {
	const TurndownService = (await import("turndown")).default;
	const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
	td.remove(["script", "style", "noscript", "iframe", "svg", "link", "meta"]);
	return td;
}

function stripPreamble(html: string): string {
	return html
		.replace(/<!DOCTYPE[^>]*>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<script[^>]*?>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*?>[\s\S]*?<\/style>/gi, "");
}

/** Whole-page HTML → markdown (the current default fetch behaviour; chrome and
 *  all). Kept here so the readable path has a like-for-like comparison point. */
export async function htmlToPlainMarkdown(html: string): Promise<string> {
	const td = await turndownService();
	return td.turndown(stripPreamble(html)).replace(/\n{3,}/g, "\n\n").trim();
}

/** Main-content HTML → markdown: cleanDOM strips the chrome and isolates the
 *  main region, THEN turndown converts — higher extraction fidelity than the
 *  whole page. Safe fallback: cleanDOM keeps <body> when no main region exists,
 *  so a chrome-less page loses nothing. */
export async function htmlToReadableMarkdown(html: string): Promise<string> {
	const td = await turndownService();
	let cleaned: string;
	try {
		cleaned = cleanDOM(html);
	} catch {
		cleaned = stripPreamble(html); // never fail closed — fall back to whole page
	}
	return td.turndown(cleaned).replace(/\n{3,}/g, "\n\n").trim();
}
