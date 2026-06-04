/**
 * Walk UNBROWSE.md in the code: the minimal 10-atom internet primitive.
 * Every atom settled by a real assertion on real Web Crypto (no mocks).
 */
import { test, expect, describe } from "bun:test";
import {
	type RouteNode,
	verbOfKind,
	verbOfTool,
	identityToPubHex,
	receiptPtr,
	stateKey,
	sealNode,
	verifyNode,
	pickFetchRung,
	meter,
	tollNode,
} from "../src/route-seed.js";

async function freshWallet() {
	const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
	const pubHex = [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
	const sign = async (m: Uint8Array) =>
		new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, m));
	return { identity: `wallet:${pubHex}`, pubHex, sign };
}

describe("verb (how) — the three-verb river", () => {
	test("base prefix classifies build/act/eval", () => {
		expect(verbOfKind("build:skill")).toBe("build");
		expect(verbOfKind("actuate:navigate")).toBe("act");
		expect(verbOfKind("observe:snap")).toBe("eval");
		expect(verbOfKind("meter:toll")).toBe("build"); // the toll is a committed billable claim
		expect(verbOfKind("weird:thing")).toBe("act"); // unknown → routing default
	});
	test("tool name resolves via the one ROUTE_MAP", () => {
		expect(verbOfTool("unbrowse_health")).toBe("eval");
		expect(verbOfTool("unbrowse_go")).toBe("act");
		expect(verbOfTool("not_a_tool")).toBeUndefined();
	});
});

describe("root (who) — wallet identity parsing", () => {
	test("accepts wallet:, did:key:hex:, and bare 64-hex; rejects junk", () => {
		const hex = "a".repeat(64);
		expect(identityToPubHex(`wallet:${hex}`)).toBe(hex);
		expect(identityToPubHex(`did:key:hex:${hex}`)).toBe(hex);
		expect(identityToPubHex(hex.toUpperCase())).toBe(hex);
		expect(identityToPubHex("wallet:nothex")).toBeNull();
		expect(identityToPubHex("a".repeat(63))).toBeNull();
	});
});

describe("cache (when) — content address + identity-keyed state tree", () => {
	test("receiptPtr is deterministic, sha256:-prefixed, tamper-sensitive", async () => {
		const node: RouteNode = {
			kind: "actuate:navigate",
			params: { url: "https://example.com" },
			identity: "wallet:" + "b".repeat(64),
		};
		const a = await receiptPtr(node);
		const b = await receiptPtr({ ...node, params: { url: "https://example.com" } });
		const c = await receiptPtr({ ...node, params: { url: "https://evil.example" } });
		expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(a).toBe(b); // same structure → same key, always
		expect(a).not.toBe(c); // one changed param → different address
	});
	test("env vars are tree nodes keyed by identity", () => {
		const id = "wallet:" + "c".repeat(64);
		expect(stateKey(id, "env", "openai", "OPENAI_API_KEY")).toBe(
			`state:${id}/env/openai/OPENAI_API_KEY`,
		);
		expect(stateKey("c".repeat(64), "cookies", "example.com")).toBe(
			`state:wallet:${"c".repeat(64)}/cookies/example.com`,
		);
	});
});

describe("seal (how) — self-seal through the wallet root", () => {
	test("good node verifies; tamper and cross-wallet are rejected", async () => {
		const w = await freshWallet();
		const node: RouteNode = {
			kind: "actuate:navigate",
			params: { url: "https://example.com", walletPubkey: w.pubHex },
			identity: w.identity,
			witness: "",
		};
		const sealed = await sealNode(node, w.identity, w.sign);
		expect(sealed.signature).toMatch(/^[0-9a-f]{128}$/);
		expect(await verifyNode(sealed)).toBe(true);

		// tamper a param after signing → reject
		const tampered = { ...sealed, params: { ...sealed.params, url: "https://evil.example" } };
		expect(await verifyNode(tampered)).toBe(false);

		// cross-wallet guard: body wallet ≠ signer → reject
		const crossed = { ...sealed, params: { ...sealed.params, walletPubkey: "d".repeat(64) } };
		expect(await verifyNode(crossed)).toBe(false);

		// unsigned → reject
		expect(await verifyNode(node)).toBe(false);
	});
});

describe("verb (fetch ladder) — the kuri/Chromium rip-out", () => {
	test("Chromium is the last rung, curl-impersonate the default", () => {
		expect(pickFetchRung({})).toBe(0); // no signal → no browser
		expect(pickFetchRung({ jsChallenge: true })).toBe(1); // JS → StealthyFetcher
		expect(pickFetchRung({ turnstile: true })).toBe(1); // Turnstile → StealthyFetcher
		expect(pickFetchRung({ interactive: true })).toBe(2); // interactive → full CDP/kuri
		expect(pickFetchRung({ needsHar: true })).toBe(2); // deep HAR → full CDP/kuri
		expect(pickFetchRung({ jsChallenge: true, interactive: true })).toBe(2); // heaviest wins
	});
});

describe("toll (the 402 booth) — fair split that never leaks", () => {
	const SITE = "1".repeat(64);
	const OP = "2".repeat(64);
	const DISC = "3".repeat(64);
	const parties = { site: SITE, operator: OP, discoverer: DISC };

	test("meter splits with NO leakage — site absorbs the rounding remainder", () => {
		const out = meter({ amount: 1_000_000, operatorBps: 500, discovererBps: 1000 }, parties);
		const by = Object.fromEntries(out.map((p) => [p.role, p.amount]));
		expect(by.operator).toBe(50_000); // 5%
		expect(by.discoverer).toBe(100_000); // 10% — the first discoverer IS paid
		expect(by.site).toBe(850_000); // remainder
		expect(out.reduce((s, p) => s + p.amount, 0)).toBe(1_000_000); // exact, no value lost
	});

	test("meter never leaks a cent even with ugly rounding", () => {
		const out = meter({ amount: 1001, operatorBps: 500, discovererBps: 1000 }, parties);
		expect(out.reduce((s, p) => s + p.amount, 0)).toBe(1001);
		expect(out.every((p) => p.amount >= 0)).toBe(true);
	});

	test("meter refuses a negative amount and out-of-range bps", () => {
		expect(() => meter({ amount: -1, operatorBps: 0, discovererBps: 0 }, parties)).toThrow();
		expect(() => meter({ amount: 100, operatorBps: 9000, discovererBps: 2000 }, parties)).toThrow();
	});

	test("tollNode is a build-verb node that seals + verifies through the root", async () => {
		const w = await freshWallet();
		const n = tollNode(w.identity, "sha256:" + "ab".repeat(32), { amount: 200, operatorBps: 500, discovererBps: 1000 }, parties);
		expect(n.kind).toBe("meter:toll");
		expect(verbOfKind(n.kind)).toBe("build");
		expect(n.identity).toBe(w.identity);
		expect((n.params.payout as unknown[]).length).toBe(3);
		const sealed = await sealNode(n, w.identity, w.sign);
		expect(sealed.signature).toMatch(/^[0-9a-f]{128}$/);
		expect(await verifyNode(sealed)).toBe(true);
	});
});
