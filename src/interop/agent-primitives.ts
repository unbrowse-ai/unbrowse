/**
 * agent-primitives — the one shared shape every agent ecosystem maps to.
 *
 * Agents already adopt three discovery/invocation primitives in the wild:
 *   - Agent Skills (agentskills.io) — a SKILL.md folder; name+description+instructions.
 *     Open standard, Anthropic-origin, ~40 client agents. src: https://agentskills.io/specification
 *   - MCP tools (modelcontextprotocol.io) — { name, description, inputSchema }.
 *     src: MCP spec (modelcontextprotocol.io).
 *   - x402 resources (x402 Bazaar) — { resource{url,…}, accepts[{scheme,network,amount,
 *     asset,payTo,…}] }. src: the live 402 envelope from beta-api.unbrowse.ai/v1/llm/*.
 *
 * A route is the SAME shape underneath — who/what/where/why + a verb.
 * So instead of inventing a fourth standard, every external primitive INGESTS into
 * one `AgentPrimitive`, and any AgentPrimitive can be SERVED back AS a skill, an MCP
 * tool, or an x402 resource. That bidirectionality is the drop-in replacement, all
 * the way down: we meet a site in whatever it already speaks, and we
 * prioritize the format it already adopted.
 *
 * Pure, zero-dep. Verb classification is a fixed mapping: read→eval, act→breath, write→build.
 */
type RouteVerb = "build" | "breath" | "eval";

export type PrimitiveKind =
	| "skill" // agentskills.io SKILL.md
	| "mcp_tool" // Model Context Protocol tool
	| "x402_resource" // x402 Bazaar resource
	| "openapi" // OpenAPI operation (openapis.org — the universal API spec)
	| "llms_txt" // llms.txt link (llmstxt.org — the site-side LLM discovery file)
	| "a2a_skill" // A2A AgentCard skill (a2a-protocol.org)
	| "route"; // our native route

/**
 * Standard auth scheme adopted verbatim from the source (OpenAPI/A2A securityScheme
 * shape — OAuth2/OIDC/apiKey/http). We DO NOT invent an auth format: we read the
 * open standard a site already declares. If our own auth is weaker, we
 * purge it and let the standard be primary.
 */
export interface AuthScheme {
	type: "oauth2" | "openIdConnect" | "apiKey" | "http" | "mutualTLS" | "none";
	/** standard securityScheme detail (flows, openIdConnectUrl, bearer scheme, apiKey name/in). */
	detail?: Record<string, unknown>;
}

/**
 * The universal node — who/what/where/why + the verb. Every external primitive
 * maps onto exactly this, and `raw` carries the source payload for lossless serve.
 */
export interface AgentPrimitive {
	who: string; // provider / identity — domain, server name, or wallet
	what: string; // name (the handle agents match on)
	why: string; // description / intent the primitive serves
	where: string; // invoke target — resource URL, tool name, or skill id
	verb: RouteVerb; // create / act / read
	kind: PrimitiveKind; // the ecosystem this was ingested from / served as
	/** how (optional payment seal) — present for x402-payable primitives. */
	payment?: { amount: string; asset: string; network?: string; payTo?: string };
	/** how (optional auth) — the standard scheme the source declares (adopt, don't invent). */
	auth?: AuthScheme;
	/** adoption signal for prioritization — higher = more already-used in the wild. */
	adoption?: number;
	/** the source payload, for lossless round-trip. */
	raw?: unknown;
}

/** HTTP method → verb: read→eval, delete/act→breath, create/commit→build. */
function verbOfMethod(method: string): RouteVerb {
	const m = method.toUpperCase();
	if (m === "GET" || m === "HEAD" || m === "OPTIONS") return "eval";
	if (m === "POST" || m === "PUT" || m === "PATCH") return "build";
	return "breath"; // DELETE and anything else: an act on the world
}

// ─── verb classification (read→eval, act→breath, write→build) ───────────────────
// observe/read → eval; act/fetch → breath; create/commit → build. Default breath
// (the routing default).
const READ_HINT = /\b(get|list|search|read|fetch|query|lookup|view|status|health|info)\b/i;
const WRITE_HINT = /\b(create|publish|submit|write|post|register|mint|deploy|bond)\b/i;

