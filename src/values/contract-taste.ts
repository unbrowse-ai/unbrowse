/**
 * contract-taste — /taste as a first-class /contract on the crypto-was-all-you-needed stack.
 *
 * The frontend already judges taste (scripts/four-dim-gate.sh: Core Web Vitals, visual taste,
 * accessibility, copy/GEO — "all four non-regressing, at least one strictly improves"). That
 * verdict was ephemeral — read once by an agent, then lost. This module makes a taste judgment
 * a recorded /contract through the unification seam (contract-everything.ts), so a `/taste`
 * verdict is:
 *   - stored on IQ            → on-chain, append-only, wallet-signed taste history
 *   - cached by emergent      → O(1) recall of "what did we judge, and how"
 *   - searchable by emergent  → semantic search ("the landing page taste verdict")
 *
 * Taste is bottlenecked by its WORST dimension (min, not mean): a beautiful page with broken
 * accessibility has no taste, the same way the four-dim-gate blocks on any single regression.
 * It does NOT re-implement signing/persistence — it composes persistContract.
 */

import {
  persistContract,
  recallContract,
  searchContractsEverywhere,
  type ContractEverything,
} from "./contract-everything.js";
import type { ScoredId } from "./contract-search.js";

/** One scored axis of taste (0..1). Mirrors a four-dim-gate dimension. */
export interface TasteDimension {
  name: string;
  /** 0..1; clamped on judgement. */
  score: number;
  note?: string;
}

export interface TasteVerdict {
  /** what was judged (a surface, a deploy, the source-of-truth chain). */
  subject: string;
  dimensions: TasteDimension[];
  /** the worst dimension — taste is as good as its weakest axis. */
  overall: number;
  /** settle iff overall >= threshold (every axis clears the bar). */
  verdict: "settle" | "break";
  threshold: number;
  /** unix ms; caller stamps it so the contract id is reproducible. */
  ts: number;
}

const TASTE_NAMESPACE = "ubz-taste";
const DEFAULT_THRESHOLD = 0.7;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "subject";
}

/**
 * Judge taste across scored dimensions. `overall` is the MIN of the dimensions (the weakest
 * axis caps the verdict), settling only when every axis clears `threshold`.
 */
export function judgeTaste(
  subject: string,
  dimensions: TasteDimension[],
  opts: { threshold?: number; ts: number },
): TasteVerdict {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const dims = dimensions.map((d) => ({ ...d, score: clamp01(d.score) }));
  const overall = dims.length ? Math.min(...dims.map((d) => d.score)) : 0;
  return {
    subject,
    dimensions: dims,
    overall,
    verdict: overall >= threshold ? "settle" : "break",
    threshold,
    ts: opts.ts,
  };
}

/** Stable, reproducible taste contract id — same (subject, ts) → same id. */
export function tasteContractId(v: TasteVerdict): string {
  return `taste:${slug(v.subject)}:${v.ts}`;
}

/** The human description the RAG layer embeds — what makes a taste verdict findable by meaning. */
export function tasteText(v: TasteVerdict): string {
  const axes = v.dimensions.map((d) => `${d.name} ${d.score.toFixed(2)}`).join(", ");
  return `taste ${v.subject} — ${v.verdict} (overall ${v.overall.toFixed(2)}/${v.threshold}) — ${axes}`;
}

export interface TasteRecord {
  id: string;
  verdict: TasteVerdict;
  persisted: Awaited<ReturnType<typeof persistContract>>;
}

/**
 * Record a taste verdict as a /contract on the full stack. Fail-open per tier (absent creds =
 * a surfaced note, never a throw), so judging taste is never blocked by the recorder.
 */
export async function recordTaste(v: TasteVerdict): Promise<TasteRecord> {
  const id = tasteContractId(v);
  const contract: ContractEverything = { id, text: tasteText(v), value: v };
  const persisted = await persistContract(contract, { namespace: TASTE_NAMESPACE });
  return { id, verdict: v, persisted };
}

/** Recall a taste verdict by id — emergent KV fast tier, IQ durable behind. */
export async function recallTaste(id: string): Promise<TasteVerdict | null> {
  const v = await recallContract(id, { namespace: TASTE_NAMESPACE });
  return (v ?? null) as TasteVerdict | null;
}

/** Semantic search across recorded taste verdicts. */
export async function searchTaste(query: string, k = 5): Promise<ScoredId[]> {
  return searchContractsEverywhere(query, { namespace: TASTE_NAMESPACE, k });
}
