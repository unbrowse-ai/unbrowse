/**
 * Day-5 SWARM worker C — v7 stateless settings tests.
 *
 * Genesis 1:20 — *"let the waters bring forth abundantly."*
 *
 * Load-bearing invariants:
 *   T1 (golden)      `--set headless=literal:false` under stateless mode
 *                    POSTs a Day-3-shaped body to /v1/settings/set; read
 *                    back via --get returns the SAME pointer string.
 *   T2 (edge 1)      `--set api_key=raw_secret_value` (no scheme prefix)
 *                    rejects with exit 64 / `value_is_not_pointer`. The
 *                    backend mock NEVER receives a request.
 *   T3 (edge 2)      Backend returns 503 + `_binding_missing:
 *                    "SETTINGS_STATE"` → CLI writes a stash file under
 *                    `~/.unbrowse/tmp/<sigHash>/settings-stash.json` and
 *                    emits a stderr warning. Local settings.json is
 *                    NEVER written under UNBROWSE_STATELESS=1.
 *   T4 (adversarial) Canary in a `literal:` value: lands ONLY in the
 *                    `settingValuePointer` wire field. Never in error
 *                    messages, never in any other field, never in stderr
 *                    log lines outside the user's own emit.
 *
 *   Plus parity test for CLI-side POINTER_PREFIX_REGEX vs backend
 *   `isValidPointer`.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  POINTER_PREFIX_REGEX,
  deriveSettingKeyHash,
  rejectionReasonStateless,
  migrateLegacySettings,
} from "../src/cli-v7/eval/settings.js";

// ───────────────────────────────────────────────────────────────────────────
// Test harness — isolated $HOME + Bun.serve mock backend
// ───────────────────────────────────────────────────────────────────────────

interface CapturedReq {
  method: string;
  pathname: string;
  headers: Record<string, string>;
  bodyText: string;
  bodyJson: Record<string, unknown>;
}

interface MockBackend {
  url: string;
  captured: CapturedReq[];
  // For POST /v1/settings/set
  setPostResponse: (r: { status: number; body: Record<string, unknown> }) => void;
  // For GET /v1/settings/get/:keyHash
  setGetResponse: (r: { status: number; body: Record<string, unknown> }) => void;
  stop: () => Promise<void>;
}

function spinupBackend(): MockBackend {
  const captured: CapturedReq[] = [];
  let postResp: { status: number; body: Record<string, unknown> } = {
    status: 200,
    body: {
      ok: true,
      cacheKey: "0".repeat(32),
      keyHash: "0".repeat(32),
      verify_ok: true,
      idempotent: false,
      primaryKey: "settings:test:test",
      _binding_status: "wired",
    },
  };
  let getResp: { status: number; body: Record<string, unknown> } = {
    status: 404,
    body: { error: "setting_not_found", keyHash: "0".repeat(32) },
  };

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      const bodyText = req.method !== "GET" ? await req.text() : "";
      let bodyJson: Record<string, unknown> = {};
      try { bodyJson = bodyText ? JSON.parse(bodyText) : {}; } catch { /* */ }
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      captured.push({
        method: req.method,
        pathname: u.pathname,
        headers,
        bodyText,
        bodyJson,
      });

      if (req.method === "POST" && u.pathname === "/v1/settings/set") {
        return new Response(JSON.stringify(postResp.body), {
          status: postResp.status,
          headers: { "content-type": "application/json" },
        });
      }
      if (req.method === "GET" && u.pathname.startsWith("/v1/settings/get/")) {
        return new Response(JSON.stringify(getResp.body), {
          status: getResp.status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unknown_route", path: u.pathname }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    captured,
    setPostResponse: (r) => { postResp = r; },
    setGetResponse: (r) => { getResp = r; },
    stop: async () => { await server.stop(true); },
  };
}

/**
 * Spawn the CLI with isolated $HOME so settings.json + stash files
 * land in a temp dir and we can assert presence/absence cleanly.
 */
interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutJson?: Record<string, unknown>;
}

