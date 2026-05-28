/**
 * Covenant-shape mapping for every unbrowse tool surface.
 *
 * Project rule `unbrowse-follows-covenant-shape` (declared 2026-05-27,
 * receipt sha256:8d6eb822…): every callable verb in unbrowse mechanically
 * conforms to the /covenant KindSpec shape — verb-class (build/breath/eval),
 * Genesis day ordinal, scripture witness.
 *
 * This module is the canonical mapping. Downstream emitters:
 *   - `src/mcp.ts` already declares OpenAI-compat tool schemas; this module
 *     ATTACHES covenant fields to them via `name` lookup.
 *   - A future `src/openai-tools.ts` will generate the schemas-only export
 *     for direct-LLM clients (BrowseComp runner, agent SDKs) so they consume
 *     the same root surface.
 *   - A future bridge into `~/Projects/covenant/kinds.ts` will project each
 *     unbrowse verb as a KindSpec, so any LLM dispatching covenant kinds
 *     can reach the unbrowse surface via the substrate.
 *
 * Composes with rules:
 *   - skip-to-root-of-tree-on-format-mismatch (sha256:7a31d6af…) — schemas
 *     are the root; per-format vendor adapters are leaves.
 *   - prefer-unbrowse-binary-over-llm (memo `prefer-unbrowse-binary-over-llm`)
 *     — when a covenant kind needs structured web data, prefer the unbrowse
 *     binary (this mapping describes which kind binds which verb).
 *   - pointer-not-payload-client (contract 3c2dd353) — emitters return
 *     name+shape pointers, never inlined runtime payloads.
 *
 * Witness Gen 1:12 — *after their kind*. Each tool seeds a KindSpec entry of
 * its own kind; the same shape descends to every adapter.
 */

export type CovenantVerb = "build" | "breath" | "eval";
export type GenesisDay = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface CovenantShape {
	/** Tool name as declared in `src/mcp.ts`. */
	name: string;
	/** Build / Breath / Eval — the three-verb river (Father / Spirit / Son). */
	verb: CovenantVerb;
	/** Day 1..7 of the Genesis-days cadence. */
	day: GenesisDay;
	/** Scripture verse anchoring the act. */
	witness: string;
	/** One-line summary of what the act IS (not what it does mechanically). */
	essence: string;
}

/**
 * Authoritative mapping. Adding a new MCP tool MUST also add an entry here
 * (covered by `tests/covenant-mapping-coverage.test.ts`).
 *
 * Verb conventions used below:
 *   - **build** (day 1) — pattern is declared, content is committed: publish,
 *     publish_suggestions, annotate, feedback, reflect, close (commits the
 *     session's capture to the marketplace), submit (commits form).
 *   - **breath** (days 2–6) — runtime animation, web actuation, capture:
 *     resolve, execute, fetch, run, go, snap, eval, click, fill, press, type,
 *     scroll, select, screenshot, markdown, search_endpoints, auth_capture,
 *     sync, diagnose, validate, trace, type_audit, text, test_crash.
 *   - **eval** (day 7) — read-only query against existing state: health,
 *     stats, skills, skill, sessions, cookies, settings, index, earnings,
 *     review.
 */
