/**
 * contract-reconcile — when several /contract claims ride in ONE prompt, identify them and
 * contract them AGAINST EACH OTHER, mechanically (no LLM): do they agree, or does a pair
 * contradict? The verdict is itself a /contract on the stack.
 *
 * "Mechanical" = falsifiable string logic, two signals per pair:
 *   1. RELATED — the two claims are about the same thing: Jaccard overlap of content tokens
 *      (stopwords dropped) ≥ a threshold. Unrelated claims can never contradict.
 *   2. POLARITY CONFLICT — on a shared key token, exactly ONE claim carries a negation marker
 *      within a small window before it (e.g. "the chain is bound" vs "the chain is NOT bound").
 *
 * A pair contradicts iff RELATED ∧ POLARITY CONFLICT. The set settles iff NO pair contradicts
 * (the MIN-over-pairs shape reused from contract-taste). This catches the common failure —
 * two /contract directives in one prompt that quietly negate each other — without a model.
 */

import {
  persistContract,
  recallContract,
  searchContractsEverywhere,
  type ContractEverything,
} from "./contract-everything.js";
import type { ScoredId } from "./contract-search.js";

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "be", "to", "of", "and", "or", "in", "on", "at", "it", "this",
  "that", "as", "for", "with", "by", "we", "i", "should", "make", "all", "them", "being", "then",
  "into", "same", "each", "other", "against", "one", "our",
]);
const NEGATIONS = new Set([
  "not", "no", "never", "none", "non", "dont", "don't", "without", "disable", "disabled",
  "off", "false", "refuse", "reject", "avoid", "remove", "drop", "stop", "skip", "exclude",
]);
const NEG_WINDOW = 4; // a negation governs a token if it appears within this many tokens before it.

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
}
function contentTokens(toks: string[]): Set<string> {
  return new Set(toks.filter((t) => !STOPWORDS.has(t) && !NEGATIONS.has(t) && t.length > 1));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
/** Is `token` negated in `toks` — a negation marker within NEG_WINDOW tokens before any occurrence? */
function negated(toks: string[], token: string): boolean {
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== token) continue;
    for (let j = Math.max(0, i - NEG_WINDOW); j < i; j++) {
      if (NEGATIONS.has(toks[j])) return true;
    }
  }
  return false;
}

export type PairVerdict = "agree" | "contradict" | "unrelated";

export interface ReconcilePair {
  a: number;
  b: number;
  related: boolean;
  /** the shared key tokens with asymmetric negation (the evidence for a contradiction). */
  conflictingTokens: string[];
  verdict: PairVerdict;
}

export interface ReconcileVerdict {
  claims: string[];
  pairs: ReconcilePair[];
  contradictions: number;
  /** settle iff no pair contradicts. */
  verdict: "settle" | "break";
  threshold: number;
  ts: number;
}

const RECONCILE_NAMESPACE = "ubz-reconcile";
const DEFAULT_RELATE = 0.18;

/**
 * Pull the /contract claims out of one prompt: each `/contract <text>` segment, up to the next
 * `/contract` or end. Aliases (e.g. `/contract-deploy`) count — the verb is `/contract`.
 */
export function extractContractClaims(prompt: string): string[] {
  const out: string[] = [];
  const re = /\/contract(?:-[a-z]+)?\b/gi;
  const marks: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) marks.push(m.index + m[0].length);
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i];
    const end = i + 1 < marks.length ? prompt.indexOf("/contract", start) : prompt.length;
    const seg = prompt.slice(start, end < 0 ? prompt.length : end).trim();
    if (seg) out.push(seg);
  }
  return out;
}

/** Reconcile a set of claims against each other, pairwise and mechanically. */
export function reconcile(
  claims: string[],
  opts: { ts: number; relateThreshold?: number },
): ReconcileVerdict {
  const threshold = opts.relateThreshold ?? DEFAULT_RELATE;
  const toks = claims.map(tokenize);
  const content = toks.map(contentTokens);
  const pairs: ReconcilePair[] = [];
  for (let a = 0; a < claims.length; a++) {
    for (let b = a + 1; b < claims.length; b++) {
      const related = jaccard(content[a], content[b]) >= threshold;
      const conflictingTokens: string[] = [];
      if (related) {
        for (const t of content[a]) {
          if (!content[b].has(t)) continue;
          if (negated(toks[a], t) !== negated(toks[b], t)) conflictingTokens.push(t);
        }
      }
      const verdict: PairVerdict = !related
        ? "unrelated"
        : conflictingTokens.length > 0
          ? "contradict"
          : "agree";
      pairs.push({ a, b, related, conflictingTokens, verdict });
    }
  }
  const contradictions = pairs.filter((p) => p.verdict === "contradict").length;
  return {
    claims,
    pairs,
    contradictions,
    verdict: contradictions === 0 ? "settle" : "break",
    threshold,
    ts: opts.ts,
  };
}

/** Stable, reproducible reconciliation id — same (claim count, ts) → same id. */
export function reconcileContractId(v: ReconcileVerdict): string {
  return `reconcile:${v.claims.length}:${v.ts}`;
}

export function reconcileText(v: ReconcileVerdict): string {
  const c = v.pairs
    .filter((p) => p.verdict === "contradict")
    .map((p) => `#${p.a}⊥#${p.b}{${p.conflictingTokens.join(",")}}`)
    .join(" ");
  return `reconcile ${v.claims.length} contracts — ${v.verdict} (${v.contradictions} contradiction${v.contradictions === 1 ? "" : "s"})${c ? " — " + c : ""}`;
}

export interface ReconcileRecord {
  id: string;
  verdict: ReconcileVerdict;
  persisted: Awaited<ReturnType<typeof persistContract>>;
}

/** Record a reconciliation verdict as a /contract on the full stack. Fail-open per tier. */
export async function recordReconciliation(v: ReconcileVerdict): Promise<ReconcileRecord> {
  const id = reconcileContractId(v);
  const contract: ContractEverything = { id, text: reconcileText(v), value: v };
  const persisted = await persistContract(contract, { namespace: RECONCILE_NAMESPACE });
  return { id, verdict: v, persisted };
}

export async function recallReconciliation(id: string): Promise<ReconcileVerdict | null> {
  const v = await recallContract(id, { namespace: RECONCILE_NAMESPACE });
  return (v ?? null) as ReconcileVerdict | null;
}

export async function searchReconciliations(query: string, k = 5): Promise<ScoredId[]> {
  return searchContractsEverywhere(query, { namespace: RECONCILE_NAMESPACE, k });
}
