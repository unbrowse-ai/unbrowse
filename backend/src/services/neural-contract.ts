import type { ContractEventRow } from "./contract-ledger.js";
import type { GraphEdge, GraphNode } from "./graph.js";

export type ContractNeuronKind =
  | "cell"
  | "judgment"
  | "sequence"
  | "funnel"
  | "funnel-first"
  | "quorum"
  | "loop"
  | "harness"
  | "tool-guard";

export type SynapseKind =
  | "requires"
  | "provides"
  | "contract-ref"
  | "inhibits"
  | "supersedes"
  | "cofires";

export interface ContractNeuron {
  id: string;
  kind: ContractNeuronKind;
  threshold: number;
  potential: number;
  refractory_until_wave: number;
  status: "pending" | "active" | "satisfied" | "merged";
}

export interface ContractSynapse {
  from: string;
  to: string;
  kind: SynapseKind;
  weight: number;
}

export interface NeuralFireInput {
  neuron: ContractNeuron;
  incoming: ContractSynapse[];
  activeSourceIds: string[];
  wave: number;
}

export interface NeuralFireResult {
  fired: boolean;
  potential: number;
  threshold: number;
  inhibited: boolean;
  refractory: boolean;
}

export interface GraphValidationResult {
  ok: boolean;
  errors: string[];
}

const ID_RE = /^[A-Za-z0-9_.:@/-]{1,160}$/;
const KIND_BY_ACTION_PREFIX: Array<[string, ContractNeuronKind]> = [
  ["quorum:", "quorum"],
  ["loop-until:", "loop"],
  ["harness:", "harness"],
  ["tool-guard:", "tool-guard"],
  ["contract:", "judgment"],
];

export function neuronKindForAction(action?: string): ContractNeuronKind {
  if (!action || action === "agent-judges") return "judgment";
  if (action === "sequence") return "sequence";
  if (action === "funnel" || action === "children-satisfy") return "funnel";
  if (action === "funnel-first") return "funnel-first";
  const match = KIND_BY_ACTION_PREFIX.find(([prefix]) => action.startsWith(prefix));
  return match?.[1] ?? "cell";
}

export function contractRowToNeuron(
  row: ContractEventRow,
  status: ContractNeuron["status"],
): ContractNeuron {
  const kind = neuronKindForAction(row.action);
  return {
    id: row.id,
    kind,
    threshold: thresholdForKind(kind, row.action),
    potential: status === "satisfied" || status === "merged" ? 1 : 0,
    refractory_until_wave: row.wave ?? 0,
    status,
  };
}

export function thresholdForKind(kind: ContractNeuronKind, action?: string): number {
  if (kind === "funnel-first") return 1;
  if (kind === "sequence") return 1;
  if (kind === "funnel") return 1;
  if (kind === "quorum") {
    const raw = action?.match(/^quorum:(\d+)/)?.[1];
    const n = raw ? Number(raw) : 2;
    return Number.isFinite(n) && n > 0 ? n : 2;
  }
  return 1;
}

export function fireContractNeuron(input: NeuralFireInput): NeuralFireResult {
  const active = new Set(input.activeSourceIds);
  const refractory = input.wave <= input.neuron.refractory_until_wave;
  const inhibited = input.incoming.some(
    (synapse) => synapse.kind === "inhibits" && active.has(synapse.from) && synapse.weight > 0,
  );
  const potential = input.incoming.reduce((sum, synapse) => {
    if (!active.has(synapse.from)) return sum;
    return sum + (synapse.kind === "inhibits" ? -Math.abs(synapse.weight) : synapse.weight);
  }, input.neuron.potential);
  return {
    fired: !refractory && !inhibited && potential >= input.neuron.threshold,
    potential,
    threshold: input.neuron.threshold,
    inhibited,
    refractory,
  };
}

export function reinforceSynapse(
  synapse: ContractSynapse,
  outcome: "cofire" | "miss" | "inhibit",
): ContractSynapse {
  const delta = outcome === "cofire" ? 0.05 : outcome === "miss" ? -0.08 : -0.12;
  return {
    ...synapse,
    weight: clamp(synapse.weight + delta, synapse.kind === "inhibits" ? -1 : 0, 1),
  };
}

export function graphEdgeToSynapse(from: string, edge: GraphEdge): ContractSynapse {
  return {
    from,
    to: edge.to,
    kind: edge.binding.startsWith("contract:") ? "contract-ref" : "requires",
    weight: 1,
  };
}

export function validateNeuralGraphWrite(
  domain: string,
  node: GraphNode,
  edges: GraphEdge[],
): GraphValidationResult {
  const errors: string[] = [];
  if (!domain || typeof domain !== "string") errors.push("domain required");
  if (!node || typeof node !== "object") errors.push("node required");
  if (!node?.endpoint_id || typeof node.endpoint_id !== "string") errors.push("node.endpoint_id required");
  if (node?.endpoint_id && !ID_RE.test(node.endpoint_id)) errors.push("node.endpoint_id must be a typed id");
  if (node?.endpoint_id?.includes("..")) errors.push("node.endpoint_id must be a typed id");
  for (const key of ["requires", "provides"] as const) {
    const values = node?.[key];
    if (values !== undefined && !Array.isArray(values)) errors.push(`node.${key} must be an array`);
    for (const value of Array.isArray(values) ? values : []) {
      if (typeof value !== "string" || !ID_RE.test(value)) errors.push(`node.${key} values must be typed strings`);
    }
  }
  if (!Array.isArray(edges)) errors.push("edges must be an array");
  for (const [index, edge] of (Array.isArray(edges) ? edges : []).entries()) {
    if (!edge?.to || typeof edge.to !== "string" || !ID_RE.test(edge.to)) {
      errors.push(`edges[${index}].to must be a typed id`);
    }
    if (!edge?.binding || typeof edge.binding !== "string" || !ID_RE.test(edge.binding)) {
      errors.push(`edges[${index}].binding must be a typed binding`);
    }
    if (edge?.binding?.includes("..") || edge?.to?.includes("..")) {
      errors.push(`edges[${index}] must not contain path traversal`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
