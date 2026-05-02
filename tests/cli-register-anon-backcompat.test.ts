// Backwards-compat smoke for `unbrowse register` WITHOUT --email.
//
// Pairs with the parallel agent's --email branch landing in src/cli.ts /
// src/client/index.ts. Proves the existing anon flow still works exactly as
// before: ubr_<48hex> key minted, persisted to ~/.unbrowse, no key2user row,
// distinct keys/ids on second register, /v1/agents/me lookup returns 200
// against the real backend Hono app running in-process.
//
// Strategy (mirrors tests/cli-magic-register-e2e.test.ts):
//   - Boot the real backend Hono app (backend/src/index.ts).
//   - Stub globalThis.fetch so:
//       * BACKEND_TEST_HOST -> route through app.fetch(req, env)
//       * api.emergentdb.com -> in-memory KV
//       * /v1/telemetry/* -> 200 (best-effort, not a SUT here)
//       * api.resend.com (defensive) -> mark called=true so we can assert NOT called
//   - Drive ensureRegistered({ promptForEmail: false }) directly. cmdRegister
//     does the same when --no-prompt is set.
//   - Use UNBROWSE_AGENT_EMAIL=anon-test@example.com so resolveAgentName
//     accepts the value (resolveAgentName falls back to a hostname-rand
//     default for any non-email input).
//   - Disable local wallet discovery — otherwise getLocalWalletContext() reads
//     ~/.lobster/agents.json on the host, two anon registers try to claim the
//     same wallet, and the backend rejects the second with wallet_already_claimed.
//
// NEVER mocks internal SUT — only the network boundary (globalThis.fetch).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const BACKEND_TEST_HOST = "http://localhost-test";

// IMPORTANT: set env BEFORE importing the client module — API_URL is captured
// at module load time in src/client/index.ts.
process.env.UNBROWSE_BACKEND_URL = BACKEND_TEST_HOST;
process.env.UNBROWSE_LOCAL_ONLY = "0";
process.env.UNBROWSE_NON_INTERACTIVE = "1";
process.env.UNBROWSE_TOS_ACCEPTED = "1";
process.env.UNBROWSE_DISABLE_LOCAL_WALLET = "1";

const { app: backendApp } = await import("../backend/src/index.js");
const { clearKVCacheForTests } = await import("../backend/src/services/kv.js");
const clientMod = await import("../src/client/index.js");
type AnyApp = typeof backendApp;

const ANON_EMAIL = "anon-test@example.com";

const baseEnv: any = {
  API_KEY: "admin-not-used",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as any,
  ENVIRONMENT: "production",
  TURBOBOX_URL: "http://turbobox.local",
  R2_BUCKET: {} as any,
  FAL_KEY: "fal",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Unbrowse <auth@auth.unbrowse.ai>",
  PUBLIC_API_URL: BACKEND_TEST_HOST,
};

let originalFetch: typeof fetch;
let kvStore: Map<string, string>;
let resendCalled: boolean;
let app: AnyApp;
let configDir: string;
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_LOG = console.log;
const ORIGINAL_WARN = console.warn;

function makeFetch(store: Map<string, string>, appRef: { value: AnyApp }, envRef: { value: any }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;

    if (urlStr.startsWith(BACKEND_TEST_HOST)) {
      const url = new URL(urlStr);
      if (url.pathname.startsWith("/v1/telemetry/")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const req = new Request(urlStr, init as any);
      return appRef.value.fetch(req, envRef.value);
    }

    const url = new URL(urlStr);

    if (url.hostname === "api.emergentdb.com") {
      if (url.pathname === "/qdkv/set") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
        store.set(body.key, body.value);
        return Response.json({ ok: true });
      }
      if (url.pathname.startsWith("/qdkv/get/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
        const value = store.get(key);
        return Response.json(value == null ? { found: false, value: null } : { found: true, value });
      }
      if (url.pathname.startsWith("/qdkv/del/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
        store.delete(key);
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    }

    if (url.hostname === "api.resend.com") {
      resendCalled = true;
      return new Response(JSON.stringify({ id: "should-not-be-called" }), { status: 200 });
    }

    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
}

const appRef: { value: AnyApp } = { value: null as any };
const envRef: { value: any } = { value: baseEnv };

function freshConfigDir(prefix = "unbrowse-anon-back-"): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const dir = join(home, ".unbrowse");
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  kvStore = new Map();
  resendCalled = false;
  app = backendApp;
  appRef.value = app;
  envRef.value = { ...baseEnv };
  globalThis.fetch = makeFetch(kvStore, appRef, envRef);
  clearKVCacheForTests();

  configDir = freshConfigDir();
  process.env.UNBROWSE_CONFIG_DIR = configDir;
  delete process.env.UNBROWSE_API_KEY;
  process.env.UNBROWSE_AGENT_EMAIL = ANON_EMAIL;
  process.env.UNBROWSE_NON_INTERACTIVE = "1";
  process.env.UNBROWSE_TOS_ACCEPTED = "1";
  process.env.UNBROWSE_DISABLE_LOCAL_WALLET = "1";
  delete process.env.LOBSTER_WALLET_ADDRESS;
  delete process.env.AGENT_WALLET_ADDRESS;
  delete process.env.AGENT_WALLET_PROVIDER;
  console.log = () => {};
  console.warn = () => {};
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearKVCacheForTests();
  console.log = ORIGINAL_LOG;
  console.warn = ORIGINAL_WARN;
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    process.env[k] = v;
  }
});

