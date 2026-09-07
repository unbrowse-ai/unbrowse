// `server-only` is imported in the Next.js page that consumes this module,
// not here, so this file stays importable from bun:test and from Node-only
// build scripts. The renderer only does fs + micromark IO; there is no
// client-bundle risk if a worker accidentally imports it.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

/**
 * Renders a markdown doc from `unbrowse/docs/<SLUG>.md` to HTML at build time.
 *
 * The repo's `docs/` directory is the single source of truth for any page
 * that calls this. Edits to the markdown propagate on the next build.
 *
 * Notes:
 *   - micromark is already configured for the blog pipeline; GFM is enabled
 *     so tables, autolinks, strikethrough, and task lists Just Work.
 *   - micromark escapes raw HTML in the source by default (no rawHtml: true),
 *     which means `<script>` tags become text. That is the adversarial guard.
 *   - File reads happen synchronously at module load time. Next.js bundles
 *     the rendered HTML into the static page; no request-time IO.
 */
export interface LoadedDoc {
	html: string;
	source: string;
	found: boolean;
}

function resolveDocPath(slug: string): string {
	// Build runs from `frontend/`; the docs live one level up at `../docs/`.
	// `next.config.ts` already uses the same `resolve(process.cwd(), "..")`
	// pattern for the workspace root, so this stays in lockstep.
	const repoRoot = resolve(process.cwd(), "..");
	return resolve(repoRoot, "docs", `${slug}.md`);
}

export function loadDocMarkdown(slug: string): LoadedDoc {
	const docPath = resolveDocPath(slug);
	if (!existsSync(docPath)) {
		return { html: "", source: "", found: false };
	}
	const source = readFileSync(docPath, "utf8");
	const html = micromark(source, {
		extensions: [gfm()],
		htmlExtensions: [gfmHtml()],
	});
	return { html, source, found: true };
}
