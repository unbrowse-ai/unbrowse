import { afterEach, describe, expect, it } from "bun:test";
import { x402BazaarSource, localSkillsSource, bazaarItemToResource, X402_BAZAAR_URL } from "../src/interop/sources.js";
import { discoverSitePrimitives } from "../src/interop/mount.js";
import { x402ResourceToPrimitive, type AgentPrimitive } from "../src/interop/agent-primitives.js";

const ORIGINAL_FLAG = process.env.UNBROWSE_INTEROP_DISCOVERY;
afterEach(() => {
	if (ORIGINAL_FLAG === undefined) delete process.env.UNBROWSE_INTEROP_DISCOVERY;
	else process.env.UNBROWSE_INTEROP_DISCOVERY = ORIGINAL_FLAG;
});

describe("bazaarItemToResource", () => {
	it("maps the LIVE shape (top-level description, quality.l30DaysTotalCalls → adoption)", () => {
		const r = bazaarItemToResource({
			resource: "https://api.oatp.cc/tools/tx_explainer",
			description: "explain a tx",
			accepts: [{ scheme: "exact", network: "solana", amount: "100000", asset: "USDC", payTo: "W" }],
			quality: { l30DaysTotalCalls: 13278, l30DaysUniquePayers: 2010 },
		});
		expect(r.resource.url).toBe("https://api.oatp.cc/tools/tx_explainer");
		expect(r.resource.description).toBe("explain a tx");
		expect(r.quality).toBe(13278);
		// flows into adoption on the primitive
		expect(x402ResourceToPrimitive(r).adoption).toBe(13278);
	});

	it("falls back to metadata.description (older docs shape) and tolerates missing fields", () => {
		const r = bazaarItemToResource({ resource: "https://x/y", metadata: { description: "old shape" } });
		expect(r.resource.description).toBe("old shape");
		expect(r.accepts).toEqual([]);
		expect(r.quality).toBeUndefined();
	});
});

describe("x402BazaarSource", () => {
	it("hits the discovery endpoint and maps items[]", async () => {
		let calledUrl = "";
		const src = x402BazaarSource({
			limit: 5,
			fetchFn: (async (url: string) => {
				calledUrl = url;
				return new Response(JSON.stringify({ items: [{ resource: "https://a/b", accepts: [], quality: { l30DaysTotalCalls: 7 } }] }), { status: 200, headers: { "content-type": "application/json" } });
			}) as typeof fetch,
		});
		const out = await src("intent");
		expect(calledUrl).toBe(`${X402_BAZAAR_URL}?limit=5`);
		expect(out).toHaveLength(1);
		expect(out[0]!.quality).toBe(7);
	});

	it("degrades gracefully on non-2xx, bad JSON, or network error", async () => {
		expect(await x402BazaarSource({ fetchFn: (async () => new Response("x", { status: 500 })) as typeof fetch })("i")).toEqual([]);
		expect(await x402BazaarSource({ fetchFn: (async () => { throw new Error("net"); }) as typeof fetch })("i")).toEqual([]);
		expect(await x402BazaarSource({ fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch })("i")).toEqual([]); // no items[]
	});
});

describe("localSkillsSource", () => {
	it("returns the loaded frontmatters, or [] when none / throwing", async () => {
		expect(await localSkillsSource(async () => [{ name: "s", description: "d" }])("i")).toHaveLength(1);
		expect(await localSkillsSource()("i")).toEqual([]);
		expect(await localSkillsSource(async () => { throw new Error("read fail"); })("i")).toEqual([]);
	});
});

describe("discoverSitePrimitives (gated)", () => {
	it("makes NO network call and returns [] when the flag is off", async () => {
		delete process.env.UNBROWSE_INTEROP_DISCOVERY;
		let fetched = false;
		const out = await discoverSitePrimitives("i", "d", { fetchFn: (async () => { fetched = true; return new Response("{}"); }) as typeof fetch });
		expect(out).toEqual([]);
		expect(fetched).toBe(false); // gate short-circuits before any fetch
	});

	it("when off, still ranks native routes resolve handed in (no network)", async () => {
		delete process.env.UNBROWSE_INTEROP_DISCOVERY;
		const native: AgentPrimitive[] = [{ who: "d", what: "r", why: "", where: "d", verb: "eval", kind: "route" }];
		const out = await discoverSitePrimitives("i", "d", { nativeRoutes: native });
		expect(out).toHaveLength(1);
		expect(out[0]!.kind).toBe("route");
	});

	it("when on, merges live + native and ranks by adoption", async () => {
		process.env.UNBROWSE_INTEROP_DISCOVERY = "1";
		const native: AgentPrimitive[] = [{ who: "d", what: "wrap", why: "", where: "d", verb: "eval", kind: "route", adoption: 1 }];
		const out = await discoverSitePrimitives("i", "d", {
			nativeRoutes: native,
			fetchFn: (async () => new Response(JSON.stringify({ items: [{ resource: "https://x/paid", accepts: [{ scheme: "exact", network: "solana", amount: "5", asset: "USDC", payTo: "W" }], quality: { l30DaysTotalCalls: 9999 } }] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
		});
		expect(out).toHaveLength(2);
		expect(out[0]!.kind).toBe("x402_resource"); // adoption 9999 ≫ native's 1
		expect(out[0]!.adoption).toBe(9999);
	});
});
