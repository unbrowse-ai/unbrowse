import { describe, expect, it } from "bun:test";
import {
	openApiOperationToPrimitive,
	primitiveToOpenApiOperation,
	parseLlmsTxt,
	llmsTxtLinkToPrimitive,
	primitivesToLlmsTxt,
	a2aSkillToPrimitive,
	agentCardToPrimitives,
	primitiveToA2aSkill,
	ingest,
	prioritize,
	KIND_PRECEDENCE,
	type OpenApiOperation,
	type A2aAgentCard,
	type AgentPrimitive,
} from "../src/interop/agent-primitives.js";

describe("OpenAPI operation ↔ primitive", () => {
	it("maps method→verb and carries the standard auth scheme", () => {
		const op: OpenApiOperation = { path: "/v1/items/{id}", method: "get", operationId: "getItem", summary: "fetch one item", baseUrl: "https://api.site.com", auth: { type: "oauth2", detail: { flows: {} } } };
		const p = openApiOperationToPrimitive(op);
		expect(p.kind).toBe("openapi");
		expect(p.verb).toBe("eval"); // GET
		expect(p.where).toBe("https://api.site.com/v1/items/{id}");
		expect(p.who).toBe("api.site.com");
		expect(p.auth?.type).toBe("oauth2"); // adopted the standard scheme, not ours
		expect(openApiOperationToPrimitive({ path: "/x", method: "post" }).verb).toBe("build");
		expect(openApiOperationToPrimitive({ path: "/x", method: "delete" }).verb).toBe("breath");
	});

	it("round-trips path + method + auth", () => {
		const op: OpenApiOperation = { path: "/p", method: "PATCH", operationId: "edit", baseUrl: "https://e.com", auth: { type: "apiKey" } };
		const back = primitiveToOpenApiOperation(openApiOperationToPrimitive(op));
		expect(back.path).toBe("/p");
		expect(back.method).toBe("PATCH");
		expect(back.auth?.type).toBe("apiKey");
	});
});

describe("llms.txt ↔ primitives", () => {
	const doc = `# Acme Docs

> Everything an agent needs about Acme.

Some intro prose (ignored).

## Docs
- [Getting started](https://acme.com/start): the quickstart
- [API reference](https://acme.com/api)

## Optional
- [Changelog](https://acme.com/changelog): release notes`;

	it("parses H2 sections + link entries with optional notes", () => {
		const links = parseLlmsTxt(doc);
		expect(links).toHaveLength(3);
		expect(links[0]).toEqual({ name: "Getting started", url: "https://acme.com/start", notes: "the quickstart", section: "Docs" });
		expect(links[1]!.notes).toBeUndefined();
		expect(links[2]!.section).toBe("Optional");
	});

	it("ingests a link to a primitive and serves primitives back as llms.txt", () => {
		const p = llmsTxtLinkToPrimitive(parseLlmsTxt(doc)[0]!);
		expect(p.kind).toBe("llms_txt");
		expect(p.where).toBe("https://acme.com/start");
		expect(p.who).toBe("acme.com");
		const out = primitivesToLlmsTxt([p], "Acme", "summary here");
		expect(out).toContain("# Acme");
		expect(out).toContain("> summary here");
		expect(out).toContain("[Getting started](https://acme.com/start)");
	});
});

describe("A2A AgentCard ↔ primitives", () => {
	const card: A2aAgentCard = {
		name: "Acme Agent",
		url: "https://acme.com/a2a",
		version: "1.0",
		skills: [
			{ id: "quote", name: "get quote", description: "fetch a quote", tags: ["finance", "read"] },
			{ id: "order", name: "place order", description: "submit an order", tags: ["write"] },
		],
		securitySchemes: { oauth: { type: "oauth2", flows: {} } },
	};

	it("fans a card out to one primitive per skill, adopting the card's auth", () => {
		const prims = agentCardToPrimitives(card);
		expect(prims).toHaveLength(2);
		expect(prims[0]!.kind).toBe("a2a_skill");
		expect(prims[0]!.where).toBe("https://acme.com/a2a"); // reached via the card endpoint
		expect(prims[0]!.who).toBe("acme.com");
		expect(prims[0]!.verb).toBe("eval"); // "get quote" + read tag
		expect(prims[1]!.verb).toBe("build"); // "place order" + write tag
		expect(prims[0]!.auth?.type).toBe("oauth2"); // standard scheme adopted
	});

	it("round-trips a skill", () => {
		const back = primitiveToA2aSkill(a2aSkillToPrimitive(card.skills![0]!, card));
		expect(back.id).toBe("quote");
		expect(back.name).toBe("get quote");
		expect(back.tags).toEqual(["finance", "read"]);
	});
});

describe("ingest dispatch + precedence across all 7 kinds", () => {
	it("ingest routes each new kind", () => {
		expect(ingest({ path: "/x", method: "get" }, "openapi").kind).toBe("openapi");
		expect(ingest({ name: "n", url: "https://x/y" }, "llms_txt").kind).toBe("llms_txt");
		expect(ingest({ skill: { id: "s", name: "s" }, card: { name: "c" } }, "a2a_skill").kind).toBe("a2a_skill");
	});

	it("precedence: x402 > openapi > a2a > mcp > llms_txt > skill > route (tie-break)", () => {
		const mk = (kind: AgentPrimitive["kind"]): AgentPrimitive => ({ who: kind, what: kind, why: "", where: kind, verb: "eval", kind, adoption: 5 });
		const ordered = prioritize(["route", "skill", "llms_txt", "mcp_tool", "a2a_skill", "openapi", "x402_resource"].map((k) => mk(k as AgentPrimitive["kind"]))).map((p) => p.kind);
		expect(ordered).toEqual(["x402_resource", "openapi", "a2a_skill", "mcp_tool", "llms_txt", "skill", "route"]);
		expect(KIND_PRECEDENCE.openapi).toBeGreaterThan(KIND_PRECEDENCE.mcp_tool);
	});
});
