/**
 * spine-store — P4 of the hole-descent-dag: persist the agent-judged cross-layer descent
 * spine to LOCAL DISK and replay it. The judged map is computed once (the agent maps the
 * deps via the harness), sealed under the wallet root (P2), then stored keyed by
 * (domain, target). A later request for the same (domain, target) REPLAYS the stored
 * spine instead of re-judging — re-judging only on a MISS (never stored) or STALE (the
 * inputs changed, detected by a fingerprint mismatch). "Judge once, persist, replay."
 *
 * Only the spine (op strings + signatures, no raw secret — see P0/P2) is written; the
 * store carries the dependency SHAPE and the wallet seal, never a credential value.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DescentSpine } from "./descent-spine.js";

interface StoredSpine {
  /** fingerprint of the inputs the spine was judged from; mismatch ⇒ stale ⇒ re-judge. */
  fingerprint: string;
  spine: DescentSpine;
}

/** Replay key = (domain, target). Sanitized so an exotic domain/target can't escape dir. */
function keyPath(dir: string, domain: string, target: string): string {
  const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 200);
  return join(dir, `spine_${safe(domain)}__${safe(target)}.json`);
}

/**
 * Persist a judged spine under (domain, target) with the input `fingerprint`. Creates the
 * store dir if absent (mkdir -p). The fingerprint is whatever the caller derives from the
 * judged inputs (e.g. a hash of the dep map + intent) — its only contract is: it changes
 * iff the spine should be re-judged.
 */
export function persistSpine(
  dir: string,
  domain: string,
  target: string,
  spine: DescentSpine,
  fingerprint: string,
): void {
  mkdirSync(dir, { recursive: true });
  const payload: StoredSpine = { fingerprint, spine };
  writeFileSync(keyPath(dir, domain, target), JSON.stringify(payload), "utf8");
}

/**
 * Replay a stored spine for (domain, target). Returns the spine ONLY if it exists AND its
 * stored fingerprint matches `fingerprint` (fresh). Returns null on a MISS (never stored)
 * or STALE (fingerprint changed) — both meaning the caller must re-judge. Corrupt JSON is
 * treated as a miss (fails safe to re-judge, never throws).
 */
export function loadSpine(
  dir: string,
  domain: string,
  target: string,
  fingerprint: string,
): DescentSpine | null {
  const p = keyPath(dir, domain, target);
  if (!existsSync(p)) return null; // miss
  try {
    const stored = JSON.parse(readFileSync(p, "utf8")) as StoredSpine;
    if (stored?.fingerprint !== fingerprint) return null; // stale → re-judge
    return stored.spine ?? null;
  } catch {
    return null; // corrupt → re-judge
  }
}
