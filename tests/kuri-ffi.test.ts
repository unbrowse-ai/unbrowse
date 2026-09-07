import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { suffix } from "bun:ffi";
import { kuriFfiAvailable, kuriFetch } from "../src/kuri/ffi.js";

const devLib = join(process.cwd(), "submodules/kuri/zig-out/lib", `libkuri_ffi.${suffix}`);
const haveLib = existsSync(devLib);

describe("kuri FFI stateless embed", () => {
	it("is graceful when the lib is absent (never throws)", () => {
		// kuriFfiAvailable must answer boolean and kuriFetch must return null (not throw)
		// regardless of whether the platform lib is present.
		expect(typeof kuriFfiAvailable()).toBe("boolean");
		expect(() => kuriFetch("https://example.com")).not.toThrow();
	});

	// The live path only runs where the dev-built lib exists (CI vendors it
	// per-platform; locally it's the zig-out build). Skipped otherwise so the
	// suite stays green on platforms without the lib.
	it.skipIf(!haveLib)("fetches + renders a real page in-process, no daemon", () => {
		expect(kuriFfiAvailable()).toBe(true);
		const md = kuriFetch("https://example.com", "markdown");
		expect(md).toBeString();
		expect(md!.toLowerCase()).toContain("example domain");
		const html = kuriFetch("https://example.com", "html");
		expect(html).toBeString();
		expect(html!.toLowerCase()).toContain("<html");
	});

	it.skipIf(!haveLib)("returns null for a blocked/invalid URL (SSRF guard), no throw", () => {
		expect(kuriFetch("http://127.0.0.1:1/")).toBeNull(); // localhost blocked by validator
		expect(kuriFetch("not-a-url")).toBeNull();
	});
});
