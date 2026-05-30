import { describe, expect, it } from "bun:test";
import { sealValue, verifyReveal, SealedCache } from "../src/trust/sealed-cache.js";

describe("sealValue — commit-reveal", () => {
	it("is deterministic for the same value+salt", async () => {
		expect(await sealValue({ a: 1 }, "salt-1")).toBe(await sealValue({ a: 1 }, "salt-1"));
		expect(await sealValue({ a: 1 }, "salt-1")).toStartWith("sha256:");
	});

	it("hides: same value under a different salt → different commitment", async () => {
		expect(await sealValue({ a: 1 }, "salt-1")).not.toBe(await sealValue({ a: 1 }, "salt-2"));
	});

	it("binds: different values under the same salt → different commitment", async () => {
		expect(await sealValue({ a: 1 }, "s")).not.toBe(await sealValue({ a: 2 }, "s"));
	});

	it("requires a non-empty salt (hiding depends on it)", async () => {
		await expect(sealValue({ a: 1 }, "")).rejects.toThrow(/salt/);
	});

	it("verifyReveal accepts the exact value+salt and rejects either being wrong", async () => {
		const c = await sealValue({ token: "secret-xyz", scope: "read" }, "nonce-42");
		expect(await verifyReveal(c, { token: "secret-xyz", scope: "read" }, "nonce-42")).toBe(true);
		expect(await verifyReveal(c, { token: "WRONG", scope: "read" }, "nonce-42")).toBe(false); // wrong value
		expect(await verifyReveal(c, { token: "secret-xyz", scope: "read" }, "nonce-99")).toBe(false); // wrong salt
	});
});

describe("SealedCache", () => {
	it("stores a commitment, not the value, and confirms membership", async () => {
		const cache = new SealedCache();
		const value = { user_id: 7, email: "a@b.com" };
		expect(cache.has("k")).toBe(false);
		const commitment = await cache.put("k", value, "salt", 100);
		expect(cache.has("k")).toBe(true);
		expect(cache.commitmentOf("k")).toBe(commitment);
		// the only thing retrievable is the commitment — it reveals nothing about `value`
		expect(cache.commitmentOf("k")).toStartWith("sha256:");
		expect(JSON.stringify(cache)).not.toContain("a@b.com");
		expect(cache.size).toBe(1);
	});

	it("reveals only the exact sealed value (binding), false on miss or mismatch", async () => {
		const cache = new SealedCache();
		await cache.put("route:abc", { schema: ["id", "name"] }, "secret-salt", 1);
		expect(await cache.reveal("route:abc", { schema: ["id", "name"] }, "secret-salt")).toBe(true);
		expect(await cache.reveal("route:abc", { schema: ["id"] }, "secret-salt")).toBe(false); // different value
		expect(await cache.reveal("route:abc", { schema: ["id", "name"] }, "wrong-salt")).toBe(false); // wrong salt
		expect(await cache.reveal("unknown-key", { schema: ["id", "name"] }, "secret-salt")).toBe(false); // unknown key
	});
});
