/**
 * Verifies `/how-unbrowse-pays` renders from `docs/HOW_UNBROWSE_PAYS.md` as
 * the single source of truth. The test invokes `loadDocMarkdown` (the same
 * call the page makes at build time) and asserts the rendered HTML.
 *
 * The renderer resolves docs at `<repoRoot>/docs/<slug>.md` from CWD; the
 * test mirrors that by deriving the repo root from import.meta.url so the
 * test is cwd-independent (works from both /unbrowse and /unbrowse/frontend).
 */
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDocMarkdown } from "../src/lib/docs-renderer";

// This test file lives at <repo>/frontend/tests/. Repo root = three levels up.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..", "..");
const DOC_PATH = resolve(REPO_ROOT, "docs", "HOW_UNBROWSE_PAYS.md");

// Ensure the renderer sees the same repo root. docs-renderer.ts uses
// process.cwd()/.. so set cwd to frontend/ for the duration of the
// tests. This is brittle but the renderer's resolution rule is fixed
// and is the deployed contract (next.config.ts resolves workspaceRoot
// the same way).
const FRONTEND_DIR = resolve(REPO_ROOT, "frontend");
const _prevCwd = process.cwd();
if (_prevCwd !== FRONTEND_DIR) process.chdir(FRONTEND_DIR);

describe("how-unbrowse-pays markdown rendering", () => {
	test("doc exists on disk (production deploy guarantee)", () => {
		expect(existsSync(DOC_PATH)).toBe(true);
	});

	test("loadDocMarkdown returns rendered HTML for the live doc", () => {
		const doc = loadDocMarkdown("HOW_UNBROWSE_PAYS");
		expect(doc.found).toBe(true);
		expect(doc.html.length).toBeGreaterThan(500);
		expect(doc.source.length).toBeGreaterThan(500);
	});

	test("canonical Step 3 phrases survive rendering", () => {
		const { html } = loadDocMarkdown("HOW_UNBROWSE_PAYS");
		// Phrases the validator stamped as required in the markdown source.
		expect(html).toContain("50%");
		expect(html).toContain("OWNER_BPS = 2000");
		expect(html).toContain("lobster.cash");
		expect(html).toContain("50/30/20");
	});

	test("page injects its own H1; markdown source has none", () => {
		const source = readFileSync(DOC_PATH, "utf8");
		// Markdown source MUST omit H1 per Step 3 convention (page injects it).
		const lines = source.split("\n");
		const h1Lines = lines.filter((line) => /^#\s/.test(line));
		expect(h1Lines).toEqual([]);
		// The visible H1 lives in page.tsx; verify it's there.
		const pageSrc = readFileSync(
			resolve(REPO_ROOT, "frontend/src/app/how-unbrowse-pays/page.tsx"),
			"utf8",
		);
		expect(pageSrc).toContain("How Unbrowse Pays");
	});

	test("rendered HTML contains no em dashes (style rule)", () => {
		const { html } = loadDocMarkdown("HOW_UNBROWSE_PAYS");
		expect(html.includes("—")).toBe(false);
	});

	test("citation strings render as inline code, not auto-linked", () => {
		const { html } = loadDocMarkdown("HOW_UNBROWSE_PAYS");
		// The doc contains backtick-wrapped file:line citations like
		// `backend/src/services/flex.ts:39`. Micromark should emit <code>.
		expect(html).toContain("<code>");
		expect(html).toMatch(/<code>backend\/src\/services\/flex\.ts:39<\/code>/);
	});

	test("renderer returns found:false for an unknown slug", () => {
		const doc = loadDocMarkdown("NOPE_DOES_NOT_EXIST_404");
		expect(doc.found).toBe(false);
		expect(doc.html).toBe("");
	});
});

describe("docs-renderer single-source-of-truth contract", () => {
	// Edit-the-doc-and-watch-the-page-change proof. Uses a temp docs/ slug
	// to avoid mutating the real file, by creating + cleaning up a sibling
	// markdown file in the same docs directory the renderer reads.
	const TEMP_SLUG = `__SSOT_TEMP_${process.pid}`;
	const TEMP_PATH = resolve(REPO_ROOT, "docs", `${TEMP_SLUG}.md`);

	afterAll(() => {
		if (existsSync(TEMP_PATH)) rmSync(TEMP_PATH);
	});

	test("changing the markdown changes the rendered HTML", () => {
		writeFileSync(TEMP_PATH, "## Hello\n\nfirst version\n");
		const v1 = loadDocMarkdown(TEMP_SLUG);
		expect(v1.html).toContain("first version");

		writeFileSync(TEMP_PATH, "## Hello\n\nsecond version\n");
		const v2 = loadDocMarkdown(TEMP_SLUG);
		expect(v2.html).toContain("second version");
		expect(v2.html).not.toContain("first version");
	});

	test("inline raw HTML is escaped (adversarial XSS guard)", () => {
		writeFileSync(
			TEMP_PATH,
			"## Heading\n\nhello <script>alert(1)</script> world\n",
		);
		const { html } = loadDocMarkdown(TEMP_SLUG);
		// micromark default: raw HTML in markdown source is escaped to text.
		expect(html.includes("<script>alert(1)</script>")).toBe(false);
		// The literal text should still appear, just as escaped entities.
		expect(html).toMatch(/&lt;script&gt;|&#x3C;script/);
	});
});
