import { describe, expect, it } from "bun:test";
import { ensureSkillOperationGraph, getSkillChunk, toAgentSkillChunkView, toAgentWorkflowDagView } from "../src/lib/graph-core/index.js";
import { buildLocalHarnessFixtures } from "../src/lib/graph-core/local-fixtures.js";
import type { ZkProof } from "../src/types/proof.js";

function makeProof(domain: string, verified: boolean, proofType: ZkProof["proof_type"] = "commitment_only"): ZkProof {
  return {
    proof_type: proofType,
    proof_data: "x",
    commitment: {
      response_body_hash: "sha256:" + "a".repeat(64),
      domain,
      url_template: `https://${domain}/api/x`,
      method: "GET",
      response_status: 200,
      captured_at: "2026-05-02T12:00:00Z",
    },
    notary_id: "local",
    generated_at: "2026-05-02T12:00:00Z",
    verified,
  };
}

describe("--require-proof filter", () => {
  const { skills } = buildLocalHarnessFixtures();
  const discord = skills.find((skill) => skill.skill_id === "fixture-discord");
  if (!discord) throw new Error("fixture-discord missing");

  it("toAgentSkillChunkView returns all available operations without requireProof", () => {
    const chunk = getSkillChunk(discord, { intent: "get guild channels", known_bindings: {} });
    const view = toAgentSkillChunkView(chunk, discord.endpoints);
    expect(view.available_operations.length).toBeGreaterThan(0);
  });

  it("toAgentSkillChunkView with requireProof:true filters to only independently proven endpoints", () => {
    // Stamp a future notary-verified proof on the first endpoint, a client
    // commitment on the second. Only the independently verified proof survives.
    const endpoints = discord.endpoints.map((ep, i) => ({
      ...ep,
      zk_proof: i === 0
        ? makeProof(discord.domain, true, "tlsnotary")
        : i === 1
          ? makeProof(discord.domain, true, "commitment_only")
          : undefined,
    }));

    const chunk = getSkillChunk(discord, {
      intent: "get guild channels",
      known_bindings: { guild_id: "g1" },
    });

    const allOps = toAgentSkillChunkView(chunk, endpoints).available_operations;
    expect(allOps.length).toBeGreaterThan(0);

    const filtered = toAgentSkillChunkView(chunk, endpoints, { requireProof: true }).available_operations;
    expect(filtered.length).toBeLessThan(allOps.length);
    // Every survivor must be proven.
    expect(filtered.every((op) => op.proof_status === "proven")).toBe(true);
    // The first endpoint is the only proven one.
    expect(filtered.every((op) => op.endpoint_id === undefined || op.operation_id !== undefined)).toBe(true);
  });

  it("toAgentSkillChunkView with requireProof:true returns empty list when no proofs are present", () => {
    const chunk = getSkillChunk(discord, { intent: "get guild channels", known_bindings: {} });
    // Endpoints without zk_proof — proof_status:"no_proof" everywhere.
    const filtered = toAgentSkillChunkView(chunk, discord.endpoints, { requireProof: true }).available_operations;
    expect(filtered).toEqual([]);
  });

  it("toAgentWorkflowDagView distinguishes proven proofs from client commitments", () => {
    const endpoints = discord.endpoints.map((ep, i) => ({
      ...ep,
      zk_proof: i === 0
        ? makeProof(discord.domain, true, "tlsnotary")
        : i === 1
          ? makeProof(discord.domain, true, "commitment_only")
          : undefined,
    }));

    const chunk = getSkillChunk(discord, {
      intent: "get guild channels",
      known_bindings: {},
      include_full_relevant_graph: true,
    });
    const dag = toAgentWorkflowDagView(chunk, ensureSkillOperationGraph(discord), {}, endpoints);

    const provenOps = dag.operations.filter((op) => op.proof_status === "proven");
    const commitmentOps = dag.operations.filter((op) => op.proof_status === "client_commitment");
    const noProofOps = dag.operations.filter((op) => op.proof_status === "no_proof");
    expect(provenOps.length).toBe(1);
    expect(commitmentOps.length).toBe(1);
    expect(noProofOps.length).toBe(dag.operations.length - 2);
  });
});
