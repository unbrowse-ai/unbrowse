/**
 * hole-template — "expose ONLY the holes to fill." Proves the backend can hand
 * the client a request SKELETON + a typed list of holes (auth from vault, params
 * from its LLM) carrying NO secret, and the client fills the holes locally back
 * into a concrete request. The wire exposes the shape and what to fill — nothing
 * more (the user's "we only EXPOSE what is needed to the client like the holes").
 */
import { describe, it, expect } from "bun:test";
import { obfuscateCaptureForReveng } from "../src/capture/obfuscate.js";
import { extractHoles, fillHoles } from "../src/capture/hole-template.js";
import type { RawRequest } from "../src/capture/index.js";

const WALLET = "8xKpQ2rZvN1mYwTcLdGhJ4sBnEfAuVoPxRgQ7WkMnHj";
const SECRETS = {
	bearer: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_secret",
	apiKey: "sk-proj-AbCdEf0123456789",
	password: "hunter2-very-secret",
	uuid: "550e8400-e29b-41d4-a716-446655440000",
};

const RAW: RawRequest = {
	url: `https://api.example.com/v1/users/${SECRETS.uuid}/orders?api_key=${SECRETS.apiKey}&page=2`,
	method: "POST",
	request_headers: { authorization: `Bearer ${SECRETS.bearer}`, "content-type": "application/json" },
	request_body: JSON.stringify({ password: SECRETS.password, item_id: 42 }),
	response_status: 200,
	response_headers: { "content-type": "application/json" },
	response_body: JSON.stringify({ order_id: 7788 }),
	timestamp: "2026-06-02T00:00:00Z",
};

// The backend revengs the OBFUSCATED capture (secrets already stripped + bound).
const [obfuscated] = obfuscateCaptureForReveng([RAW], { walletPubkey: WALLET });

describe("extractHoles — expose only the holes, never the secrets", () => {
	const template = extractHoles(obfuscated!);

	it("the skeleton carries NO secret value", () => {
		const blob = JSON.stringify(template.skeleton);
		for (const s of Object.values(SECRETS)) expect(blob).not.toContain(s);
		expect(blob).not.toContain("hunter2");
		expect(blob).not.toContain("sk-proj-");
	});

	it("names exactly the slots to fill — auth header, api_key query, password body, the path id", () => {
		const names = template.holes.map((h) => h.name).sort();
		expect(names).toContain("authorization");
		expect(names).toContain("api_key");
		expect(names).toContain("password");
		// the uuid path segment became an {id} hole
		expect(template.holes.some((h) => h.location.in === "path" && h.kind === "id")).toBe(true);
	});

	it("each secret hole is typed vault-fill and carries its wallet-binding", () => {
		const auth = template.holes.find((h) => h.name === "authorization")!;
		expect(auth.kind).toBe("secret");
		expect(auth.fill).toBe("vault");
		expect(auth.bound).toMatch(/^\[bound:[0-9a-f]{16}\]$/); // bound to the wallet
		expect(auth.location).toEqual({ in: "header", name: "authorization" });
		const id = template.holes.find((h) => h.kind === "id")!;
		expect(id.fill).toBe("llm"); // free identifier the agent fills
	});

	it("the holes list itself leaks no secret — only names, kinds, locations, bindings", () => {
		const blob = JSON.stringify(template.holes);
		for (const s of Object.values(SECRETS)) expect(blob).not.toContain(s);
	});
});

describe("fillHoles — the client fills locally from vault + llm", () => {
	const template = extractHoles(obfuscated!);

	it("reconstructs a concrete request with the real values in the right slots", () => {
		const filled = fillHoles(template, {
			authorization: `Bearer ${SECRETS.bearer}`, // from vault
			api_key: SECRETS.apiKey, // from vault
			password: SECRETS.password, // from vault
			"path[3]": "ORDER-123", // from llm (the id slot)
		});
		expect(filled.request_headers.authorization).toBe(`Bearer ${SECRETS.bearer}`);
		expect(filled.url).toContain(`api_key=${encodeURIComponent(SECRETS.apiKey)}`);
		expect(filled.url).toContain("ORDER-123"); // path id filled
		expect(JSON.parse(filled.request_body!).password).toBe(SECRETS.password);
		// structure preserved
		expect(filled.method).toBe("POST");
		expect(JSON.parse(filled.request_body!).item_id).toBe(42);
		expect(filled.url).toContain("page=2");
	});

	it("an unfilled hole is left visible as its placeholder (never silently blanked)", () => {
		const partial = fillHoles(template, { authorization: "Bearer X" });
		// api_key not provided → its bound placeholder remains in the url
		expect(partial.url).toMatch(/api_key=(\[REDACTED\]|\[bound:|%5[Bb])/i);
		expect(partial.request_headers.authorization).toBe("Bearer X");
	});

	it("does not mutate the template skeleton", () => {
		const before = JSON.stringify(template.skeleton);
		fillHoles(template, { authorization: "Bearer X" });
		expect(JSON.stringify(template.skeleton)).toBe(before);
	});
});
