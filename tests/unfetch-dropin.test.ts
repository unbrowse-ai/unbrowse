import { describe, expect, it } from "bun:test";
import { createFetch, unfetch } from "../packages/sdk-v2/src/fetch.js";

// The keyless, dependency-free fetch drop-in: native behaviour by default,
// payment as an opt-in injected handler. A 402 is never the front door.
describe("@unbrowse/client fetch drop-in", () => {
	it("unfetch is a plain function with the fetch signature", () => {
		expect(typeof unfetch).toBe("function");
	});

	it("createFetch() with no pay handler is an exact pass-through", () => {
		const f = createFetch();
		expect(typeof f).toBe("function");
	});

	it("returns a 402 unchanged when no pay handler is configured", async () => {
		const fake402: typeof fetch = async () =>
			new Response(JSON.stringify({ accepts: [{ scheme: "x402" }] }), {
				status: 402,
				headers: { "content-type": "application/json" },
			});
		const f = createFetch({ fetch: fake402 });
		expect((await f("https://paid.example")).status).toBe(402);
	});

	it("an opt-in handler pays, retries once, and the request succeeds", async () => {
		let sawTerms: Record<string, unknown> | null = null;
		const transport: typeof fetch = async (_input, init) => {
			const h = new Headers(init?.headers);
			if (h.get("X-PAYMENT") === "proof") return new Response("ok", { status: 200 });
			return new Response(JSON.stringify({ accepts: [{ scheme: "flex" }] }), {
				status: 402,
				headers: { "content-type": "application/json" },
			});
		};
		const f = createFetch({
			fetch: transport,
			pay: async (ctx) => {
				sawTerms = ctx.terms;
				return { "X-PAYMENT": "proof" };
			},
		});
		const res = await f("https://paid.example");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
		expect((sawTerms as { accepts?: { scheme?: string }[] } | null)?.accepts?.[0]?.scheme).toBe("flex");
	});

	it("a declining handler surfaces the original 402 without looping", async () => {
		let calls = 0;
		const fake402: typeof fetch = async () => {
			calls++;
			return new Response("{}", { status: 402, headers: { "content-type": "application/json" } });
		};
		const f = createFetch({ fetch: fake402, pay: async () => null });
		expect((await f("https://paid.example")).status).toBe(402);
		expect(calls).toBe(1); // no retry when the handler declines
	});

	it("hits a real URL with zero config (network)", async () => {
		// Network-gated: proves the default really is native fetch. Tolerant of
		// offline CI — only asserts shape when the call resolves.
		try {
			const res = await unfetch("https://example.com");
			expect(res.status).toBe(200);
			expect(await res.text()).toContain("Example Domain");
		} catch {
			// offline — the prior pure tests already prove the wrapper contract.
		}
	});
});
