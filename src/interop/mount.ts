/**
 * mount — bind the interop discovery resolver to REAL sources and gate it.
 *
 * discover.ts is dep-injected; this binds the live sources (x402 Bazaar API +
 * installed skills) and exposes one call for resolve to make. OPT-IN via
 * UNBROWSE_INTEROP_DISCOVERY=1 — the Bazaar fetch is a network call, so the
 * default resolve path takes ZERO added latency (the gate short-circuits to []
 * before any fetch). Native route candidates are passed IN by resolve (it already
 * has them) rather than re-fetched, then ranked together with the external ones.
 */
import { discoverPrimitives, type PrimitiveSources } from "./discover.js";
import { x402BazaarSource, localSkillsSource, llmsTxtSource, openApiSource, a2aSource } from "./sources.js";
import { prioritize, type AgentPrimitive, type SkillFrontmatter } from "./agent-primitives.js";

export interface InteropMountOpts {
	/** installed SKILL.md frontmatters (no agentskills.io registry exists). */
	loadSkills?: () => Promise<SkillFrontmatter[]>;
	/** connected MCP servers' tool lists (no universal site→MCP registry exists). */
	mcpTools?: PrimitiveSources["mcpTools"];
	/** native route candidates resolve already computed — ranked, not re-fetched. */
	nativeRoutes?: AgentPrimitive[];
	fetchFn?: typeof fetch;
}

/** Bind the real, available sources. */
export function liveSources(opts?: InteropMountOpts): PrimitiveSources {
	const ff = opts?.fetchFn ? { fetchFn: opts.fetchFn } : undefined;
	return {
		x402Resources: x402BazaarSource(ff),
		skills: localSkillsSource(opts?.loadSkills),
		mcpTools: opts?.mcpTools,
		// the standards a site publishes at its own well-known locations (per-domain):
		openApiOps: openApiSource(ff),
		llmsTxtLinks: llmsTxtSource(ff),
		a2aPrimitives: a2aSource(ff),
		routes: opts?.nativeRoutes ? async () => opts.nativeRoutes! : undefined,
	};
}

/**
 * Discover + prioritize the primitives a site already uses across every ecosystem.
 * Returns [] (no network) unless UNBROWSE_INTEROP_DISCOVERY=1. Never throws.
 */
export async function discoverSitePrimitives(
	intent: string,
	domain: string | undefined,
	opts?: InteropMountOpts,
): Promise<AgentPrimitive[]> {
	if (process.env.UNBROWSE_INTEROP_DISCOVERY !== "1") {
		// flag off: still rank any native routes resolve already handed us, but make
		// no network call — zero added latency on the default path.
		return opts?.nativeRoutes ? prioritize(opts.nativeRoutes) : [];
	}
	try {
		return await discoverPrimitives(intent, domain, liveSources(opts));
	} catch {
		return opts?.nativeRoutes ? prioritize(opts.nativeRoutes) : [];
	}
}
