/**
 * Covenant-mapping coverage gate.
 *
 * Enforces project rule `unbrowse-follows-covenant-shape` (covenant receipt
 * sha256:8d6eb822…): every MCP tool declared in `src/mcp.ts` MUST have a
 * matching entry in `src/covenant-mapping.ts:COVENANT_MAP`, and there must be
 * no orphan mapping entries pointing at tools that don't exist.
 *
 * Reading: this is C-G14 in action ("record the rule in the same change") —
 * the rule was declared in covenant; this test is its mechanical witness.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COVENANT_MAP } from "../src/covenant-mapping.js";

function extractMcpToolNames(): string[] {
	const src = readFileSync(resolve(__dirname, "..", "src/mcp.ts"), "utf8");
	// Tool registration sites declare `name: "unbrowse_<verb>"` immediately
	// followed by `description:` on a nearby line. Match the property-form.
	const re = /\bname:\s*"(unbrowse_[a-z_]+)"\s*,\s*\n\s*description:/g;
	const names = new Set<string>();
	for (const m of src.matchAll(re)) names.add(m[1]);
	return [...names].sort();
}

describe("covenant-mapping coverage", () => {
	const declared = extractMcpToolNames();

	it("extracts a non-empty list of MCP tools", () => {
		expect(declared.length).toBeGreaterThan(20);
	});

	it("every MCP tool has a COVENANT_MAP entry", () => {
		const missing = declared.filter((n) => !COVENANT_MAP[n]);
		expect(missing).toEqual([]);
	});

	it("no orphan COVENANT_MAP entry without a real MCP tool", () => {
		const declaredSet = new Set(declared);
		const orphans = Object.keys(COVENANT_MAP).filter((n) => !declaredSet.has(n));
		expect(orphans).toEqual([]);
	});

	it("every entry carries verb + day + witness + essence", () => {
		for (const [name, shape] of Object.entries(COVENANT_MAP)) {
			expect(["build", "breath", "eval"]).toContain(shape.verb);
			expect(shape.day).toBeGreaterThanOrEqual(1);
			expect(shape.day).toBeLessThanOrEqual(7);
			expect(shape.witness).toMatch(/[A-Za-z]+\s+\d+:\d+/);
			expect(shape.essence.length).toBeGreaterThan(5);
			expect(shape.name).toBe(name);
		}
	});
});
