/**
 * contract-browse — the kuri browser primitives, mirrored onto the unbrowse CLI in /contract shape.
 *
 * Kuri's agentic browser loop is `go → snap → click → snap → eval` (readme): a token-cheap a11y
 * `snap` to READ the page, then `click`/`type` to ACT on stable refs, then `eval`. The
 * execute-dont-guess / maintenance-network papers name the thesis this reflects: the browser is the
 * ACTION ENGINE of the internet — you act, you don't guess.
 *
 * "/contract it properly" = classify each primitive by the wrap/exec doctrine (SKILL.md claim 82):
 *
 *   READ primitive (snap, fetch, read) — idempotent for a stable target → RECALL-FIRST muscle memory
 *     (apiContract): the contract ledger is consulted first; a hit is recalled with no re-fetch; the
 *     legacy browser runs only on a miss. This is `exec:` — a run-once producer, value-cacheable.
 *
 *   ACT primitive (go, navigate, click, type, submit) — STATE-CHANGING → NEVER memoized; it re-runs
 *     on every call (this is `wrap:` — the re-running witness). A recalled act is false witness
 *     (Decalogue cmd 9): clicking twice is two clicks, and the substrate must never pretend otherwise.
 *
 * So a browser READ resolves through /contract first (legacy browser as fallback — unbrowse's original
 * design), while a browser ACT always fires live. The kuri loop is preserved; only the read leg memoizes.
 */
import { apiContract } from "./api-contract";
import { contractVerdictFromEnvelope, type ContractVerdict } from "./contract-shape";

export type BrowsePrimitive = "snap" | "fetch" | "read" | "go" | "navigate" | "click" | "type" | "submit" | "eval";

/** READ primitives are idempotent for a stable target → safe to recall. Everything else is an ACT
 *  (state-changing) and is NEVER memoized — `eval` defaults to ACT because it may mutate the page. */
const READ_PRIMITIVES = new Set<BrowsePrimitive>(["snap", "fetch", "read"]);

export function isReadPrimitive(p: BrowsePrimitive): boolean {
  return READ_PRIMITIVES.has(p);
}

export interface BrowseResult<T> {
  value: T;
  /** true only for a READ recall (muscle memory); an ACT is always false (it re-ran live). */
  recalled: boolean;
  primitive: BrowsePrimitive;
  _contract: ContractVerdict;
}

/**
 * contractBrowse — run a kuri-style browser primitive through the /contract substrate. A READ recalls
 * first (muscle memory) and falls to the live browser on a miss; an ACT always fires live (re-running
 * witness, never memoized). `run` is the legacy browser action (the kuri go/snap/click/eval call).
 */
export async function contractBrowse<T>(opts: {
  primitive: BrowsePrimitive;
  url: string;
  args?: unknown;
  /** the legacy browser action — kuri go/snap/click/eval (unbrowse's original design). */
  run: () => Promise<T>;
  /** READ-recall freshness window (ignored for an ACT). */
  ttlMs?: number;
  /** per-principal partition so an authed snapshot is never replayed cross-principal. */
  principal?: string;
  dir?: string;
}): Promise<BrowseResult<T>> {
  const { primitive, url } = opts;
  if (isReadPrimitive(primitive)) {
    // READ → recall-first muscle memory (the snap/fetch of a stable target)
    const r = await apiContract<T>({
      api: `browse.${primitive}`,
      args: { url, args: opts.args },
      ttlMs: opts.ttlMs,
      produce: opts.run,
      principal: opts.principal,
      dir: opts.dir,
    });
    return { value: r.value, recalled: r.recalled, primitive, _contract: r._contract };
  }
  // ACT → re-running witness, NEVER memoized (a recalled act is false witness — Decalogue cmd 9)
  const value = await opts.run();
  const env = { ok: true, primitive, url, recalled: false };
  return { value, recalled: false, primitive, _contract: contractVerdictFromEnvelope(env) };
}
