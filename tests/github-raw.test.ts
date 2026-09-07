/**
 * github-raw — for a github code-file /blob/ URL, extraction should pull the
 * clean raw file (the authoritative content), not the chrome-heavy rendered
 * page. Proves the blob→raw transform is correct + scoped to file views, and
 * (real data) that the raw source IS the clean file content the rendered page
 * only partially recovers (the d51 structured-file gap).
 */
import { describe, it, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { githubBlobToRaw, isGithubBlob } from "../src/extraction/github-raw.js";

describe("githubBlobToRaw — blob view → raw file", () => {
	it("maps a code-file blob URL to its raw.githubusercontent equivalent", () => {
		expect(githubBlobToRaw("https://github.com/nodejs/node/blob/main/doc/api/net.md")).toBe(
			"https://raw.githubusercontent.com/nodejs/node/main/doc/api/net.md",
		);
		expect(githubBlobToRaw("https://github.com/googleapis/googleapis/blob/master/google/cloud/billing/v1/cloud_billing.proto")).toBe(
			"https://raw.githubusercontent.com/googleapis/googleapis/master/google/cloud/billing/v1/cloud_billing.proto",
		);
		expect(githubBlobToRaw("https://github.com/rive-app/rive-docs/blob/main/docs.json")).toBe(
			"https://raw.githubusercontent.com/rive-app/rive-docs/main/docs.json",
		);
	});

	it("returns null for non-file github views (PRs, issues, tree, commits) — no single raw file", () => {
		expect(githubBlobToRaw("https://github.com/nodejs/node/pull/12345")).toBeNull();
		expect(githubBlobToRaw("https://github.com/nodejs/node/issues/99")).toBeNull();
		expect(githubBlobToRaw("https://github.com/nodejs/node/tree/main/doc")).toBeNull();
		expect(githubBlobToRaw("https://github.com/nodejs/node")).toBeNull();
		expect(isGithubBlob("https://github.com/nodejs/node/tree/main")).toBe(false);
	});

	it("returns null for non-github URLs", () => {
		expect(githubBlobToRaw("https://dev.to/some/article")).toBeNull();
		expect(githubBlobToRaw("https://example.com/blob/x")).toBeNull();
		expect(githubBlobToRaw("not a url")).toBeNull();
	});

	it("REAL: the raw source returns the clean file content (chrome-free)", () => {
		// the .json file that scored 0.53 on the rendered blob page extracts whole
		// from the raw URL — proving blob→raw closes the structured-file gap.
		const raw = githubBlobToRaw("https://github.com/rive-app/rive-docs/blob/main/docs.json")!;
		let body = "";
		try {
			body = execFileSync("curl", ["-sL", "--max-time", "20", raw], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
		} catch {
			return; // offline / transient — the transform is already proven above
		}
		if (!body.trim()) return; // network flake — don't fail the gate on it
		// a real JSON doc, not a github HTML shell
		expect(body).not.toContain("<!DOCTYPE html");
		expect(body.trimStart()[0]).toBe("{");
	});
});
