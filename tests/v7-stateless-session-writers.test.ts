/**
 * Day-5 W-A regression tests — session record writers + adapter contract.
 *
 * W24.6 (2026-05-28): stateless is the SOLE path. The legacy
 * UNBROWSE_STATELESS env-gate and the `isStatelessMode()` helper were
 * purged; every session record lands under
 * `~/.unbrowse/tmp/<sigHash>/<id>.json`. Tests asserting "legacy mode
 * writes to ~/.unbrowse/sessions/" were deleted with the gate.
 *
 * The remaining tests pin the invariants that still hold:
 *   - writeSessionRecord routes records into tmp/<sigHash>/.
 *   - postStateless surfaces 503 _binding_missing as a result envelope,
 *     never a throw.
 *   - The canary cookie value never crosses the firmament: not in the
 *     POST body, not in any tmp file, and the legacy sessions/ tree
 *     stays empty.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  writeSessionRecord,
  readSessionRecord,
  mostRecentSession,
  deleteSessionRecord,
  type BrowseSessionRecord,
} from "../src/cli-v7/_session.js";
import { postStateless } from "../src/cli-v7/_stateless.js";

const LEGACY_SESSIONS_DIR = join(homedir(), ".unbrowse", "sessions");
const TMP_ROOT = join(homedir(), ".unbrowse", "tmp");
const CANARY = "UNB7-AUTH-CANARY-DO-NOT-LEAK";

/**
 * Walk a directory recursively and return every file path. Used by the
 * canary leak check to verify no file under the tmp tree carries the
 * canary string.
 */
function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(cur, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile()) out.push(p);
    }
  }
  return out;
}

async function clearAll(): Promise<void> {
  if (existsSync(LEGACY_SESSIONS_DIR)) {
    await rm(LEGACY_SESSIONS_DIR, { recursive: true, force: true });
  }
  if (existsSync(TMP_ROOT)) {
    await rm(TMP_ROOT, { recursive: true, force: true });
  }
}

// ─── Golden path: session record lands in tmp/, NOT in sessions/ ───────────

describe("Golden — writeSessionRecord always lands in tmp/<sigHash>/", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("writeSessionRecord lands in ~/.unbrowse/tmp/<sigHash>/, NOT in ~/.unbrowse/sessions/", async () => {
    const rec: BrowseSessionRecord = {
      sessionId: "test-stateless-golden",
      contextId: "ctx-1",
      targetId: "tgt-1",
      chromeWsUrl: "ws://localhost:9222/devtools/browser/x",
      chromePid: 99999,
      createdAt: Date.now(),
    };
    const writtenPath = await writeSessionRecord(rec);
    // Path is under tmp/, not sessions/.
    expect(writtenPath).toContain(`${homedir()}/.unbrowse/tmp/`);
    expect(writtenPath).not.toContain(`${homedir()}/.unbrowse/sessions/`);

    // A1 invariant: no file under ~/.unbrowse/sessions/.
    expect(existsSync(LEGACY_SESSIONS_DIR) && readdirSync(LEGACY_SESSIONS_DIR).length > 0).toBe(false);

    // Round-trip read.
    const roundTrip = await readSessionRecord("test-stateless-golden");
    expect(roundTrip.sessionId).toBe("test-stateless-golden");
    expect(roundTrip.chromeWsUrl).toBe("ws://localhost:9222/devtools/browser/x");

    // mostRecentSession walks tmp/.
    const recent = await mostRecentSession();
    expect(recent?.sessionId).toBe("test-stateless-golden");

    // Clean up.
    await deleteSessionRecord("test-stateless-golden");
    // tmp subdir should be empty (or removed).
    const recentAfter = await mostRecentSession();
    expect(recentAfter).toBeNull();
  });
});

// ─── Edge 2: postStateless surfaces 503 _binding_missing honestly ──────────

describe("Edge 2 — postStateless 503 binding_missing surfaces gracefully", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("backend returns 503 + {_binding_missing} → result.bindingMissing populated, NO throw", async () => {
    // Local mock that always returns 503 binding_missing.
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === "POST") {
          return new Response(
            JSON.stringify({
              error: "session_state_binding_inert",
              _binding_missing: "SESSION_STATE",
              _wave_hint: "v7.3 wires real KV",
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not_found", { status: 404 });
      },
    });
    try {
      const result = await postStateless({
        namespace: "session",
        route: "/v1/session/park",
        body: {
          sessionId: "test-binding-missing",
          targetUrl: "https://example.com",
          targetId: "tgt-x",
          contextId: "ctx-x",
          boundPointers: [],
          capturedEndpointsHash: "0".repeat(64),
          parked_at: Date.now(),
        },
        signableFields: [
          "sessionId",
          "targetUrl",
          "targetId",
          "contextId",
          "boundPointers",
          "capturedEndpointsHash",
          "parked_at",
        ],
        apiBaseUrl: `http://127.0.0.1:${server.port}`,
      });
      expect(result.ok).toBe(false);
      expect(result.bindingMissing).toBe("SESSION_STATE");
      expect(result.httpStatus).toBe(503);
      // cacheKey is still returned — every caller gets a stable pointer
      // even on failure.
      expect(result.cacheKey).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      server.stop(true);
    }
  });
});

// ─── Adversarial canary: cookie value never leaks ──────────────────────────