const KEY_RE = /^ubr_[0-9a-f]{48}$/;
const AGENT_ID_RE = /^[0-9a-f]{32}$/;

function loadSavedConfig(dir: string = configDir): Record<string, unknown> {
  const raw = readFileSync(join(dir, "config.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function key2userRows(): string[] {
  return [...kvStore.keys()].filter((k) => k.includes(":key2user:"));
}

function acctOrUidRows(): string[] {
  return [...kvStore.keys()].filter((k) => k.includes(":acct:") || k.includes(":uid:"));
}

describe("cli register anon backwards-compat (no --email path)", () => {
  it("1. anon register without --email completes and saves a ubr_<48hex> key; Resend NOT called", async () => {
    await clientMod.ensureRegistered({ promptForEmail: false, exitOnFailure: false });

    const cfg = loadSavedConfig();
    expect(typeof cfg.api_key).toBe("string");
    expect(cfg.api_key as string).toMatch(KEY_RE);
    expect(typeof cfg.agent_id).toBe("string");
    expect(cfg.agent_id as string).toMatch(AGENT_ID_RE);
    expect(resendCalled).toBe(false);
  });

  it("2. anon register persists agent_name = the resolved env input (no --email branch ran)", async () => {
    await clientMod.ensureRegistered({ promptForEmail: false, exitOnFailure: false });

    const cfg = loadSavedConfig();
    // promptForEmail=false -> resolveAgentName(UNBROWSE_AGENT_EMAIL, fallback)
    // returns the env value when it's email-shaped. This is the existing
    // (pre-`--email` branch) behaviour we are protecting from regressions.
    expect(cfg.agent_name).toBe(ANON_EMAIL);
  });

  it("3. subsequent /v1/agents/me lookup with the new key returns 200 and the agent_id", async () => {
    await clientMod.ensureRegistered({ promptForEmail: false, exitOnFailure: false });

    const cfg = loadSavedConfig();
    const newKey = cfg.api_key as string;
    const expectedAgentId = cfg.agent_id as string;

    const res = await app.fetch(
      new Request(`${BACKEND_TEST_HOST}/v1/agents/me`, {
        headers: { Authorization: `Bearer ${newKey}` },
      }),
      envRef.value,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent_id: string; name: string };
    expect(body.agent_id).toBe(expectedAgentId);
    expect(body.name).toBe(ANON_EMAIL);
  });

  it("4. no key2user: row (and no acct:/uid: rows) are created for an anon register", async () => {
    await clientMod.ensureRegistered({ promptForEmail: false, exitOnFailure: false });

    expect(key2userRows()).toEqual([]);
    expect(acctOrUidRows()).toEqual([]);

    const keyhashRows = [...kvStore.keys()].filter((k) => k.includes(":keyhash:"));
    expect(keyhashRows.length).toBeGreaterThanOrEqual(1);
  });

  it("5. two separate anon registers create two distinct agent_ids and api_keys; no acct:/uid: rows", async () => {
    // First register in this test's isolated config dir.
    await clientMod.ensureRegistered({ promptForEmail: false, exitOnFailure: false });
    const firstDir = configDir;
    const first = loadSavedConfig(firstDir);
    expect(first.api_key as string).toMatch(KEY_RE);

    // Second register: NEW config dir, clear env api key the first one set.
    const secondDir = freshConfigDir("unbrowse-anon-back-2-");
    process.env.UNBROWSE_CONFIG_DIR = secondDir;
    delete process.env.UNBROWSE_API_KEY;
    configDir = secondDir;

    await clientMod.ensureRegistered({ promptForEmail: false, exitOnFailure: false });
    const second = loadSavedConfig(secondDir);

    expect(first.api_key).not.toBe(second.api_key);
    expect(first.agent_id).not.toBe(second.agent_id);
    expect(first.api_key as string).toMatch(KEY_RE);
    expect(second.api_key as string).toMatch(KEY_RE);

    expect(acctOrUidRows()).toEqual([]);
    expect(key2userRows()).toEqual([]);
  });
});
