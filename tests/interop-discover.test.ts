import { describe, expect, it } from "bun:test";
import { discoverPrimitives, type PrimitiveSources } from "../src/interop/discover.js";
import type { AgentPrimitive } from "../src/interop/agent-primitives.js";

describe("discoverPrimitives", () => {
	it("merges every ecosystem and ranks what the site already adopted first", async () => {
		const sources: PrimitiveSources = {
			skills: async () => [{ name: "fill-form", description: "fill the form" }],
			mcpTools: async () => [{ name: "get_quote", description: "quote", inputSchema: { type: "object" } }],
			x402Resources: async () => [{ resource: { url: "https://site.com/api/quote", description: "paid quote" }, accepts: [{ scheme: "exact", network: "solana", amount: "100", asset: "USDC", payTo: "W" }] }],
			routes: async () => [{ who: "site.com", what: "wrapped", why: "our wrapper", where: "https://site.com/wrapped", verb: "eval", kind: "route" } as AgentPrimitive],
		};
		const ranked = await discoverPrimitives("get a quote", "site.com", sources);
		expect(ranked).toHaveLength(4);
		// none carry an adoption count → kind precedence decides: x402 > mcp > skill > route
		expect(ranked[0]!.kind).toBe("x402_resource");
		expect(ranked.at(-1)!.kind).toBe("route"); // our wrapper is the last resort
		expect(ranked[0]!.payment?.amount).toBe("100");
	});

	it("is graceful: a missing or throwing source just drops out", async () => {
		const ranked = await discoverPrimitives("x", "d", {
			skills: async () => [{ name: "s", description: "d" }],
			mcpTools: async () => { throw new Error("mcp probe failed"); }, // drops out
			// x402Resources + routes omitted entirely
		});
		expect(ranked).toHaveLength(1);
		expect(ranked[0]!.kind).toBe("skill");
	});

	it("returns [] when every source is empty or absent (no throw)", async () => {
		expect(await discoverPrimitives("x", undefined, {})).toEqual([]);
		expect(await discoverPrimitives("x", "d", { skills: async () => [] })).toEqual([]);
	});

	it("stamps the site domain as the provider for ingested skills/tools", async () => {
		const ranked = await discoverPrimitives("x", "acme.com", {
			skills: async () => [{ name: "s", description: "d" }],
		});
		expect(ranked[0]!.who).toBe("acme.com");
	});
});
