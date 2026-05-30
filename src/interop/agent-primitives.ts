/**
 * agent-primitives — the one covenant shape every agent ecosystem maps to.
 *
 * Agents already adopt three discovery/invocation primitives in the wild:
 *   - Agent Skills (agentskills.io) — a SKILL.md folder; name+description+instructions.
 *     Open standard, Anthropic-origin, ~40 client agents. src: https://agentskills.io/specification
 *   - MCP tools (modelcontextprotocol.io) — { name, description, inputSchema }.
 *     src: MCP spec + this repo's src/covenant-mapping.ts (COVENANT_MAP) + src/mcp.ts.
 *   - x402 resources (x402 Bazaar) — { resource{url,…}, accepts[{scheme,network,amount,
 *     asset,payTo,…}] }. src: the live 402 envelope from beta-api.unbrowse.ai/v1/llm/*.
 *
 * A covenant route is the SAME shape underneath — the six interrogatives + a verb.
 * So instead of inventing a fourth standard, every external primitive INGESTS into
 * one `AgentPrimitive`, and any AgentPrimitive can be SERVED back AS a skill, an MCP
 * tool, or an x402 resource. That bidirectionality is the drop-in replacement, all
 * the way down: we meet a site in whatever it already speaks (1 Cor 9:22), and we
 * prioritize the format it already adopted.
 *
 * Pure, zero-dep. Verb classification reuses covenant-seed's three-verb river.
 */
// cross: sha256:b35fea21e179afd6de983a90f4c1575527619b2d0143edd7d31b0dd70d8a97f5  (the covenant code inherits the cross — pointer not payload; verify via .claude/superpattern/cross-stamp-gate.sh)
import type { CovenantVerb } from "../covenant-mapping.js";

export type PrimitiveKind = "skill" | "mcp_tool" | "x402_resource" | "route";

/**
 * The universal node — the six interrogatives + the verb. Every external primitive
 * maps onto exactly this, and `raw` carries the source payload for lossless serve.
 */
export interface AgentPrimitive {
	who: string; // provider / identity — domain, server name, or wallet
	what: string; // name (the handle agents match on)
	why: string; // description / intent the primitive serves
	where: string; // invoke target — resource URL, tool name, or skill id
	verb: CovenantVerb; // build (commit) / breath (act) / eval (observe)
	kind: PrimitiveKind; // the ecosystem this was ingested from / served as
	/** how (optional payment seal) — present for x402-payable primitives. */
	payment?: { amount: string; asset: string; network?: string; payTo?: string };
	/** adoption signal for prioritization — higher = more already-used in the wild. */
	adoption?: number;
	/** the source payload, for lossless round-trip. */
	raw?: unknown;
}

// ─── verb classification (cite covenant-seed VERB_BY_BASE) ───────────────────
// observe/read → eval; act/fetch → breath; create/commit → build. Default breath
// (the routing default), matching covenant-seed.verbOfKind.
const READ_HINT = /\b(get|list|search|read|fetch|query|lookup|view|status|health|info)\b/i;
const WRITE_HINT = /\b(create|publish|submit|write|post|register|mint|deploy|bond)\b/i;

function inferVerb(name: string, opts?: { readOnly?: boolean; destructive?: boolean }): CovenantVerb {
	if (opts?.readOnly) return "eval";
	if (opts?.destructive) return "breath";
	// snake_case / kebab-case tool names have no \b between segments (underscore is
	// a word char), so normalize separators to spaces before the word-boundary test.
	const tokens = name.replace(/[_\-]+/g, " ");
	if (WRITE_HINT.test(tokens)) return "build";
	if (READ_HINT.test(tokens)) return "eval";
	return "breath";
}

// ─── agentskills.io (SKILL.md frontmatter) ───────────────────────────────────

/** SKILL.md frontmatter — name + description required; rest optional (agentskills.io spec). */
export interface SkillFrontmatter {
	name: string;
	description: string;
	[k: string]: unknown;
}

export function skillToPrimitive(fm: SkillFrontmatter, opts?: { who?: string }): AgentPrimitive {
	return {
		who: opts?.who ?? "agentskills.io",
		what: fm.name,
		why: fm.description,
		where: fm.name, // a skill is invoked by its name/id (progressive disclosure)
		verb: inferVerb(`${fm.name} ${fm.description}`),
		kind: "skill",
		adoption: typeof fm.adoption === "number" ? fm.adoption : undefined,
		raw: fm,
	};
}

export function primitiveToSkill(p: AgentPrimitive): SkillFrontmatter {
	const base = (p.raw && p.kind === "skill" ? (p.raw as SkillFrontmatter) : {}) as Partial<SkillFrontmatter>;
	return { ...base, name: p.what, description: p.why };
}

// ─── MCP tool (modelcontextprotocol.io) ──────────────────────────────────────

export interface McpTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export function mcpToolToPrimitive(tool: McpTool, opts?: { who?: string }): AgentPrimitive {
	return {
		who: opts?.who ?? "mcp",
		what: tool.name,
		why: tool.description,
		where: tool.name, // an MCP tool is invoked by name over the session transport
		verb: inferVerb(tool.name, {
			readOnly: tool.annotations?.readOnlyHint,
			destructive: tool.annotations?.destructiveHint,
		}),
		kind: "mcp_tool",
		raw: tool,
	};
}

