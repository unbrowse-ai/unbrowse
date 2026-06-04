import { afterEach, describe, expect, it } from "bun:test";
import {
	routePtrOf,
	routesFromSkills,
	makeReadOnlyReindex,
	startTrustRefreshIfEnabled,
} from "../src/trust/mount.js";
import type { SkillManifest, EndpointDescriptor } from "../src/types/skill.js";

const ep = (over: Partial<EndpointDescriptor> & { endpoint_id: string }): EndpointDescriptor =>
	({ method: "GET", url_template: `https://e.com/${over.endpoint_id}`, idempotency: "safe", verification_status: "verified", reliability_score: 1, ...over }) as EndpointDescriptor;

const skill = (id: string, eps: EndpointDescriptor[]): SkillManifest =>
	({ skill_id: id, domain: "e.com", endpoints: eps } as SkillManifest);

const ORIGINAL_FLAG = process.env.UNBROWSE_TRUST_REFRESH;
afterEach(() => {
	if (ORIGINAL_FLAG === undefined) delete process.env.UNBROWSE_TRUST_REFRESH;
	else process.env.UNBROWSE_TRUST_REFRESH = ORIGINAL_FLAG;
});

describe("routePtrOf", () => {
	it("is deterministic and distinguishes endpoints", async () => {
		const s = skill("marketplace:x", []);
		const a = ep({ endpoint_id: "list" });
		const b = ep({ endpoint_id: "detail" });
		expect(await routePtrOf(s, a)).toBe(await routePtrOf(s, a));
		expect(await routePtrOf(s, a)).not.toBe(await routePtrOf(s, b));
		expect(await routePtrOf(s, a)).toStartWith("sha256:");
	});
});

describe("routesFromSkills", () => {
	it("flattens every skill's endpoints into refresh routes", async () => {
		const routes = await routesFromSkills([
			skill("s1", [ep({ endpoint_id: "a" }), ep({ endpoint_id: "b" })]),
			skill("s2", [ep({ endpoint_id: "c" })]),
		]);
		expect(routes).toHaveLength(3);
		expect(new Set(routes.map((r) => r.routePtr)).size).toBe(3); // all distinct
		expect(routes[0]!.endpoint.endpoint_id).toBe("a");
	});

	it("tolerates a skill with no endpoints", async () => {
		expect(await routesFromSkills([skill("empty", [])])).toEqual([]);
	});
});

describe("makeReadOnlyReindex", () => {
	it("issues the GET and returns parsed JSON on 2xx", async () => {
		const reindex = makeReadOnlyReindex((async () =>
			new Response(JSON.stringify({ items: [1, 2] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch);
		expect(await reindex(ep({ endpoint_id: "x" }))).toEqual({ items: [1, 2] });
	});

	it("throws on non-2xx", async () => {
		const reindex = makeReadOnlyReindex((async () => new Response("nope", { status: 503 })) as typeof fetch);
		await expect(reindex(ep({ endpoint_id: "x" }))).rejects.toThrow(/HTTP 503/);
	});

	it("refuses a non-safe method (never mutates)", async () => {
		let called = false;
		const reindex = makeReadOnlyReindex((async () => { called = true; return new Response("{}"); }) as typeof fetch);
		await expect(reindex(ep({ endpoint_id: "x", method: "POST" }))).rejects.toThrow(/non-safe method POST/);
		expect(called).toBe(false); // the request was never issued
	});
});

describe("startTrustRefreshIfEnabled", () => {
	it("is a no-op (null) when the flag is off — wallet/network untouched", async () => {
		delete process.env.UNBROWSE_TRUST_REFRESH;
		expect(await startTrustRefreshIfEnabled()).toBeNull();
	});
});
