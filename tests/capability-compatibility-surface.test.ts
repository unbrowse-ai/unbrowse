import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { handleContractSurface } from "../backend/src/routes/contract";
import { statelessResultToCapabilityResult } from "../src/kuri/stateless-primitive";
import { bridgeManifest } from "../src/superpattern/bridge-manifest";

const ROOT = join(import.meta.dir, "..");
const ARCH_PAPER = join(ROOT, "internal/docs/UNBROWSE_ARCHITECTURE_PAPER.md");

describe("capability compatibility standard", () => {
  test("contract surface exposes one CapabilityResult shape for every fallback source", () => {
    const manifest = bridgeManifest();
    const contract = manifest.compatibility.result_contract;

    expect(contract.name).toBe("CapabilityResult");
    expect(contract.invariant).toBe("backward-compatible-minimum-shape");
    expect(contract.minimum_fields).toEqual([
      "status",
      "kind",
      "source",
      "data",
      "requirements",
      "artifacts",
      "evidence",
      "next_action",
    ]);

    const hierarchySources = manifest.compatibility.fallback_hierarchy.map((level) => level.source);
    for (const source of hierarchySources) {
      expect(contract.sources).toContain(source);
    }
    expect(manifest.compatibility.fallback_hierarchy.every((level) => level.returns === "CapabilityResult")).toBe(true);
  });

  test("architecture paper names the shipped manifest acceptance contract", () => {
    const paper = readFileSync(ARCH_PAPER, "utf8");
    const manifest = bridgeManifest();

    expect(paper).toContain("src/superpattern/bridge-manifest.ts");
    expect(paper).toContain("unbrowse contract surface");
    expect(paper).toContain("GET /v1/contract/surface");
    expect(paper).toContain("CapabilityResult");
    expect(paper).toContain("backward-compatible-minimum-shape");
    expect(paper).toContain("capability-knowledge-row");
    expect(paper).toContain("resolve -> read resolve");
    expect(paper).toContain("execute -> act execute");
    expect(paper).toContain("publish -> create publish");

    for (const verb of manifest.cli_bridge.canonical_verbs) {
      expect(paper).toContain(verb);
    }
    for (const source of manifest.compatibility.fallback_hierarchy.map((level) => level.source)) {
      expect(paper).toContain(source);
    }
    for (const field of manifest.compatibility.result_contract.minimum_fields) {
      expect(paper).toContain(field);
    }
  });

  test("architecture paper names the Dia-derived agent harness acceptance contract", () => {
    const paper = readFileSync(ARCH_PAPER, "utf8");

    expect(paper).toContain("Bookmark-Derived Agent Harness");
    expect(paper).toContain("unbrowse read auth-inventory --json --dia-only");
    expect(paper).toContain("bun scripts/bookmark-prompt-harness.ts --dia-only --selftest");
    expect(paper).toContain("unbrowse read resolve --intent");
    expect(paper).toContain("dia:/Users/.../Dia/User Data/Default");
    expect(paper).toContain("read resolve");
    expect(paper).toContain("unbrowse read version --json");
    expect(paper).toContain("Plan -> Build -> Test -> Judge");
    expect(paper).toContain("origin-only");
    expect(paper).toContain("CapabilityResult");
    expect(paper).toContain("Unit tests prove the generator and privacy boundary; they do not prove agent experience.");
    expect(paper).toContain("bash harness/probes/agent-experience.sh");
    expect(paper).toContain("harness/probes/JUDGE.md");
    expect(paper).toContain("Direct-document successes must still be agent-shaped.");
    expect(paper).toContain("available_operations");
    expect(paper).toContain("suggested_next_operation_id");
  });

  test("architecture paper names the stateless binary runtime acceptance contract", () => {
    const paper = readFileSync(ARCH_PAPER, "utf8");
    const runtime = bridgeManifest().runtime_authority;

    expect(paper).toContain("runtime_authority.local_substrate: stateless_binary");
    expect(paper).toContain("runtime_authority.invocation: unbrowse <verb> <capability> --json");
    expect(paper).toContain("runtime_authority.browser_primitives.owner: binary_owned_lease");
    expect(paper).toContain("src/kuri/stateless-primitive.ts");
    expect(paper).toContain("long_lived_local_unbrowse_server");
    expect(paper).toContain("shared_kuri_tab_registry");
    expect(runtime.local_substrate).toBe("stateless_binary");
    expect(runtime.process_model).toBe("single_shot");
    expect(runtime.browser_primitives.returns).toBe("CapabilityResult");
  });

  test("architecture paper names the auth keychain no-dialog invariant", () => {
    const paper = readFileSync(ARCH_PAPER, "utf8");

    expect(paper).toContain("~/Library/Keychains/login.keychain-db");
    expect(paper).toContain("Keychain Not Found");
    expect(paper).toContain("keychain://unbrowse-auth/<domain>");
    expect(paper).toContain("security find-generic-password");
    expect(paper).toContain("typed missing-credential or unavailable requirement");
  });

  test("fallback hierarchy is nested and browser capture is the last executable fallback", () => {
    const hierarchy = bridgeManifest().compatibility.fallback_hierarchy;

    expect(hierarchy.map((level) => level.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(hierarchy.map((level) => level.source)).toEqual([
      "native_route",
      "installed_skill",
      "mcp_tool",
      "local_primitive",
      "standard_adapter",
      "marketplace_endpoint",
      "indexer_contribution",
      "browser_capture_fallback",
      "unavailable",
    ]);
  });

  test("indexer contributions compile into the same result contract", () => {
    const contribution = bridgeManifest().compatibility.indexer_contribution;

    expect(contribution.format).toBe("capability-knowledge-row");
    expect(contribution.candidate_fields).toEqual(
      expect.arrayContaining(["recipe", "schema_hint", "auth_note", "failure_pattern", "evidence", "redactions"]),
    );
    expect(contribution.promotion_targets).toEqual(
      expect.arrayContaining(["executable_endpoint", "discovery_backend", "avoid_path_policy", "verifier_fixture"]),
    );
    expect(contribution.compiles_to).toBe("CapabilityResult");
  });

  test("server and local CLI manifest agree on standards, aliases, and compatibility", () => {
    const local = bridgeManifest();
    const server = handleContractSurface();

    expect(server.compatibility).toEqual(local.compatibility);
    expect(server.runtime_authority).toEqual(local.runtime_authority);
    expect(server.cli_bridge.canonical_verbs).toEqual(["create", "act", "read"]);
    expect(server.cli_bridge.legacy_aliases).toEqual(local.cli_bridge.legacy_aliases);
    expect(server.cli_bridge.legacy_aliases).toEqual(
      expect.arrayContaining([
        { legacy: "resolve", canonical: "read resolve", reason: "backward-compatibility" },
        { legacy: "execute", canonical: "act execute", reason: "backward-compatibility" },
        { legacy: "publish", canonical: "create publish", reason: "backward-compatibility" },
      ]),
    );
  });

  test("stateless browser primitive normalizes into CapabilityResult", () => {
    const envelope = statelessResultToCapabilityResult(
      {
        ok: true,
        op: "snapshot",
        url: "https://github.com",
        snapshot: "[e0] link \"GitHub\"",
        network: [],
        authApplied: { cookies: 2, headers: 0 },
      },
      "2026-06-12T00:00:00.000Z",
      "2026-06-12T00:00:01.000Z",
    );

    expect(envelope).toMatchObject({
      status: "ok",
      kind: "browser.stateless",
      source: "browser_capture_fallback",
      requirements: {},
      evidence: {
        runtime: "stateless_binary",
        primitive_module: "src/kuri/stateless-primitive.ts",
        auth_applied: { cookies: 2, headers: 0 },
        browser_lease: {
          op: "snapshot",
          url: "https://github.com",
          acquired_at: "2026-06-12T00:00:00.000Z",
          released_at: "2026-06-12T00:00:01.000Z",
          helper_pid: null,
        },
      },
      next_action: null,
    });
    expect(envelope.evidence.browser_lease.lease_id).toMatch(/^browser-lease-[0-9a-f]{8}$/);
    expect(envelope.data.snapshot).toBe("[e0] link \"GitHub\"");
  });

  test("stateless browser primitive is binary-owned CDP, not a Kuri broker client", () => {
    const source = readFileSync(join(ROOT, "src/kuri/stateless-primitive.ts"), "utf8");

    expect(source).toContain("spawnChrome");
    expect(source).toContain("createTarget");
    expect(source).toContain("Network.enable");
    expect(source).not.toContain("from \"./client.js\"");
    expect(source).not.toContain("import * as kuri");
  });

  test("failed stateless browser primitive returns typed unavailable", () => {
    const envelope = statelessResultToCapabilityResult({
      ok: false,
      op: "navigate",
      url: "https://example.com",
      error: "browser_runtime_failed",
    });

    expect(envelope.status).toBe("unavailable");
    expect(envelope.source).toBe("unavailable");
    expect(envelope.requirements.unavailable).toEqual({ reason: "browser_runtime_failed" });
    expect(envelope.next_action).toMatchObject({
      title: "Browser primitive unavailable",
      reason: "browser_runtime_failed",
    });
  });
});

describe("canonical CLI compatibility e2e", () => {
  test("unbrowse read routes into the v7 eval tree", () => {
    const canonical = spawnSync("bun", ["src/cli.ts", "read", "version", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, UNBROWSE_NO_SWEEP: "1" },
    });
    expect(canonical.status).toBe(0);
    const readBody = JSON.parse(canonical.stdout);
    expect(readBody.ok).toBe(true);
    expect(readBody.subcommand).toBe("eval version");
    expect(readBody.op_kind).toBe("eval:version");
    expect(readBody.signatureScheme).toBe("ed25519-v7.0");
  });

  test("agentic UX surface is machine-readable and hides internal route logic", () => {
    const cli = spawnSync("bun", ["src/cli.ts", "contract", "surface"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, UNBROWSE_NO_SWEEP: "1" },
    });
    expect(cli.status).toBe(0);
    expect(cli.stdout.trimStart().startsWith("{")).toBe(true);
    expect(cli.stdout).not.toContain("[trace]");
    expect(cli.stdout).not.toContain("[in-process-app]");
    const manifest = JSON.parse(cli.stdout);

    expect(manifest.cli_bridge.canonical_verbs).toEqual(["create", "act", "read"]);
    expect(manifest.compatibility.result_contract.minimum_fields).toContain("next_action");
    expect(manifest.compatibility.result_contract.optional_extensions).toContain("view_spec");
    expect(JSON.stringify(manifest.cli_bridge.commands)).not.toContain("url_template");
    expect(JSON.stringify(manifest.cli_bridge.commands)).not.toContain("endpoint_url");
    expect(JSON.stringify(manifest.cli_bridge.commands)).not.toContain("secret");
  });

  test("CLI help presents the stateless runtime while preserving legacy commands", () => {
    const cli = spawnSync("bun", ["src/cli.ts", "help"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, UNBROWSE_NO_SWEEP: "1" },
    });
    expect(cli.status).toBe(0);
    const output = `${cli.stdout}\n${cli.stderr}`;
    expect(output).toContain("local runtime health");
    expect(output).toContain("in-process stateless runtime");
    expect(output).toContain("compatibility daemon");
    expect(output).toContain("go <url>");
    expect(output).toContain("resolve");
    expect(output).toContain("execute");
    expect(output).not.toContain("Quick local server health check");
    expect(output).not.toContain("Open a fresh Kuri browser tab");
  });
});

describe("staging acceptance witness", () => {
  test.if(process.env.UNBROWSE_STAGING_ACCEPTANCE === "1")("staging serves the same compatibility contract", async () => {
    const res = await fetch("https://unbrowse-backend-staging.lewis-6d8.workers.dev/v1/contract/surface");
    expect(res.status).toBe(200);
    const staging = await res.json() as ReturnType<typeof bridgeManifest>;
    const local = bridgeManifest();

    expect(staging.claim).toBe(local.claim);
    expect(staging.cli_bridge.canonical_verbs).toEqual(local.cli_bridge.canonical_verbs);
    expect(staging.compatibility.result_contract).toEqual(local.compatibility.result_contract);
    expect(staging.compatibility.fallback_hierarchy).toEqual(local.compatibility.fallback_hierarchy);
    expect(staging.compatibility.indexer_contribution).toEqual(local.compatibility.indexer_contribution);
    expect(staging.runtime_authority).toEqual(local.runtime_authority);
  });
});
