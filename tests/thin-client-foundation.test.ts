/**
 * End-to-end gate for the thin-client foundation (organ ddff0c96).
 *
 * Imports every public symbol declared by the three foundation files
 * (cloud routes, thin client, capability registry) and exercises the
 * surface against an in-memory dispatcher + fetch mock. Proves:
 *   - the wire shapes round-trip cleanly between client and server
 *   - the dispatcher loop pulls + posts capability results correctly
 *   - unknown capabilities surface clean errors, never silent degrade
 *
 * No mocks of the platform itself — the cloud route handlers run
 * against a real in-memory ContractLedger implementation declared in
 * this test. the platform principle ("harness collects, agent judges")
 * stays intact: this test checks shape + dispatch mechanics; semantic
 * verdicts are still the agent's job.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ContractEventRow,
  ContractLedger,
} from "../backend/src/services/contract-ledger";
import {
  handleDeclare,
  handleContractSurface,
  handleIterate,
  handlePlanForIntent,
  handleStatus,
} from "../backend/src/routes/contract";
import { bridgeManifest } from "../src/architecture/bridge-manifest";
import { createThinClient } from "../src/lib/contract-thin-client";
import {
  LOCAL_CAPABILITIES,
  createDispatcher,
} from "../src/lib/local-capabilities";

const ROOT = join(import.meta.dir, "..");
const AIKO_ROOT = "/Users/lekt9/Projects/unbrowse-ecosystem/aiko-engine";

/** Minimal in-memory ledger — the wire shape is what's being gated;
 *  persistence is not the subject of this test. */
function inMemoryLedger(): ContractLedger {
  const rows: ContractEventRow[] = [];
  return {
    async append(row) {
      const stamped = { ...row, ts: row.ts || new Date().toISOString() };
      rows.push(stamped);
      return stamped;
    },
    async get(id) {
      const hit = rows.filter((r) => r.id === id);
      return hit.length ? hit : null;
    },
    async listAll(_opts) {
      return rows.slice();
    },
    async listChildren(parentId) {
      return rows.filter((r) => r.parent_id === parentId);
    },
  };
}