async function runCli(args: {
  cliArgs: string[];
  homeDir: string;
  backendUrl: string;
  stateless: boolean;
  extraEnv?: Record<string, string>;
}): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      ...process.env,
      HOME: args.homeDir,
      UNBROWSE_BACKEND_URL: args.backendUrl,
      UNBROWSE_API_URL: args.backendUrl,
      UNBROWSE_STATELESS: args.stateless ? "1" : "0",
      // Quiet down anything that might write to stderr unprompted.
      UNBROWSE_QUIET: "1",
      ...args.extraEnv,
    };
    // Use bun to drive src/cli-v7/index.ts directly. The handler chooses
    // its path based on UNBROWSE_STATELESS; the global binary is not on
    // PATH in this test environment.
    const child = spawn(
      "bun",
      ["run", "src/cli-v7/index.ts", "eval", "settings", ...args.cliArgs],
      {
        env,
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      let stdoutJson: Record<string, unknown> | undefined;
      try {
        stdoutJson = JSON.parse(stdout);
      } catch {
        // best-effort
      }
      resolve({ exitCode: code ?? -1, stdout, stderr, stdoutJson });
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────
// PARITY: POINTER_PREFIX_REGEX matches Day-3 backend isValidPointer
// ───────────────────────────────────────────────────────────────────────────

describe("Day-5 W-C: POINTER_PREFIX_REGEX parity", () => {
  it("accepts the six pointer schemes with non-empty body", () => {
    for (const p of [
      "literal:false",
      "literal:geo.iproyal.com:12321",
      "op://Vault/Item/field",
      "keychain://com.unbrowse/api-key",
      "bw://item-uuid",
      "arg://UNBROWSE_PROXY",
      "unbrowse://sponsor",
    ]) {
      expect(POINTER_PREFIX_REGEX.test(p)).toBe(true);
    }
  });
  it("REJECTS raw cleartext values without a scheme", () => {
    for (const p of [
      "false",
      "secret123",
      "Bearer eyJhbGc",
      "",
      "geo.iproyal.com:12321",
    ]) {
      expect(POINTER_PREFIX_REGEX.test(p)).toBe(false);
    }
  });
  it("REJECTS bare schemes with no payload", () => {
    for (const p of ["literal:", "op://", "keychain://", "bw://"]) {
      expect(POINTER_PREFIX_REGEX.test(p)).toBe(false);
    }
  });
  it("emits the EXACT regex source for ship-report", () => {
    expect(POINTER_PREFIX_REGEX.source).toBe(
      "^(literal:|op:\\/\\/|keychain:\\/\\/|bw:\\/\\/|arg:\\/\\/|unbrowse:\\/\\/).+$",
    );
  });
});

describe("Day-5 W-C: deriveSettingKeyHash byte parity vs backend shape", () => {
  it("derives a 32-char lowercase hex string", () => {
    const h = deriveSettingKeyHash("headless");
    expect(h.length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(h)).toBe(true);
  });
  it("is deterministic for a known fixture (sha256('headless')[:32])", () => {
    // sha256("headless") = 80fbb50d0afbe70d8d1fff6a25c39787...
    // First 32 hex chars are the keyHash.
    const h = deriveSettingKeyHash("headless");
    // Cross-check via Bun's built-in hasher rather than a hardcoded fixture
    // (avoids painted-lamp test failure modes).
    const ref = new Bun.CryptoHasher("sha256")
      .update("headless")
      .digest("hex")
      .slice(0, 32);
    expect(h).toBe(ref);
  });
});

describe("Day-5 W-C: rejectionReasonStateless gates", () => {
  it("accepts a well-formed pointer for a valid key", () => {
    expect(rejectionReasonStateless("headless", "literal:false")).toBeNull();
  });
  it("rejects an empty key", () => {
    expect(rejectionReasonStateless("", "literal:false")).toBe("missing_setting_key");
  });
  it("rejects a key with invalid chars", () => {
    expect(rejectionReasonStateless("hello world", "literal:false")).toBe("setting_key_invalid_chars");
  });
  it("rejects a value missing a scheme", () => {
    expect(rejectionReasonStateless("api_key", "raw_secret_value")).toBe("value_is_not_pointer");
  });
  it("rejects a bare scheme (no payload)", () => {
    expect(rejectionReasonStateless("api_key", "literal:")).toBe("value_is_not_pointer");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// End-to-end: settings handler under UNBROWSE_STATELESS=1
// ───────────────────────────────────────────────────────────────────────────

describe("Day-5 W-C: stateless --set / --get end-to-end", () => {
  let tmpHome: string;
  let backend: MockBackend;

  beforeEach(() => {
    tmpHome = join(
      process.env.TMPDIR ?? "/tmp",
      `unbrowse-settings-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    mkdirSync(join(tmpHome, ".unbrowse"), { recursive: true });
    backend = spinupBackend();
  });

  afterEach(async () => {
    try { await backend.stop(); } catch { /* */ }
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it("T1 golden: --set headless=literal:false POSTs Day-3 shape, --get reads back same pointer", async () => {
    // Capture the POST shape; setGetResponse will echo it back.
    backend.setPostResponse({
      status: 200,
      body: {
        ok: true,
        cacheKey: "a".repeat(32),
        keyHash: deriveSettingKeyHash("headless"),
        verify_ok: true,
        idempotent: false,
        primaryKey: `settings:test:${deriveSettingKeyHash("headless")}`,
        _binding_status: "wired",
      },
    });

    const setRun = await runCli({
      cliArgs: ["--set", "headless=literal:false", "--json"],
      homeDir: tmpHome,
      backendUrl: backend.url,
      stateless: true,
    });

    expect(setRun.exitCode).toBe(0);
    expect(backend.captured.length).toBe(1);
    const post = backend.captured[0];
    expect(post.method).toBe("POST");
    expect(post.pathname).toBe("/v1/settings/set");
    expect(post.bodyJson.settingKey).toBe("headless");
    expect(post.bodyJson.settingValuePointer).toBe("literal:false");
    expect(typeof post.bodyJson.walletPubkey).toBe("string");
    expect(typeof post.bodyJson.signature).toBe("string");
    expect(typeof post.bodyJson.nonce).toBe("string");
    expect(post.bodyJson.signatureScheme).toBe("ed25519-v7.0");

    // Local settings.json MUST NOT have been written in stateless mode.
    expect(existsSync(join(tmpHome, ".unbrowse", "settings.json"))).toBe(false);

    // Now read back via --get.
    backend.setGetResponse({
      status: 200,
      body: {
        ok: true,
        keyHash: deriveSettingKeyHash("headless"),
        row: {
          settingKey: "headless",
          settingValuePointer: "literal:false",
          received_at: Date.now(),
          cacheKey: "a".repeat(32),
          keyHash: deriveSettingKeyHash("headless"),
        },
        _binding_status: "wired",
      },
    });

    const getRun = await runCli({
      cliArgs: ["--get", "headless", "--json"],
      homeDir: tmpHome,
      backendUrl: backend.url,
      stateless: true,
    });

    expect(getRun.exitCode).toBe(0);
    expect(getRun.stdoutJson?.settingValuePointer).toBe("literal:false");
    expect(getRun.stdoutJson?.keyHash).toBe(deriveSettingKeyHash("headless"));

    // The GET request carried the WalletSig challenge headers.
    const getReq = backend.captured.find((c) => c.method === "GET");
    expect(getReq).toBeDefined();
    expect(getReq!.headers["authorization"]?.toLowerCase().startsWith("walletsig ")).toBe(true);
    expect(getReq!.headers["x-wallet-pubkey"]?.length).toBe(64);
    expect(typeof getReq!.headers["x-wallet-timestamp"]).toBe("string");
    expect(getReq!.pathname).toBe(`/v1/settings/get/${deriveSettingKeyHash("headless")}`);
  }, 30_000);

  it("T2 edge 1: --set api_key=raw_secret_value rejects with exit 64; backend never sees POST", async () => {
    const run = await runCli({
      cliArgs: ["--set", "api_key=raw_secret_value", "--json"],
      homeDir: tmpHome,
      backendUrl: backend.url,
      stateless: true,
    });

    expect(run.exitCode).toBe(64); // EX_USAGE
    expect(run.stdoutJson?.error).toBe("value_is_not_pointer");
    // The exact regex shipped is surfaced to the agent for next-step nudge.
    expect(run.stdoutJson?.pointer_prefix_regex).toBe(POINTER_PREFIX_REGEX.source);

    // CRITICAL: backend never received the POST.
    expect(backend.captured.length).toBe(0);

    // Local settings.json never touched.
    expect(existsSync(join(tmpHome, ".unbrowse", "settings.json"))).toBe(false);

    // The raw secret value is NOT echoed on stdout/stderr (defense in depth —
    // even though it never hit the wire, the rejection envelope must not
    // pretty-print the offending value).
    expect(run.stdout).not.toContain("raw_secret_value");
    expect(run.stderr).not.toContain("raw_secret_value");
  }, 30_000);

  it("T3 edge 2: 503 binding_missing writes stash file, NEVER touches settings.json", async () => {
    backend.setPostResponse({
      status: 503,
      body: {
        error: "settings_state_binding_missing",
        _binding_missing: "SETTINGS_STATE",
        cacheKey: "b".repeat(32),
        keyHash: deriveSettingKeyHash("default_proxy"),
        verify_ok: true,
        _wave_hint: "operator must wrangler kv:namespace create SETTINGS_STATE",
      },
    });

    const run = await runCli({
      cliArgs: ["--set", "default_proxy=literal:geo.iproyal.com:12321", "--json"],
      homeDir: tmpHome,
      backendUrl: backend.url,
      stateless: true,
    });

    expect(run.exitCode).not.toBe(0);
    expect(run.stdoutJson?.error).toBe("binding_missing");
    expect(run.stdoutJson?.binding_missing).toBe("SETTINGS_STATE");
    expect(typeof run.stdoutJson?.stash_path).toBe("string");
    expect(typeof run.stdoutJson?.cacheKey).toBe("string");

    // Stash directory: ~/.unbrowse/tmp/<cacheKey>/settings-stash.json
    const stashRoot = join(tmpHome, ".unbrowse", "tmp");
    expect(existsSync(stashRoot)).toBe(true);
    const stashPath = run.stdoutJson?.stash_path as string;
    expect(stashPath.startsWith(stashRoot)).toBe(true);
    expect(stashPath.endsWith("settings-stash.json")).toBe(true);
    expect(existsSync(stashPath)).toBe(true);

    const stashContents = JSON.parse(readFileSync(stashPath, "utf8")) as Record<string, unknown>;
    expect(stashContents.settingKey).toBe("default_proxy");
    expect(stashContents.settingValuePointer).toBe("literal:geo.iproyal.com:12321");
    expect(stashContents.reason).toBe("binding_missing");
    expect(stashContents.bindingMissing).toBe("SETTINGS_STATE");

    // stderr carried a warning (pointer-only, no value).
    expect(run.stderr).toContain("SETTINGS_STATE");
    expect(run.stderr).toContain("stashed");

    // Local settings.json MUST NOT exist (stateless never touches it).
    expect(existsSync(join(tmpHome, ".unbrowse", "settings.json"))).toBe(false);
  }, 30_000);

  it("T4 adversarial canary: literal: pointer carries canary on wire only, never leaks elsewhere", async () => {
    const CANARY = "UNB7-SETTINGS-CANARY-DO-NOT-LEAK";
    const pointer = `literal:${CANARY}`;
    const keyHash = deriveSettingKeyHash("notes");

    backend.setPostResponse({
      status: 200,
      body: {
        ok: true,
        cacheKey: "c".repeat(32),
        keyHash,
        verify_ok: true,
        idempotent: false,
        primaryKey: `settings:test:${keyHash}`,
        _binding_status: "wired",
      },
    });

    const run = await runCli({
      cliArgs: ["--set", `notes=${pointer}`, "--json"],
      homeDir: tmpHome,
      backendUrl: backend.url,
      stateless: true,
    });

    expect(run.exitCode).toBe(0);

    // CANARY IS expected on the wire — that's the literal:-scheme contract.
    expect(backend.captured.length).toBe(1);
    const post = backend.captured[0];
    expect(post.bodyJson.settingValuePointer).toBe(pointer);
    expect(post.bodyText).toContain(CANARY); // present in the JSON-serialized body

    // CANARY MUST land ONLY in the settingValuePointer field — not in any
    // other top-level field of the wire body.
    for (const [k, v] of Object.entries(post.bodyJson)) {
      if (k === "settingValuePointer") continue;
      if (typeof v === "string") {
        expect(v).not.toContain(CANARY);
      } else {
        expect(JSON.stringify(v)).not.toContain(CANARY);
      }
    }

    // CANARY MUST NOT appear in stderr (no log line outside the user's own emit).
    expect(run.stderr).not.toContain(CANARY);

    // CANARY appears in stdout because the success ack echoes `settingKey`
    // and key derivation; but the pointer string is the user's explicit emit
    // so its presence in the JSON ack is acceptable IF and ONLY IF it's
    // contained to the settingValuePointer-related fields. Verify the ack
    // does NOT carry an echo'd settingValuePointer (the success path emits
    // settingKey + keyHash + cacheKey, not the pointer itself).
    const stdoutJson = run.stdoutJson as Record<string, unknown>;
    // The ack envelope MUST NOT echo the pointer back on success — it carries
    // only pointers-to-pointers (keyHash, cacheKey, receiptId).
    expect(stdoutJson.settingValuePointer).toBeUndefined();
    // settingKey is fine — it's "notes", not the canary.
    expect(stdoutJson.settingKey).toBe("notes");
    // Verify the canary did NOT slip into any field of the success envelope.
    for (const [k, v] of Object.entries(stdoutJson)) {
      if (typeof v === "string") {
        expect(v).not.toContain(CANARY);
      } else if (v != null) {
        expect(JSON.stringify(v)).not.toContain(CANARY);
      }
    }
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// migrateLegacySettings — opt-in, NEVER auto-fired
// ───────────────────────────────────────────────────────────────────────────

describe("Day-5 W-C: migrateLegacySettings is opt-in and pointer-wraps values", () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let backend: MockBackend;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = join(
      process.env.TMPDIR ?? "/tmp",
      `unbrowse-migrate-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    mkdirSync(join(tmpHome, ".unbrowse"), { recursive: true });
    process.env.HOME = tmpHome;
    backend = spinupBackend();
    process.env.UNBROWSE_BACKEND_URL = backend.url;
    process.env.UNBROWSE_API_URL = backend.url;
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    delete process.env.UNBROWSE_BACKEND_URL;
    delete process.env.UNBROWSE_API_URL;
    try { await backend.stop(); } catch { /* */ }
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it("wraps each legacy value as literal:<value> and POSTs to /v1/settings/set", async () => {
    // Seed legacy file.
    const legacyPath = join(tmpHome, ".unbrowse", "settings.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({ headless: false, auth_capture_mode: "auto" }, null, 2),
      { mode: 0o600 },
    );

    backend.setPostResponse({
      status: 200,
      body: {
        ok: true,
        cacheKey: "d".repeat(32),
        keyHash: "0".repeat(32),
        verify_ok: true,
        idempotent: false,
        primaryKey: "settings:test:test",
        _binding_status: "wired",
      },
    });

    const out = await migrateLegacySettings(tmpHome);
    expect(out.attempted).toBe(2);
    expect(out.ok).toBe(2);
    expect(out.rejected).toBe(0);
    expect(out.stashed).toBe(0);

    // Two POSTs landed.
    expect(backend.captured.length).toBe(2);
    const posted = new Map(
      backend.captured.map((c) => [c.bodyJson.settingKey, c.bodyJson.settingValuePointer]),
    );
    expect(posted.get("headless")).toBe("literal:false");
    expect(posted.get("auth_capture_mode")).toBe("literal:auto");

    // CRITICAL: legacy file remains intact. Operator deletes it themselves.
    expect(existsSync(legacyPath)).toBe(true);
  });
});
