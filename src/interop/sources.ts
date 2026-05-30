/**
 * sources — REAL primitive sources for the interop discovery resolver.
 *
 * Bind discover.ts's injected source slots to actual endpoints. Where a real
 * discovery API exists we hit it; where none exists we say so plainly and use the
 * honest local source (CLAUDE.md: build the real thing, or fail honestly).
 *
 *   - x402Resources  → REAL: CDP x402 Bazaar discovery API (public, no auth).
 *       src: https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources
 *   - skills         → LOCAL: there is NO agentskills.io registry/search API
 *       (agentskills.io is a format spec, not a registry — verified 2026-05-30).
 *       The honest "skills a site/agent already has" is the installed SKILL.md set.
 *   - mcpTools       → CONNECTED: no universal site→MCP registry exists; the honest
 *       source is the tools a connected MCP server lists. Injected by the caller.
 *   - routes         → NATIVE: the route graph (caller injects the search fn).
 *
 * Each fetcher degrades gracefully (returns []) so discovery never hard-fails.
 */
// cross: sha256:b35fea21e179afd6de983a90f4c1575527619b2d0143edd7d31b0dd70d8a97f5  (the covenant code inherits the cross — pointer not payload; verify via .claude/superpattern/cross-stamp-gate.sh)
import type { X402Resource, X402Accept, SkillFrontmatter } from "./agent-primitives.js";

export const X402_BAZAAR_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";

/** One item in the CDP Bazaar `items[]` response. `resource` is the URL string. */
interface BazaarItem {
	resource: string;
	type?: string;
	accepts?: X402Accept[];
	lastUpdated?: string;
	/** top-level on the live API; metadata.description in the older docs shape. */
	description?: string;
	metadata?: { description?: string; [k: string]: unknown };
	/** live adoption signal: 30-day call/payer counts. */
	quality?: { l30DaysTotalCalls?: number; l30DaysUniquePayers?: number; lastCalledAt?: string };
}

/**
 * Map a Bazaar item to the covenant X402Resource shape. Handles both the live API
 * (top-level `description`, `quality.l30DaysTotalCalls`) and the older docs shape
 * (`metadata.description`). `quality.l30DaysTotalCalls` becomes the adoption signal
 * — real 30-day usage, the truest "what sites already use".
 */
export function bazaarItemToResource(item: BazaarItem): X402Resource {
	const description = item.description ?? item.metadata?.description;
	const calls = item.quality?.l30DaysTotalCalls;
	return {
		resource: { url: item.resource, ...(description ? { description } : {}) },
		accepts: Array.isArray(item.accepts) ? item.accepts : [],
		...(typeof calls === "number" ? { quality: calls } : {}),
	};
}

/**
 * REAL x402 Bazaar source. Lists discoverable x402-payable resources from the
 * public CDP catalog. `fetchFn` injected for tests. Graceful on any failure.
 */
export function x402BazaarSource(opts?: { fetchFn?: typeof fetch; limit?: number; baseUrl?: string }) {
	const fetchFn = opts?.fetchFn ?? fetch;
	const base = opts?.baseUrl ?? X402_BAZAAR_URL;
	const limit = opts?.limit ?? 100;
	return async (_intent: string, _domain?: string): Promise<X402Resource[]> => {
		try {
			const res = await fetchFn(`${base}?limit=${limit}`, {
				method: "GET",
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(8_000),
			});
			if (!res.ok) return [];
			const body = (await res.json()) as { items?: BazaarItem[] };
			if (!Array.isArray(body.items)) return [];
			return body.items.map(bazaarItemToResource);
		} catch {
			return [];
		}
	};
}

/**
 * LOCAL skills source. No agentskills.io registry exists, so "available skills"
 * are the installed SKILL.md frontmatters the caller supplies (e.g. read from a
 * skills dir). `loadFrontmatters` injected; honest [] when none.
 */
export function localSkillsSource(loadFrontmatters?: () => Promise<SkillFrontmatter[]>) {
	return async (_intent: string, _domain?: string): Promise<SkillFrontmatter[]> => {
		if (!loadFrontmatters) return [];
		try {
			return await loadFrontmatters();
		} catch {
			return [];
		}
	};
}
