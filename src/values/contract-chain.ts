/**
 * contract-chain — bind unbrowse's cli + server + frontend as ONE source of truth.
 *
 * The truth-root is not any one runtime: it is an ORDERED precedence the whole stack reflects,
 * highest-truth first (CLAUDE.md, "The Word is the truth-root"):
 *
 *     papers  →  code  →  cli  →  frontend
 *
 * Papers are the spec (the Word-analog); code implements the papers; the cli surfaces the code's
 * story; the frontend reflects what the cli/code tell the world. Each LINK is a claim — "this
 * layer faithfully reflects the layer above it" — proved by a runnable witness, never asserted.
 * The whole chain is then recorded as ONE /contract through the unification seam
 * (contract-everything.ts): on IQ (signed, on-chain), in emergent KV (recall), and emergent RAG
 * (search). The chain BINDS only when every link reflects AND the binding's taste settles.
 *
 * This module is the data model + the persist seam. The reflection booleans are produced by the
 * runnable witnesses (scripts/contract-chain-gate.sh) and passed in — the gate decides green,
 * not this code.
 */

import {
  persistContract,
  recallContract,
  searchContractsEverywhere,
  type ContractEverything,
} from "./contract-everything.js";
import type { ScoredId } from "./contract-search.js";
import { judgeTaste, type TasteVerdict } from "./contract-taste.js";

/** The precedence, highest truth first. papers is the truth-root; frontend is the leaf reflection. */
export const SOURCE_OF_TRUTH_ORDER = ["papers", "code", "cli", "frontend"] as const;
export type Layer = (typeof SOURCE_OF_TRUTH_ORDER)[number];

/** A reflection claim: `to` must faithfully reflect `from` (the higher-precedence layer). */
export interface ChainLink {
  /** the truth source (higher precedence). */
  from: Layer;
  /** the reflection (lower precedence) that must mirror `from`. */
  to: Layer;
  /** the runnable command that proves the reflection holds (honest provenance). */
  witness: string;
  /** did the witness pass — supplied by the gate, never assumed. */
  reflects: boolean;
}

/** The witness command for each adjacent link, in precedence order. The gate runs these. */
export interface ChainLinkSpec {
  from: Layer;
  to: Layer;
  witness: string;
}

export function chainLinkSpecs(): ChainLinkSpec[] {
  return [
    // papers → code: every shipped paper claim maps to a real code anchor (paper/anchors.tsv).
    { from: "papers", to: "code", witness: "bash scripts/paper-gate.sh paper/crypto-was-all-you-needed.tex" },
    // code → cli: `unbrowse eval stats --json` surfaces the code's papers/economy/privacy story.
    { from: "code", to: "cli", witness: "bash scripts/cli-papers-docs-check.sh" },
    // cli → frontend: frontend/src/lib/papers.ts reflects the same trilogy the paper index carries.
    { from: "cli", to: "frontend", witness: "bash scripts/contract-chain-frontend-check.sh" },
  ];
}

export interface ChainBinding {
  order: readonly Layer[];
  links: ChainLink[];
  taste: TasteVerdict;
  /** every link reflects AND the binding's taste settles. */
  bound: boolean;
  /** unix ms; caller stamps it so the contract id is reproducible. */
  ts: number;
}

const CHAIN_NAMESPACE = "ubz-chain";
const CHAIN_SUBJECT = "source-of-truth chain (papers → code → cli → frontend)";

/**
 * Build the chain binding from the link results. Taste is derived from the links themselves —
 * one dimension per reflection (1 if it reflects, 0 if it does not), so a single broken link
 * both un-binds the chain AND breaks its taste (the weakest link caps both).
 */
export function bindChain(
  linkResults: ChainLink[],
  opts: { ts: number; taste?: TasteVerdict },
): ChainBinding {
  const taste =
    opts.taste ??
    judgeTaste(
      CHAIN_SUBJECT,
      linkResults.map((l) => ({ name: `${l.from}→${l.to}`, score: l.reflects ? 1 : 0 })),
      { ts: opts.ts },
    );
  const bound = linkResults.length > 0 && linkResults.every((l) => l.reflects) && taste.verdict === "settle";
  return { order: SOURCE_OF_TRUTH_ORDER, links: linkResults, taste, bound, ts: opts.ts };
}

/** Stable, reproducible chain contract id — same ts → same id. */
export function chainContractId(b: ChainBinding): string {
  return `chain:source-of-truth:${b.ts}`;
}

/** The human description the RAG layer embeds. */
export function chainText(b: ChainBinding): string {
  const path = b.links.map((l) => `${l.from}${l.reflects ? "→" : "⊘"}${l.to}`).join(" ");
  return `source-of-truth chain ${b.order.join(">")} — ${b.bound ? "bound" : "unbound"} — ${path} — taste ${b.taste.verdict} ${b.taste.overall.toFixed(2)}`;
}

export interface ChainRecord {
  id: string;
  binding: ChainBinding;
  persisted: Awaited<ReturnType<typeof persistContract>>;
}

/**
 * Record the chain binding as a /contract on the full stack. Fail-open per tier (absent creds =
 * a surfaced note, never a throw): the binding is witnessed by the gate; recording is best-effort.
 */
export async function recordChain(b: ChainBinding): Promise<ChainRecord> {
  const id = chainContractId(b);
  const contract: ContractEverything = { id, text: chainText(b), value: b };
  const persisted = await persistContract(contract, { namespace: CHAIN_NAMESPACE });
  return { id, binding: b, persisted };
}

/** Recall a chain binding by id — emergent KV fast tier, IQ durable behind. */
export async function recallChain(id: string): Promise<ChainBinding | null> {
  const v = await recallContract(id, { namespace: CHAIN_NAMESPACE });
  return (v ?? null) as ChainBinding | null;
}

/** Semantic search across recorded chain bindings. */
export async function searchChains(query: string, k = 5): Promise<ScoredId[]> {
  return searchContractsEverywhere(query, { namespace: CHAIN_NAMESPACE, k });
}
