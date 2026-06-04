/**
 * stateless-mode — the unbrowse binary must hold NO local persisted state when
 * UNBROWSE_STATELESS=1: the suppressible local-disk writes are skipped (the
 * backend KV / sealed cache is the source of truth). Proves the isStateless()
 * gate and that the execution-trace write — a previously-unguarded local
 * ~/.unbrowse/traces write — leaves disk clean in stateless mode.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isStateless } from "../src/state/stateless.js";
import { storeExecutionTrace, type StoredTrace } from "../src/graph/trace-store.js";
import { recordSessionCreate, readActiveSessions, type PersistedSession } from "../src/api/session-store.js";

const TMP = join(tmpdir(), `unbrowse-stateless-test-${process.pid}`);

function trace(): StoredTrace {
	return {
		trace_id: "t1",
		domain: "example.com",
		intent: "do a thing",
		endpoint_sequence: ["e1"],
		params: {},
		success: true,
		timestamp: "2026-06-03T00:00:00Z",
	};
}

const SESS = join(tmpdir(), `unbrowse-stateless-sess-${process.pid}.jsonl`);

function session(): PersistedSession {
	return { sessionId: "s1", tabId: "t1", url: "https://example.com", domain: "example.com", harActive: false, ts: 1 };
}

afterEach(() => {
	delete process.env.UNBROWSE_STATELESS;
	delete process.env.UNBROWSE_TRACE_STORE_DIR;
	delete process.env.UNBROWSE_SESSION_STORE;
	rmSync(TMP, { recursive: true, force: true });
	rmSync(SESS, { force: true });
});

describe("isStateless", () => {
	it("is true only for UNBROWSE_STATELESS=1 or true", () => {
		delete process.env.UNBROWSE_STATELESS;
		expect(isStateless()).toBe(false);
		process.env.UNBROWSE_STATELESS = "1";
		expect(isStateless()).toBe(true);
		process.env.UNBROWSE_STATELESS = "true";
		expect(isStateless()).toBe(true);
		process.env.UNBROWSE_STATELESS = "0";
		expect(isStateless()).toBe(false);
	});
});

describe("execution-trace store respects stateless mode", () => {
	it("STATELESS=1: storeExecutionTrace writes NO local file (disk stays clean)", () => {
		process.env.UNBROWSE_TRACE_STORE_DIR = TMP;
		process.env.UNBROWSE_STATELESS = "1";
		storeExecutionTrace(trace());
		// the trace dir is never created and no jsonl is written
		const wrote = existsSync(TMP) && readdirSync(TMP).length > 0;
		expect(wrote).toBe(false);
	});

	it("normal mode: storeExecutionTrace DOES write the local trace (control)", () => {
		process.env.UNBROWSE_TRACE_STORE_DIR = TMP;
		delete process.env.UNBROWSE_STATELESS;
		storeExecutionTrace(trace());
		expect(existsSync(join(TMP, "example.com.jsonl"))).toBe(true);
	});

	it("STATELESS=1 leaves an existing dir untouched (no new files)", () => {
		process.env.UNBROWSE_TRACE_STORE_DIR = TMP;
		mkdirSync(TMP, { recursive: true });
		process.env.UNBROWSE_STATELESS = "1";
		storeExecutionTrace(trace());
		expect(readdirSync(TMP).length).toBe(0);
	});
});

describe("session store respects stateless mode", () => {
	it("STATELESS=1: recordSessionCreate writes NO local sessions.jsonl, reads degrade to []", () => {
		process.env.UNBROWSE_SESSION_STORE = SESS;
		process.env.UNBROWSE_STATELESS = "1";
		recordSessionCreate(session());
		expect(existsSync(SESS)).toBe(false);
		expect(readActiveSessions()).toEqual([]); // no rehydration, graceful
	});

	it("normal mode: recordSessionCreate persists + rehydrates (control)", () => {
		process.env.UNBROWSE_SESSION_STORE = SESS;
		delete process.env.UNBROWSE_STATELESS;
		recordSessionCreate(session());
		expect(existsSync(SESS)).toBe(true);
		expect(readActiveSessions().map((s) => s.sessionId)).toContain("s1");
	});
});
