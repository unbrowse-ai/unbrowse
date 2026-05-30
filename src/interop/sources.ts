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
import type {
	X402Resource,
	X402Accept,
	SkillFrontmatter,
	OpenApiOperation,
	LlmsTxtLink,
	AgentPrimitive,
	AuthScheme,
} from "./agent-primitives.js";
import { parseLlmsTxt, agentCardToPrimitives, type A2aAgentCard } from "./agent-primitives.js";

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

// ─── live fetchers for the standards a site publishes at well-known locations ─

async function tryFetchText(fetchFn: typeof fetch, url: string): Promise<string | null> {
	try {
		const res = await fetchFn(url, { headers: { Accept: "text/plain, text/markdown, */*" }, signal: AbortSignal.timeout(8_000) });
		return res.ok ? await res.text() : null;
	} catch {
		return null;
	}
}
async function tryFetchJson(fetchFn: typeof fetch, url: string): Promise<any | null> {
	try {
		const res = await fetchFn(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
		return res.ok ? await res.json() : null;
	} catch {
		return null;
	}
}

/** REAL llms.txt source — the standard root file (llmstxt.org). Graceful. */
export function llmsTxtSource(opts?: { fetchFn?: typeof fetch }) {
	const fetchFn = opts?.fetchFn ?? fetch;
	return async (_intent: string, domain?: string): Promise<LlmsTxtLink[]> => {
		if (!domain) return [];
		const text = await tryFetchText(fetchFn, `https://${domain}/llms.txt`);
		return text ? parseLlmsTxt(text) : [];
	};
}

/** Map an OpenAPI components.securityScheme map to our standard AuthScheme. */
function authFromOpenApi(spec: any): AuthScheme | undefined {
	const schemes = spec?.components?.securitySchemes;
	if (!schemes || typeof schemes !== "object") return undefined;
	const first = Object.values(schemes)[0] as { type?: string } | undefined;
	if (!first?.type) return undefined;
	const t = first.type as AuthScheme["type"];
	return { type: (["oauth2", "openIdConnect", "apiKey", "http", "mutualTLS"] as const).includes(t as any) ? t : "none", detail: first as Record<string, unknown> };
}

/**
 * REAL OpenAPI source — fetch the site's spec at the common locations and walk
 * paths × methods into operations. src: https://spec.openapis.org/oas/latest.html
 */
export function openApiSource(opts?: { fetchFn?: typeof fetch; paths?: string[] }) {
	const fetchFn = opts?.fetchFn ?? fetch;
	const candidates = opts?.paths ?? ["/openapi.json", "/.well-known/openapi.json", "/swagger.json"];
	const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
	return async (_intent: string, domain?: string): Promise<OpenApiOperation[]> => {
		if (!domain) return [];
		let spec: any = null;
		for (const p of candidates) {
			spec = await tryFetchJson(fetchFn, `https://${domain}${p}`);
			if (spec?.paths) break;
		}
		if (!spec?.paths || typeof spec.paths !== "object") return [];
		const baseUrl = spec.servers?.[0]?.url ?? `https://${domain}`;
		const auth = authFromOpenApi(spec);
		const ops: OpenApiOperation[] = [];
		for (const [path, item] of Object.entries(spec.paths as Record<string, any>)) {
			for (const method of METHODS) {
				const op = item?.[method];
				if (!op || typeof op !== "object") continue;
				ops.push({
					path,
					method,
					operationId: op.operationId,
					summary: op.summary,
					description: op.description,
					baseUrl,
					...(auth ? { auth } : {}),
				});
			}
		}
		return ops;
	};
}

/**
 * REAL A2A source — fetch the AgentCard at its well-known location and fan it out
 * to one primitive per skill. src: https://a2a-protocol.org/latest/specification/
 */
export function a2aSource(opts?: { fetchFn?: typeof fetch; paths?: string[] }) {
	const fetchFn = opts?.fetchFn ?? fetch;
	const candidates = opts?.paths ?? ["/.well-known/agent-card.json", "/.well-known/agent.json"];
	return async (_intent: string, domain?: string): Promise<AgentPrimitive[]> => {
		if (!domain) return [];
		for (const p of candidates) {
			const card = (await tryFetchJson(fetchFn, `https://${domain}${p}`)) as A2aAgentCard | null;
			if (card?.name) return agentCardToPrimitives(card);
		}
		return [];
	};
}