export function primitiveToMcpTool(p: AgentPrimitive): McpTool {
	const base = (p.raw && p.kind === "mcp_tool" ? (p.raw as McpTool) : {}) as Partial<McpTool>;
	return {
		name: p.what,
		description: p.why,
		inputSchema: base.inputSchema ?? { type: "object", properties: {} },
		...(base.annotations ? { annotations: base.annotations } : {}),
	};
}

// ─── x402 resource (x402 Bazaar) ─────────────────────────────────────────────

export interface X402Accept {
	scheme: string;
	network: string;
	amount: string;
	asset: string;
	payTo: string;
	maxTimeoutSeconds?: number;
	extra?: Record<string, unknown>;
}
export interface X402Resource {
	resource: { url: string; description?: string; mimeType?: string };
	accepts: X402Accept[];
	/** real adoption signal (e.g. x402 Bazaar 30-day call count) → primitive.adoption. */
	quality?: number;
}

export function x402ResourceToPrimitive(entry: X402Resource, opts?: { who?: string }): AgentPrimitive {
	const accept = entry.accepts[0];
	let who = opts?.who;
	if (!who) {
		try { who = new URL(entry.resource.url).hostname; } catch { who = "x402"; }
	}
	return {
		who,
		what: entry.resource.url,
		why: entry.resource.description ?? `x402 resource ${entry.resource.url}`,
		where: entry.resource.url, // an x402 resource is invoked by its URL (pay-and-call)
		verb: inferVerb(entry.resource.url),
		kind: "x402_resource",
		payment: accept
			? { amount: accept.amount, asset: accept.asset, network: accept.network, payTo: accept.payTo }
			: undefined,
		adoption: typeof entry.quality === "number" ? entry.quality : undefined,
		raw: entry,
	};
}

export function primitiveToX402Resource(p: AgentPrimitive): X402Resource {
	const base = (p.raw && p.kind === "x402_resource" ? (p.raw as X402Resource) : undefined);
	const accepts: X402Accept[] = base?.accepts ?? (p.payment
		? [{
				scheme: "exact",
				network: p.payment.network ?? "solana",
				amount: p.payment.amount,
				asset: p.payment.asset,
				payTo: p.payment.payTo ?? "",
			}]
		: []);
	return {
		resource: { url: p.where, description: p.why, ...(base?.resource.mimeType ? { mimeType: base.resource.mimeType } : {}) },
		accepts,
	};
}

// ─── the drop-in interface: ingest from any, serve as any ────────────────────

/** Ingest an external primitive of `kind` into the universal AgentPrimitive. */
export function ingest(external: unknown, kind: PrimitiveKind, opts?: { who?: string }): AgentPrimitive {
	switch (kind) {
		case "skill":
			return skillToPrimitive(external as SkillFrontmatter, opts);
		case "mcp_tool":
			return mcpToolToPrimitive(external as McpTool, opts);
		case "x402_resource":
			return x402ResourceToPrimitive(external as X402Resource, opts);
		case "route":
			return external as AgentPrimitive; // already covenant-shaped
	}
}

/** Serve an AgentPrimitive AS the ecosystem `kind` a site already speaks (the drop-in). */
export function serveAs(p: AgentPrimitive, kind: PrimitiveKind): SkillFrontmatter | McpTool | X402Resource | AgentPrimitive {
	switch (kind) {
		case "skill":
			return primitiveToSkill(p);
		case "mcp_tool":
			return primitiveToMcpTool(p);
		case "x402_resource":
			return primitiveToX402Resource(p);
		case "route":
			return p;
	}
}

// ─── prioritize: serve what the site already adopted ─────────────────────────

/**
 * Kind precedence when adoption is otherwise tied. Reflects "what existing
 * websites want to use already": a resource a site natively pays for (x402) or
 * exposes as an MCP tool is what it has already adopted; a skill is the broad
 * cross-agent standard; a bare route is our wrapper of last resort. The dominant
 * signal is the per-primitive `adoption` count — this only breaks ties.
 */
export const KIND_PRECEDENCE: Record<PrimitiveKind, number> = {
	x402_resource: 3, // the site already monetizes it — strongest "already uses"
	mcp_tool: 2, // the site already runs a server for it
	skill: 1, // the broad open standard
	route: 0, // our wrapper — last resort
};

/**
 * Rank primitives by what the ecosystem already uses: adoption count first, then
 * kind precedence. Stable, pure. Highest-priority first.
 */
export function prioritize(primitives: AgentPrimitive[]): AgentPrimitive[] {
	return [...primitives]
		.map((p, i) => ({ p, i }))
		.sort((a, b) => {
			const ad = (b.p.adoption ?? 0) - (a.p.adoption ?? 0);
			if (ad !== 0) return ad;
			const kd = KIND_PRECEDENCE[b.p.kind] - KIND_PRECEDENCE[a.p.kind];
			if (kd !== 0) return kd;
			return a.i - b.i; // stable
		})
		.map(({ p }) => p);
}
