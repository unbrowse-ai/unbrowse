import { describe, expect, it } from "bun:test";
import {
	skillToPrimitive,
	primitiveToSkill,
	mcpToolToPrimitive,
	primitiveToMcpTool,
	x402ResourceToPrimitive,
	primitiveToX402Resource,
	ingest,
	serveAs,
	prioritize,
	KIND_PRECEDENCE,
	type AgentPrimitive,
	type McpTool,
	type X402Resource,
} from "../src/interop/agent-primitives.js";

describe("agentskills.io skill ↔ primitive", () => {
	it("ingests a SKILL.md frontmatter into the covenant shape", () => {
		const p = skillToPrimitive({ name: "pdf-fill", description: "Fill PDF forms from a data map" });
		expect(p.kind).toBe("skill");
		expect(p.what).toBe("pdf-fill");
		expect(p.why).toBe("Fill PDF forms from a data map");
		expect(p.verb).toBe("breath"); // procedural action
	});

	it("round-trips name + description losslessly and preserves extra frontmatter", () => {
		const fm = { name: "x", description: "d", license: "MIT", "allowed-tools": ["Bash"] };
		const back = primitiveToSkill(skillToPrimitive(fm));
		expect(back.name).toBe("x");
		expect(back.description).toBe("d");
		expect(back.license).toBe("MIT"); // extra fields survive via raw passthrough
	});
});

describe("MCP tool ↔ primitive", () => {
	it("ingests a tool and infers verb from annotations/name", () => {
		const read: McpTool = { name: "search_docs", description: "search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } };
		expect(mcpToolToPrimitive(read).verb).toBe("eval");
		const write: McpTool = { name: "publish_skill", description: "publish", inputSchema: { type: "object" } };
		expect(mcpToolToPrimitive(write).verb).toBe("build");
	});

	it("round-trips name/description/inputSchema", () => {
		const tool: McpTool = { name: "t", description: "d", inputSchema: { type: "object", properties: { q: { type: "string" } } } };
		const back = primitiveToMcpTool(mcpToolToPrimitive(tool));
		expect(back.name).toBe("t");
		expect(back.inputSchema).toEqual(tool.inputSchema);
	});
});

describe("x402 resource ↔ primitive", () => {
	const entry: X402Resource = {
		resource: { url: "https://api.site.com/v1/quote", description: "stock quote", mimeType: "application/json" },
		accepts: [{ scheme: "exact", network: "solana", amount: "1000", asset: "USDC", payTo: "Wabc", maxTimeoutSeconds: 60 }],
	};

	it("ingests resource + accepts, carrying the payment seal and provider host", () => {
		const p = x402ResourceToPrimitive(entry);
		expect(p.kind).toBe("x402_resource");
		expect(p.where).toBe("https://api.site.com/v1/quote");
		expect(p.who).toBe("api.site.com");
		expect(p.payment).toEqual({ amount: "1000", asset: "USDC", network: "solana", payTo: "Wabc" });
	});

	it("round-trips the resource url + payment terms", () => {
		const back = primitiveToX402Resource(x402ResourceToPrimitive(entry));
		expect(back.resource.url).toBe(entry.resource.url);
		expect(back.accepts[0]!.amount).toBe("1000");
		expect(back.accepts[0]!.asset).toBe("USDC");
	});

	it("can mint an x402 resource from a primitive that has payment but no x402 raw", () => {
		const p: AgentPrimitive = { who: "s", what: "https://s/x", why: "paid call", where: "https://s/x", verb: "breath", kind: "route", payment: { amount: "5", asset: "USDC" } };
		const res = primitiveToX402Resource(p);
		expect(res.resource.url).toBe("https://s/x");
		expect(res.accepts[0]!.amount).toBe("5");
		expect(res.accepts[0]!.scheme).toBe("exact");
	});
});

describe("drop-in: ingest from any, serve as any", () => {
	it("serves one primitive into all three ecosystems", () => {
		const p: AgentPrimitive = { who: "site.com", what: "get-weather", why: "current weather", where: "https://site.com/weather", verb: "eval", kind: "route", payment: { amount: "100", asset: "USDC" } };
		const asSkill = serveAs(p, "skill") as { name: string; description: string };
		const asMcp = serveAs(p, "mcp_tool") as McpTool;
		const asX402 = serveAs(p, "x402_resource") as X402Resource;
		expect(asSkill.name).toBe("get-weather");
		expect(asMcp.name).toBe("get-weather");
		expect(asX402.resource.url).toBe("https://site.com/weather");
		expect(asX402.accepts[0]!.amount).toBe("100");
	});

	it("ingest∘serveAs preserves the load-bearing fields for every kind", () => {
		const p: AgentPrimitive = { who: "x", what: "do-thing", why: "does the thing", where: "do-thing", verb: "breath", kind: "skill" };
		for (const kind of ["skill", "mcp_tool"] as const) {
			const round = ingest(serveAs(p, kind), kind);
			expect(round.what).toBe(p.what);
			expect(round.why).toBe(p.why);
			expect(round.verb).toBe(p.verb);
		}
	});
});

describe("prioritize — serve what the site already adopted", () => {
	it("ranks by adoption count first", () => {
		const a: AgentPrimitive = { who: "a", what: "a", why: "", where: "a", verb: "eval", kind: "skill", adoption: 10 };
		const b: AgentPrimitive = { who: "b", what: "b", why: "", where: "b", verb: "eval", kind: "route", adoption: 99 };
		expect(prioritize([a, b])[0]!.what).toBe("b"); // higher adoption wins regardless of kind
	});

	it("breaks adoption ties by kind precedence (x402 > mcp > skill > route)", () => {
		const mk = (kind: AgentPrimitive["kind"]): AgentPrimitive => ({ who: kind, what: kind, why: "", where: kind, verb: "eval", kind, adoption: 5 });
		const ordered = prioritize([mk("route"), mk("skill"), mk("x402_resource"), mk("mcp_tool")]).map((p) => p.kind);
		expect(ordered).toEqual(["x402_resource", "mcp_tool", "skill", "route"]);
		expect(KIND_PRECEDENCE.x402_resource).toBeGreaterThan(KIND_PRECEDENCE.route);
	});

	it("is stable for fully-tied primitives", () => {
		const t = (n: string): AgentPrimitive => ({ who: n, what: n, why: "", where: n, verb: "eval", kind: "skill", adoption: 1 });
		expect(prioritize([t("1"), t("2"), t("3")]).map((p) => p.what)).toEqual(["1", "2", "3"]);
	});
});