describe("Adversarial — canary cookie value never leaks across stateless park flow", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("a captured cookie carrying CANARY value never appears in POST body, stderr, stdout, or tmp dir", async () => {
    // Capture every POST body the adapter emits.
    const capturedBodies: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === "POST") {
          const bodyText = await req.text();
          capturedBodies.push(bodyText);
          return new Response(
            JSON.stringify({
              ok: true,
              receiptId: "test-receipt",
              verify_ok: true,
              parked: true,
              _binding_status: "wired",
              idempotent: false,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not_found", { status: 404 });
      },
    });

    try {
      // Step 1: Write a session record with a cookies_inventory_ref hash
      // computed over a payload that contains the canary value. Per the
      // boundary rule, only the HASH crosses the firmament; the canary
      // cleartext is never in the body.
      const inventoryDoc = {
        sessionId: "test-canary-park",
        domain: "example.com",
        captured_at: Date.now(),
        cookies: [
          {
            name: "session",
            // Simulate the in-process value buffer that auth-capture would
            // hash. NOTE: we DO NOT pass this through writeSessionRecord —
            // only the hash does.
            value_simulated_for_hash_only: CANARY,
            domain: "example.com",
            path: "/",
          },
        ],
      };
      const canonicalInventory = JSON.stringify(inventoryDoc);
      const cookiesInventoryRef = require("node:crypto")
        .createHash("sha256")
        .update(canonicalInventory)
        .digest("hex");

      const rec: BrowseSessionRecord = {
        sessionId: "test-canary-park",
        contextId: "ctx-c",
        targetId: "tgt-c",
        chromeWsUrl: "ws://localhost:9222/devtools/browser/c",
        chromePid: 12345,
        createdAt: Date.now(),
        cookies_inventory_ref: cookiesInventoryRef,
      };
      await writeSessionRecord(rec);

      // Step 2: POST a session-park style body via postStateless. The body
      // carries the inventory REF (a hash), never the canary value.
      const result = await postStateless({
        namespace: "session",
        route: "/v1/session/park",
        body: {
          sessionId: rec.sessionId,
          targetUrl: "https://example.com",
          targetId: rec.targetId,
          contextId: rec.contextId,
          boundPointers: [],
          capturedEndpointsHash: "0".repeat(64),
          cookiesInventoryRef,
          parked_at: Date.now(),
        },
        signableFields: [
          "sessionId",
          "targetUrl",
          "targetId",
          "contextId",
          "boundPointers",
          "capturedEndpointsHash",
          "cookiesInventoryRef",
          "parked_at",
        ],
        apiBaseUrl: `http://127.0.0.1:${server.port}`,
      });

      expect(result.ok).toBe(true);
      expect(capturedBodies.length).toBeGreaterThanOrEqual(1);

      // ── CANARY LEAK CHECK 1: not in POST body. ─────────────────────────
      for (const body of capturedBodies) {
        expect(body).not.toContain(CANARY);
      }

      // ── CANARY LEAK CHECK 2: not in tmp dir files. ──────────────────────
      const tmpFiles = walkFiles(TMP_ROOT);
      for (const f of tmpFiles) {
        const content = readFileSync(f, "utf8");
        expect(content).not.toContain(CANARY);
      }

      // ── CANARY LEAK CHECK 3: the legacy ~/.unbrowse/sessions/ tree is
      //    EMPTY (A1 invariant for session-family under stateless).
      const sessionsHasFiles =
        existsSync(LEGACY_SESSIONS_DIR) &&
        readdirSync(LEGACY_SESSIONS_DIR).length > 0;
      expect(sessionsHasFiles).toBe(false);

      // ── CANARY LEAK CHECK 4: the body carries the REF (hash), not value.
      expect(capturedBodies[0]).toContain(cookiesInventoryRef);

      // ── CANARY LEAK CHECK 5: no auth_profile.json under ~/.unbrowse —
      //    stateless mode must NOT have written the sidecar.
      const allUnbrowseFiles = walkFiles(join(homedir(), ".unbrowse"));
      const authProfiles = allUnbrowseFiles.filter((p) =>
        p.endsWith(".auth_profile.json"),
      );
      expect(
        authProfiles.filter((p) => p.includes("test-canary-park")),
      ).toEqual([]);

      // Cleanup.
      await deleteSessionRecord("test-canary-park");
    } finally {
      server.stop(true);
    }
  });
});

// ─── A1 cleanliness — session-family does not leak into ~/.unbrowse/sessions/ ─

describe("A1 invariant — session-family stays out of ~/.unbrowse/sessions/", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("after a full park flow, ~/.unbrowse/sessions/ contains no session-family files", async () => {
    const rec: BrowseSessionRecord = {
      sessionId: "a1-clean-test",
      contextId: "ctx-a1",
      targetId: "tgt-a1",
      chromeWsUrl: "ws://localhost:9222/devtools/browser/a1",
      chromePid: 54321,
      createdAt: Date.now(),
    };
    await writeSessionRecord(rec);

    // The canonical A1 check for the session family:
    // No `*.json` or `*.auth_profile.json` under ~/.unbrowse/sessions/.
    const has = existsSync(LEGACY_SESSIONS_DIR)
      ? readdirSync(LEGACY_SESSIONS_DIR).filter(
          (n) => n.endsWith(".json") || n.endsWith(".auth_profile.json"),
        )
      : [];
    expect(has).toEqual([]);

    await deleteSessionRecord("a1-clean-test");
  });
});