describe("thin-client foundation — wire surface end-to-end", () => {
  test("declare returns an id + persisted row", async () => {
    const ledger = inMemoryLedger();
    const out = await handleDeclare(
      { plan: "test claim", action: "agent-judges" },
      ledger,
    );
    expect(out.id).toMatch(/^[0-9a-f]{8}$/);
    expect(out.row.event).toBe("declared");
    expect(out.row.plan).toBe("test claim");
    expect(out.row.pointer_type).toBe("agent-judges");
  });

  test("iterate appends a wave row + returns key2 prompt", async () => {
    const ledger = inMemoryLedger();
    const { id } = await handleDeclare(
      { plan: "iterate test", action: "agent-judges" },
      ledger,
    );
    const it = await handleIterate({ id }, ledger);
    expect(it.id).toBe(id);
    expect(it.wave).toBe(1);
    expect(it.key2_prompt).toContain("KEY 2");
    expect(Array.isArray(it.pending_local_steps)).toBe(true);
  });

  test("status reflects declare + iterate event chain", async () => {
    const ledger = inMemoryLedger();
    const { id } = await handleDeclare(
      { plan: "status test", action: "agent-judges" },
      ledger,
    );
    await handleIterate({ id }, ledger);
    const st = await handleStatus(id, ledger);
    expect(st.id).toBe(id);
    expect(st.rows.length).toBe(2);
    // No 'satisfied' row yet → status should be "active" (has iterated).
    expect(st.status).toBe("active");
  });

  test("plan-for-intent returns shortlist over satisfied cells", async () => {
    const ledger = inMemoryLedger();
    // Declare 2 cells, satisfy one of them, then search.
    const a = await handleDeclare(
      { plan: "auth_token producer", action: "agent-judges" },
      ledger,
    );
    await handleDeclare(
      { plan: "search results producer", action: "agent-judges" },
      ledger,
    );
    // Mark only `a` as satisfied — the search must find only it.
    await ledger.append({
      event: "satisfied",
      id: a.id,
      ts: new Date().toISOString(),
    });
    const plan = await handlePlanForIntent({ intent: "auth" }, ledger);
    expect(plan.matches.length).toBe(1);
    expect(plan.matches[0]?.id).toBe(a.id);
    expect(plan.matches[0]?.score).toBe(1.0);
  });

  test("local capability registry catalogues exactly 5 capabilities", () => {
    expect(LOCAL_CAPABILITIES).toEqual([
      "kuri",
      "cookies",
      "vault",
      "browser",
      "fs",
    ]);
  });

  test("dispatcher invokes registered capabilities + rejects unknown", async () => {
    const dispatcher = createDispatcher({
      kuri: async (payload) => ({ ran: "kuri", payload }),
      cookies: async () => ({ cookies: ["session=abc"] }),
    });

    expect(dispatcher.has("kuri")).toBe(true);
    expect(dispatcher.has("cookies")).toBe(true);
    expect(dispatcher.has("vault")).toBe(false); // not registered
    expect(dispatcher.has("unknown")).toBe(false);

    const result = await dispatcher.invoke("kuri", { cmd: "ping" });
    expect(result).toEqual({ ran: "kuri", payload: { cmd: "ping" } });

    // Unknown capability surfaces clean error
    await expect(dispatcher.invoke("nonsense", {})).rejects.toThrow(
      /unknown local capability/,
    );
    // Known-in-union but unregistered surfaces a different clean error
    await expect(dispatcher.invoke("vault", {})).rejects.toThrow(
      /no handler registered/,
    );
  });

  test("thin client end-to-end: declare → iterate → status via injected fetch", async () => {
    // Build a fetch-impl that routes to the in-memory ledger via the
    // handler functions. This is the real cloud-side platform; we just
    // skip the HTTP transport layer to keep the test platform-faithful.
    const ledger = inMemoryLedger();

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
      const body = init?.body ? JSON.parse(init.body as string) : {};
      let json: unknown;
      if (url.pathname === "/v1/contract/declare") {
        json = await handleDeclare(body, ledger);
      } else if (url.pathname === "/v1/contract/iterate") {
        json = await handleIterate(body, ledger);
      } else if (url.pathname === "/v1/contract/status") {
        json = await handleStatus(url.searchParams.get("id") ?? "", ledger);
      } else if (url.pathname === "/v1/contract/plan-for-intent") {
        json = await handlePlanForIntent(body, ledger);
      } else if (url.pathname === "/v1/contract/surface") {
        json = handleContractSurface();
      } else {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = createThinClient({
      baseUrl: "https://api.test.local",
      fetchImpl,
    });

    const { id } = await client.declare({
      plan: "thin client e2e probe",
      action: "agent-judges",
    });
    expect(id).toMatch(/^[0-9a-f]{8}$/);

    const it = await client.iterate({ id });
    expect(it.id).toBe(id);
    expect(it.wave).toBe(1);

    const st = await client.status(id);
    expect(st.status).toBe("active");
    expect(st.rows.length).toBe(2);
  });

  test("paper bridge surface matches across canonical manifest, server, thin client, CLI, and Aiko inverse", async () => {
    const canonical = bridgeManifest();
    const server = handleContractSurface();

    expect(server.paper).toBe(canonical.paper);
    expect(server.claim).toBe(canonical.claim);
    expect(server.node_shape).toEqual(canonical.node_shape);
    expect(server.layers).toEqual(canonical.layers);
    expect(server.cli_bridge.tool).toBe(canonical.cli_bridge.tool);
    expect(server.cli_bridge.exposes).toBe(canonical.cli_bridge.exposes);
    expect(server.cli_bridge.holes).toEqual(canonical.cli_bridge.holes);
    expect(server.cli_bridge.holes.map((hole) => hole.name)).toEqual([
      "intent",
      "wallet_proof",
      "approval",
      "local_capability_result",
      "typed_pointer",
    ]);
    expect(server.cli_bridge.holes.every((hole) => hole.exposed_to === "client" && hole.carries_secret === false)).toBe(true);
    expect(server.roles).toEqual(canonical.roles);
    expect(server.aiko_inverse).toEqual(canonical.aiko_inverse);

    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
      if (url.pathname !== "/v1/contract/surface") return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(server), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = createThinClient({ baseUrl: "https://api.test.local", fetchImpl });
    await expect(client.surface()).resolves.toMatchObject({
      paper: canonical.paper,
      claim: canonical.claim,
      cli_bridge: { tool: "unbrowse contract surface", exposes: "holes-only" },
      aiko_inverse: { mapping: "1:-1" },
    });

    const cli = spawnSync("bun", ["src/cli.ts", "contract", "surface"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, UNBROWSE_NO_SWEEP: "1" },
    });
    expect(cli.status).toBe(0);
    const cliManifest = JSON.parse(cli.stdout);
    expect(cliManifest.paper).toBe(canonical.paper);
    expect(cliManifest.claim).toBe(canonical.claim);
    expect(cliManifest.node_shape).toEqual(canonical.node_shape);
    expect(cliManifest.layers).toEqual(canonical.layers);
    expect(cliManifest.cli_bridge.exposes).toBe("holes-only");
    expect(cliManifest.cli_bridge.holes).toEqual(canonical.cli_bridge.holes);
    expect(cliManifest.cli_bridge.commands.length).toBeGreaterThan(10);
    expect(cliManifest.cli_bridge.commands.every((cmd: Record<string, unknown>) => !("route" in cmd) && !("logic" in cmd) && !("secret" in cmd))).toBe(true);

    const descriptor = readFileSync(
      join(AIKO_ROOT, "packages/plugin-worker-runtime/src/descriptor.ts"),
      "utf8",
    );
    const envelope = readFileSync(
      join(AIKO_ROOT, "packages/plugin-worker-runtime/src/envelope.ts"),
      "utf8",
    );
    const aikoReadme = readFileSync(join(AIKO_ROOT, "README.md"), "utf8");
    expect(descriptor).toContain("descriptor is a JSON-safe copy");
    expect(descriptor).toContain("HandlerRegistry");
    expect(descriptor).toContain("return { rpc: true, id }");
    expect(envelope).toContain("newline-delimited JSON");
    expect(aikoReadme).toContain("inverse client/OS harness");
    expect(aikoReadme).toContain("CLI is the bridge");
    expect(aikoReadme).toContain("`{ rpc: true, id }` references");
    expect(aikoReadme).toContain("wallet_proof");
    expect(aikoReadme).toContain("local_capability_result");
    expect(aikoReadme).toContain("typed_pointer");
  });

  test("public docs describe the client as a bridge boundary, not the server-owned graph/control plane", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const notice = readFileSync(join(ROOT, "docs/OPEN-SOURCE-NOTICE.md"), "utf8");

    for (const doc of [readme, notice]) {
      expect(doc).toContain("client boundary");
      expect(doc).toContain("unbrowse contract surface");
      expect(doc).toContain("wallet_proof");
      expect(doc).toContain("local_capability_result");
      expect(doc).toContain("typed_pointer");
      expect(doc).not.toContain("entire client runtime");
      expect(doc).not.toContain("route inference, indexing");
    }
  });
});