export const COVENANT_MAP: Record<string, CovenantShape> = {
	// ─── eval (day 7 — witness what is) ──────────────────────────────────────
	unbrowse_health: {
		name: "unbrowse_health",
		verb: "eval",
		day: 7,
		witness: "Psalm 139:14",
		essence: "report the runtime's living state",
	},
	unbrowse_stats: {
		name: "unbrowse_stats",
		verb: "eval",
		day: 7,
		witness: "Numbers 1:2",
		essence: "take a census of the marketplace",
	},
	unbrowse_skills: {
		name: "unbrowse_skills",
		verb: "eval",
		day: 7,
		witness: "Revelation 20:12",
		essence: "open the book and read what is written",
	},
	unbrowse_skill: {
		name: "unbrowse_skill",
		verb: "eval",
		day: 7,
		witness: "Revelation 20:12",
		essence: "open one entry from the book",
	},
	unbrowse_sessions: {
		name: "unbrowse_sessions",
		verb: "eval",
		day: 7,
		witness: "Psalm 90:12",
		essence: "number our days — list current capture sessions",
	},
	unbrowse_cookies: {
		name: "unbrowse_cookies",
		verb: "eval",
		day: 7,
		witness: "1 Corinthians 13:12",
		essence: "see through the glass — read the auth state",
	},
	unbrowse_settings: {
		name: "unbrowse_settings",
		verb: "eval",
		day: 7,
		witness: "Deuteronomy 8:2",
		essence: "remember the configured way",
	},
	unbrowse_index: {
		name: "unbrowse_index",
		verb: "eval",
		day: 7,
		witness: "Revelation 20:12",
		essence: "the ledger of indexed domains",
	},
	unbrowse_auth_inventory: {
		name: "unbrowse_auth_inventory",
		verb: "eval",
		day: 7,
		witness: "Luke 16:2",
		essence: "give an account of the stewardship — inventory captured auth",
	},
	unbrowse_spec: {
		name: "unbrowse_spec",
		verb: "eval",
		day: 7,
		witness: "Exodus 25:9",
		essence: "show the pattern — the endpoint blueprint to read",
	},
	unbrowse_earnings: {
		name: "unbrowse_earnings",
		verb: "eval",
		day: 7,
		witness: "Matthew 25:23",
		essence: "render the indexer's wage faithfully",
	},
	unbrowse_review: {
		name: "unbrowse_review",
		verb: "eval",
		day: 7,
		witness: "Genesis 1:31",
		essence: "look at what was made and judge it",
	},

	// ─── breath (days 2–6 — runtime animation, web actuation) ────────────────
	unbrowse_resolve: {
		name: "unbrowse_resolve",
		verb: "breath",
		day: 6,
		witness: "Proverbs 25:2",
		essence: "search out the matter — return a ranked shortlist for an intent",
	},
	unbrowse_execute: {
		name: "unbrowse_execute",
		verb: "breath",
		day: 6,
		witness: "James 1:22",
		essence: "be a doer, not only a hearer — call the chosen endpoint",
	},
	unbrowse_fetch: {
		name: "unbrowse_fetch",
		verb: "breath",
		day: 6,
		witness: "Genesis 24:11",
		essence: "draw water from the well — pull raw contents at a URL",
	},
	unbrowse_run: {
		name: "unbrowse_run",
		verb: "breath",
		day: 6,
		witness: "1 Corinthians 9:24",
		essence: "run that you may obtain — execute the highest-confidence path end-to-end",
	},
	unbrowse_go: {
		name: "unbrowse_go",
		verb: "breath",
		day: 5,
		witness: "Genesis 12:1",
		essence: "go to the land — navigate the browser to a URL",
	},
	unbrowse_snap: {
		name: "unbrowse_snap",
		verb: "breath",
		day: 5,
		witness: "Habakkuk 2:2",
		essence: "write the vision — produce an a11y snapshot of the page",
	},
	unbrowse_eval: {
		name: "unbrowse_eval",
		verb: "breath",
		day: 5,
		witness: "Acts 17:11",
		essence: "examine — run JS in the page and read what came back",
	},
	unbrowse_click: {
		name: "unbrowse_click",
		verb: "breath",
		day: 5,
		witness: "Matthew 7:7",
		essence: "knock — actuate a control",
	},
	unbrowse_fill: {
		name: "unbrowse_fill",
		verb: "breath",
		day: 5,
		witness: "John 2:7",
		essence: "fill the jars to the brim — populate a form field",
	},
	unbrowse_press: {
		name: "unbrowse_press",
		verb: "breath",
		day: 5,
		witness: "Matthew 11:12",
		essence: "the kingdom is taken by force — send a keystroke",
	},
	unbrowse_type: {
		name: "unbrowse_type",
		verb: "breath",
		day: 5,
		witness: "Jeremiah 30:2",
		essence: "write — type a string into a field",
	},
	unbrowse_scroll: {
		name: "unbrowse_scroll",
		verb: "breath",
		day: 5,
		witness: "Revelation 6:14",
		essence: "the heavens departed as a scroll",
	},
	unbrowse_select: {
		name: "unbrowse_select",
		verb: "breath",
		day: 5,
		witness: "Deuteronomy 30:19",
		essence: "choose — pick an option from a select",
	},
	unbrowse_screenshot: {
		name: "unbrowse_screenshot",
		verb: "breath",
		day: 5,
		witness: "Habakkuk 2:2",
		essence: "make the vision plain — capture a PNG",
	},
	unbrowse_markdown: {
		name: "unbrowse_markdown",
		verb: "breath",
		day: 5,
		witness: "Matthew 4:4",
		essence: "render the page as words — convert DOM to markdown",
	},
	unbrowse_search_endpoints: {
		name: "unbrowse_search_endpoints",
		verb: "breath",
		day: 6,
		witness: "Proverbs 2:4",
		essence: "search for it as hidden treasure — query the marketplace",
	},
	unbrowse_auth_capture: {
		name: "unbrowse_auth_capture",
		verb: "breath",
		day: 5,
		witness: "Exodus 19:9",
		essence: "the people will hear — capture and store auth credentials",
	},
	unbrowse_sync: {
		name: "unbrowse_sync",
		verb: "breath",
		day: 5,
		witness: "Acts 4:32",
		essence: "of one heart — synchronize captured state with the marketplace",
	},
	unbrowse_diagnose: {
		name: "unbrowse_diagnose",
		verb: "breath",
		day: 6,
		witness: "Luke 4:23",
		essence: "physician, diagnose thyself — explain why a route failed",
	},
	unbrowse_validate: {
		name: "unbrowse_validate",
		verb: "breath",
		day: 6,
		witness: "1 Thessalonians 5:21",
		essence: "test everything — verify an endpoint still works",
	},
	unbrowse_trace: {
		name: "unbrowse_trace",
		verb: "breath",
		day: 6,
		witness: "Job 38:11",
		essence: "to here, no further — emit the per-call decision trace",
	},
	unbrowse_type_audit: {
		name: "unbrowse_type_audit",
		verb: "breath",
		day: 6,
		witness: "Malachi 3:3",
		essence: "refiner's fire — audit the type-shape of a response",
	},
	unbrowse_text: {
		name: "unbrowse_text",
		verb: "breath",
		day: 5,
		witness: "John 1:14",
		essence: "the word made visible — read text of an element",
	},
	unbrowse_test_crash: {
		name: "unbrowse_test_crash",
		verb: "breath",
		day: 6,
		witness: "1 Peter 5:8",
		essence: "be sober, be vigilant — deliberately crash the runtime for testing",
	},

	// ─── build (day 1 — declare / commit / record) ───────────────────────────
	unbrowse_publish: {
		name: "unbrowse_publish",
		verb: "build",
		day: 1,
		witness: "Acts 1:8",
		essence: "publish to the ends of the earth — push a captured skill to marketplace",
	},
	unbrowse_publish_suggestions: {
		name: "unbrowse_publish_suggestions",
		verb: "build",
		day: 1,
		witness: "Proverbs 11:14",
		essence: "in a multitude of counselors there is safety — surface publish targets",
	},
	unbrowse_annotate: {
		name: "unbrowse_annotate",
		verb: "build",
		day: 1,
		witness: "Numbers 33:2",
		essence: "Moses wrote their goings out — attach metadata to a skill/endpoint",
	},
	unbrowse_feedback: {
		name: "unbrowse_feedback",
		verb: "build",
		day: 1,
		witness: "Proverbs 27:17",
		essence: "iron sharpens iron — record an outcome rating against an endpoint",
	},
	unbrowse_reflect: {
		name: "unbrowse_reflect",
		verb: "build",
		day: 1,
		witness: "James 1:23",
		essence: "look into the mirror — record outcome of a user-facing goal",
	},
	unbrowse_close: {
		name: "unbrowse_close",
		verb: "build",
		day: 1,
		witness: "Genesis 2:2",
		essence: "rest from the work — commit a browse session to the marketplace",
	},
	unbrowse_submit: {
		name: "unbrowse_submit",
		verb: "build",
		day: 1,
		witness: "James 4:7",
		essence: "submit — fire a form's submit handler",
	},
};

// Konmari: covenantShape / covenantToolNames / ProjectedKindSpec / projectKindSpec
// / allProjectedKindSpecs were future-bridge scaffolding with zero callers (each
// verified by grep before removal) — let go. COVENANT_MAP (read via
// COVENANT_MAP[name] or Object.keys) is the one load-bearing surface; its
// consumer is src/covenant-seed.ts.