function inferVerb(name: string, opts?: { readOnly?: boolean; destructive?: boolean }): RouteVerb {
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

// ─── OpenAPI (openapis.org) — the universal API description ───────────────────
// An OpenAPI operation is the most widely-adopted way a site already describes a
// callable endpoint. src: https://spec.openapis.org/oas/latest.html

export interface OpenApiOperation {
	path: string; // the path template, e.g. /v1/items/{id}
	method: string; // GET / POST / ...
	operationId?: string;
	summary?: string;
	description?: string;
	baseUrl?: string; // from the spec's `servers[0].url`
	/** the operation's security requirement, mapped to a standard scheme. */
	auth?: AuthScheme;
}

export function openApiOperationToPrimitive(op: OpenApiOperation, opts?: { who?: string }): AgentPrimitive {
	const where = `${op.baseUrl ?? ""}${op.path}`;
	let who = opts?.who;
	if (!who && op.baseUrl) { try { who = new URL(op.baseUrl).hostname; } catch { /* keep undefined */ } }
	return {
		who: who ?? "openapi",
		what: op.operationId ?? `${op.method.toUpperCase()} ${op.path}`,
		why: op.summary ?? op.description ?? `${op.method.toUpperCase()} ${op.path}`,
		where,
		verb: verbOfMethod(op.method),
		kind: "openapi",
		...(op.auth ? { auth: op.auth } : {}),
		raw: op,
	};
}

export function primitiveToOpenApiOperation(p: AgentPrimitive): OpenApiOperation {
	const base = (p.raw && p.kind === "openapi" ? (p.raw as OpenApiOperation) : undefined);
	return {
		path: base?.path ?? p.where,
		method: base?.method ?? (p.verb === "eval" ? "GET" : p.verb === "build" ? "POST" : "POST"),
		operationId: p.what,
		summary: p.why,
		...(base?.baseUrl ? { baseUrl: base.baseUrl } : {}),
		...(p.auth ? { auth: p.auth } : {}),
	};
}

// ─── llms.txt (llmstxt.org) — the site-side LLM discovery file ────────────────
// H1 title, optional blockquote summary, then H2 sections each a markdown list of
// `- [name](url): notes`. src: https://llmstxt.org

export interface LlmsTxtLink { name: string; url: string; notes?: string; section?: string }

/** Parse an llms.txt document into its link entries (the discoverable surface). */
export function parseLlmsTxt(text: string): LlmsTxtLink[] {
	const links: LlmsTxtLink[] = [];
	let section: string | undefined;
	for (const line of text.split(/\r?\n/)) {
		const h2 = /^##\s+(.+?)\s*$/.exec(line);
		if (h2) { section = h2[1]; continue; }
		// markdown list item with a required [name](url) and optional ": notes"
		const m = /^\s*[-*]\s*\[([^\]]+)\]\(([^)]+)\)\s*(?::\s*(.*))?$/.exec(line);
		if (m) links.push({ name: m[1]!, url: m[2]!, ...(m[3] ? { notes: m[3].trim() } : {}), ...(section ? { section } : {}) });
	}
	return links;
}

export function llmsTxtLinkToPrimitive(link: LlmsTxtLink, opts?: { who?: string }): AgentPrimitive {
	let who = opts?.who;
	if (!who) { try { who = new URL(link.url).hostname; } catch { who = "llms.txt"; } }
	return {
		who: who!,
		what: link.name,
		why: link.notes ?? link.name,
		where: link.url,
		verb: inferVerb(`${link.name} ${link.notes ?? ""}`),
		kind: "llms_txt",
		raw: link,
	};
}

/** Serve primitives back AS an llms.txt document (the drop-in emit). */
export function primitivesToLlmsTxt(primitives: AgentPrimitive[], title: string, summary?: string): string {
	const lines = [`# ${title}`, ""];
	if (summary) lines.push(`> ${summary}`, "");
	lines.push("## Endpoints", "");
	for (const p of primitives) {
		lines.push(`- [${p.what}](${p.where})${p.why && p.why !== p.what ? `: ${p.why}` : ""}`);
	}
	return lines.join("\n") + "\n";
}

