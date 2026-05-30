/**
 * discover — resolve an intent across every primitive ecosystem a site already
 * uses, then rank by what it has already adopted.
 *
 * The drop-in promise is bidirectional: we serve our routes AS whatever a site
 * speaks (agent-primitives.serveAs), and we INGEST what the site already exposes
 * — its Agent Skills, its MCP tools, its x402 Bazaar resources — into the one
 * covenant shape and prioritize them over our own wrapper. So when a site already
 * monetizes an x402 resource or runs an MCP tool for an intent, the agent is
 * pointed at THAT, not at a redundant re-wrap (1 Cor 9:22; the rational-adoption
 * inequality of arXiv:2604.00694 — use what costs least to reach).
 *
 * Sources are INJECTED (each optional), so this is pure + testable with stubs and
 * the real fetchers (agentskills.io registry, an MCP server probe, the x402 Bazaar
 * list, the native route graph) are wired at the mount.
 */
// cross: sha256:b35fea21e179afd6de983a90f4c1575527619b2d0143edd7d31b0dd70d8a97f5  (the covenant code inherits the cross — pointer not payload; verify via .claude/superpattern/cross-stamp-gate.sh)
import {
	ingest,
	prioritize,
	type AgentPrimitive,
	type SkillFrontmatter,
	type McpTool,
	type X402Resource,
	type OpenApiOperation,
	type LlmsTxtLink,
} from "./agent-primitives.js";

/** Each source is optional; a missing or throwing source contributes nothing. */
export interface PrimitiveSources {
	skills?: (intent: string, domain?: string) => Promise<SkillFrontmatter[]>;
	mcpTools?: (intent: string, domain?: string) => Promise<McpTool[]>;
	x402Resources?: (intent: string, domain?: string) => Promise<X402Resource[]>;
	openApiOps?: (intent: string, domain?: string) => Promise<OpenApiOperation[]>;
	llmsTxtLinks?: (intent: string, domain?: string) => Promise<LlmsTxtLink[]>;
	/** A2A is pre-fanned (card → one primitive per skill). */
	a2aPrimitives?: (intent: string, domain?: string) => Promise<AgentPrimitive[]>;
	/** native route graph — already covenant-shaped. */
	routes?: (intent: string, domain?: string) => Promise<AgentPrimitive[]>;
}

async function safe<T>(fn: (() => Promise<T[]>) | undefined): Promise<T[]> {
	if (!fn) return [];
	try {
		return await fn();
	} catch {
		return []; // a degraded source never fails discovery — it just contributes nothing
	}
}

/**
 * Query every available source in parallel, ingest each result into the universal
 * AgentPrimitive, merge, and return ranked by adoption (highest first). Never
 * throws — a missing/failing ecosystem simply drops out of the ranking.
 */
export async function discoverPrimitives(
	intent: string,
	domain: string | undefined,
	sources: PrimitiveSources,
): Promise<AgentPrimitive[]> {
	const [skills, mcpTools, x402Resources, openApiOps, llmsTxtLinks, a2aPrimitives, routes] = await Promise.all([
		safe(sources.skills ? () => sources.skills!(intent, domain) : undefined),
		safe(sources.mcpTools ? () => sources.mcpTools!(intent, domain) : undefined),
		safe(sources.x402Resources ? () => sources.x402Resources!(intent, domain) : undefined),
		safe(sources.openApiOps ? () => sources.openApiOps!(intent, domain) : undefined),
		safe(sources.llmsTxtLinks ? () => sources.llmsTxtLinks!(intent, domain) : undefined),
		safe(sources.a2aPrimitives ? () => sources.a2aPrimitives!(intent, domain) : undefined),
		safe(sources.routes ? () => sources.routes!(intent, domain) : undefined),
	]);

	const merged: AgentPrimitive[] = [
		...skills.map((s) => ingest(s, "skill", { who: domain })),
		...mcpTools.map((t) => ingest(t, "mcp_tool", { who: domain })),
		...x402Resources.map((r) => ingest(r, "x402_resource")),
		...openApiOps.map((o) => ingest(o, "openapi", { who: domain })),
		...llmsTxtLinks.map((l) => ingest(l, "llms_txt", { who: domain })),
		...a2aPrimitives, // already covenant-shaped (card fanned to skills)
		...routes.map((r) => ingest(r, "route")),
	];

	return prioritize(merged);
}
