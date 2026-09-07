/**
 * skill-contract-persist.ts — the WRITE-side seed (Layer 2).
 *
 * The firmament from step 2: this is the write-side, kept separate from the
 * read-side chat. It persists a resolved skill into the contract ledger as a
 * parent `declared` row + one child `declared` row per endpoint — parity with
 * how compiled contracts persist (persistCompiledChildren in contract.ts), with
 * ONE faithful difference: a skill child's `action` carries its real endpoint
 * execute pointer (`contract:skill/<id>/endpoint/<eid>`), because that IS what
 * ContractEventRow.action is for ("shell command, contract:<id>, composition
 * shape"). The compiler's hardcoded `action:"agent-judges"` would drop it.
 *
 * NO neuron-fire call — the backend Worker has none (witnessed step 2); the row
 * settles on the next graph read like every contract. Dependencies are injected
 * so the witness runs hermetically (in-memory ledger, no env, no network).
 *
 * Private (backend-only). Never lands on the public unbrowse-ai/unbrowse repo.
 */

import type { SkillManifest } from "../types.js";
import type { ContractLedger } from "./contract-ledger.js";
import { skillToContract } from "./skill-contract.js";

/** Minimal parent-declare contract — structurally a DeclareRequest, but typed
 *  locally so this service doesn't import from the routes layer. */
interface ParentDeclare {
  plan: string;
  action: string;
  visibility?: "lineage" | "public" | "marketplace";
  wallet_identity?: string;
}

export interface SkillPersistDeps {
  ledger: ContractLedger;
  /** declare the parent contract row and return its id (the route wires this to
   *  handleDeclare; the witness wires an in-memory appender) */
  declareParent: (req: ParentDeclare) => Promise<string>;
}

export interface SkillPersistResult {
  parent_id: string;
  child_count: number;
}

/** Deterministic child id so repeat persists of the same skill endpoint don't
 *  fork the ledger (content-addressable, the way the DAG expects). */
function childContractId(skillId: string, endpointPointer: string | undefined, idx: number): string {
  const tail = endpointPointer?.split("/").pop() ?? `ep${idx}`;
  return `skill-contract:${skillId}:${tail}`;
}

export async function persistSkillContract(
  deps: SkillPersistDeps,
  skill: SkillManifest,
): Promise<SkillPersistResult> {
  const contract = skillToContract(skill);

  // Parent: "the word lands first" — declare the skill as a contract truth claim.
  const parent_id = await deps.declareParent({
    plan: contract.prompt,
    action: `contract:skill/${skill.skill_id}`,
    visibility: "lineage",
    wallet_identity: skill.owner_agent_id,
  });

  // Children: one per endpoint, action = the endpoint's execute pointer.
  let child_count = 0;
  for (let i = 0; i < contract.children.length; i++) {
    const child = contract.children[i];
    if (!child.prompt) continue;
    await deps.ledger.append({
      event: "declared",
      id: childContractId(skill.skill_id, child.posthook_pointer, i),
      ts: new Date().toISOString(),
      plan: child.prompt,
      // action carries the endpoint execute pointer; pointer_type is OMITTED (not
      // forced to "agent-judges") so it isn't inconsistent with a contract: action —
      // readers infer it via guessPointerType, same as the real declare path (audit A5).
      action: child.posthook_pointer ?? "agent-judges",
      parent_id,
      wallet_identity: child.wallet_identity,
      visibility: "lineage",
    });
    child_count++;
  }

  return { parent_id, child_count };
}
