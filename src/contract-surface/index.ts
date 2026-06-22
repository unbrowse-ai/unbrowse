/**
 * contract-surface — unbrowse's discovered-contract-ledger, surfaced in the /contract
 * neuron shape. A NEW SKIN that WRAPS the existing primitives (Matt 9:17 — both
 * preserved), never a rewrite. The /contract design is prioritised on conflict.
 *
 * The isomorphism (internal/contract-ledger-architecture.md):
 *   route/endpoint            ↔ contract neuron
 *   semantic.requires         ↔ dependency edges (blocked_by)
 *   semantic.provides/yields  ↔ what the contract satisfies
 *   resolve                   ↔ "find the contract for the intent"   (build/declare)
 *   walkPrerequisiteChain     ↔ walk the DAG topologically            (run/resolve)
 *   execute → real data       ↔ "satisfy with a witness"             (eval)
 *   drop a dead branch        ↔ prune                                 (John 15:2)
 *
 * The four-verb closure maps: build=declareGoal · run=resolveViaLedger · eval=witness
 * check · prune=drop. This is the SKELETON (the shape); the ledger-DAG wiring is the
 * named next step (Step "Land"/wiring), wrapping resolve/execute/walkPrerequisiteChain.
 */

/** A user goal, declared into the neuron shape (build verb). */
export interface ContractGoal {
  intent: string;
  url?: string;
}

/** A declared neuron over the discovered-contract ledger. */
export interface ContractNeuron {
  intent: string;
  url?: string;
  /** content-addressed id of the declared goal (filled by the real wiring). */
  id?: string;
}

/** The witnessed result of resolving a neuron through the ledger DAG (eval verb). */
export interface ContractWitness {
  satisfied: boolean;
  /** real evidence/data the satisfying execution produced. */
  evidence: unknown;
  /** the walked prerequisite chain (the contract sub-DAG), if any. */
  dag?: string[];
}

/** build/declare: turn a user goal into a contract neuron over the discovered ledger. */
export function declareGoal(goal: ContractGoal): ContractNeuron {
  if (!goal || typeof goal.intent !== "string" || goal.intent.length === 0) {
    throw new Error("contract-surface: declareGoal requires a non-empty intent");
  }
  return { intent: goal.intent, url: goal.url };
}

/**
 * run/eval: resolve a neuron through the discovered-contract-ledger DAG and return a
 * witness. The real wiring wraps resolve → walkPrerequisiteChain → execute (the
 * existing primitives). Honest skeleton: NOT yet wired — throws rather than fake a
 * witness (no fabricated green). This is the named next step.
 */
export async function resolveViaLedger(_n: ContractNeuron): Promise<ContractWitness> {
  throw new Error("contract-surface: wiring TODO (wraps resolve/walkPrerequisiteChain/execute)");
}