// ─── A2A AgentCard (a2a-protocol.org) — agent-to-agent capability discovery ───
// src: https://a2a-protocol.org/latest/specification/

export interface A2aSkill { id: string; name: string; description?: string; tags?: string[]; examples?: string[] }
export interface A2aAgentCard {
	name: string;
	description?: string;
	url?: string;
	version?: string;
	skills?: A2aSkill[];
	securitySchemes?: Record<string, { type?: string; [k: string]: unknown }>;
}

function authFromSecuritySchemes(schemes?: Record<string, { type?: string; [k: string]: unknown }>): AuthScheme | undefined {
	if (!schemes) return undefined;
	const first = Object.values(schemes)[0];
	if (!first?.type) return undefined;
	const t = first.type as AuthScheme["type"];
	return { type: ["oauth2", "openIdConnect", "apiKey", "http", "mutualTLS"].includes(t) ? t : "none", detail: first };
}

export function a2aSkillToPrimitive(skill: A2aSkill, card: A2aAgentCard): AgentPrimitive {
	let who = card.name;
	if (card.url) { try { who = new URL(card.url).hostname; } catch { /* keep name */ } }
	return {
		who,
		what: skill.name,
		why: skill.description ?? skill.name,
		where: card.url ?? skill.id, // an A2A skill is reached via the card's service endpoint
		verb: inferVerb(`${skill.name} ${(skill.tags ?? []).join(" ")} ${skill.description ?? ""}`),
		kind: "a2a_skill",
		...(authFromSecuritySchemes(card.securitySchemes) ? { auth: authFromSecuritySchemes(card.securitySchemes) } : {}),
		raw: { skill, card },
	};
}

/** Every skill an A2A AgentCard advertises, as primitives. */
export function agentCardToPrimitives(card: A2aAgentCard): AgentPrimitive[] {
	return (card.skills ?? []).map((s) => a2aSkillToPrimitive(s, card));
}

export function primitiveToA2aSkill(p: AgentPrimitive): A2aSkill {
	const raw = (p.raw && p.kind === "a2a_skill" ? (p.raw as { skill: A2aSkill }).skill : undefined);
	return { id: raw?.id ?? p.what, name: p.what, description: p.why, ...(raw?.tags ? { tags: raw.tags } : {}) };
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
		case "openapi":
			return openApiOperationToPrimitive(external as OpenApiOperation, opts);
		case "llms_txt":
			return llmsTxtLinkToPrimitive(external as LlmsTxtLink, opts);
		case "a2a_skill":
			return a2aSkillToPrimitive((external as { skill: A2aSkill; card: A2aAgentCard }).skill, (external as { card: A2aAgentCard }).card);
		case "route":
			return external as AgentPrimitive; // already in the shared shape
	}
}

/** Serve an AgentPrimitive AS the ecosystem `kind` a site already speaks (the drop-in). */
export function serveAs(
	p: AgentPrimitive,
	kind: PrimitiveKind,
): SkillFrontmatter | McpTool | X402Resource | OpenApiOperation | A2aSkill | AgentPrimitive {
	switch (kind) {
		case "skill":
			return primitiveToSkill(p);
		case "mcp_tool":
			return primitiveToMcpTool(p);
		case "x402_resource":
			return primitiveToX402Resource(p);
		case "openapi":
			return primitiveToOpenApiOperation(p);
		case "a2a_skill":
			return primitiveToA2aSkill(p);
		case "llms_txt":
			return primitivesToLlmsTxt([p], p.who) as unknown as AgentPrimitive; // a single-link doc
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
	x402_resource: 6, // the site already monetizes it — strongest "already uses"
	openapi: 5, // the site publishes a formal API spec for it
	a2a_skill: 4, // the site runs an A2A agent advertising it
	mcp_tool: 3, // the site runs an MCP server for it
	llms_txt: 2, // the site hints it in its llms.txt
	skill: 1, // the broad cross-agent SKILL.md standard
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
