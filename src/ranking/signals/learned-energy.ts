/**
 * src/ranking/signals/learned-energy.ts — layer 3 of the EBM ledger-energy stack.
 *
 * Layer 1 (ledger-energy.ts) is the train-free back-off statistic P(success | domain,
 * endpoint, source). It is COLD on cells it has not seen ≥MIN_EVIDENCE times — it falls
 * back to NEUTRAL and cannot generalise. Layer 3 is a learned contrastive logistic head
 * fit OFFLINE on the same ledger (positives = successes, negatives = failures/fallbacks)
 * by `scripts/ebm/layer3_train.py` and shipped as a content-addressed pointer
 * (`bench/ebm/energy-head.latest.json`). It shares strength across features (source
 * reliability, domain priors, query n-grams) and so ranks sparse/cold cells the back-off
 * baseline is blind to — proven to beat it on held-out ranking (see scripts/ebm-layers-gate.py).
 *
 * Rollout is the pointer changing: a periodic refit (scripts/ebm-refit-cron.sh) ships a new
 * sha, and this loader re-reads it (pointer-cache invalidation). No head present → returns
 * null and the caller uses the back-off layer alone. The featurizer MUST match the python
 * trainer's `_featurize` byte-for-byte or the weights index the wrong buckets.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerEnergyCached, LEDGER_NEUTRAL } from "../../lib/ranking-core/signals/ledger-energy.js";
import { EMBEDDED_HEAD } from "./route-head.embedded.js";

const FEAT_DIM = 512;

function repoRoot(): string {
  // src/ranking/signals -> repo root is three up
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function pointerPath(): string {
  return process.env.UNBROWSE_EBM_HEAD || join(repoRoot(), "bench", "ebm", "energy-head.latest.json");
}

/** md5(tok) mod (FEAT_DIM-1) + 1 — identical bucketing to python `_featurize`. */
function bucket(tok: string): number {
  const hex = createHash("md5").update(tok).digest("hex");
  return Number(BigInt("0x" + hex) % BigInt(FEAT_DIM - 1)) + 1;
}

function featurize(domain: string, endpoint: string, source: string, intent: string): Map<number, number> {
  const feats = new Map<number, number>([[0, 1.0]]); // bias
  const put = (tok: string) => feats.set(bucket(tok), 1.0);
  put(`src=${source}`); put(`dom=${domain}`); put(`ep=${endpoint}`);
  put(`dom_ep=${domain}|${endpoint}`); put(`dom_src=${domain}|${source}`);
  const words = (intent || "").toLowerCase().split(/\s+/).filter(Boolean);
  for (const w of words) put(`w=${w}`);
  for (let i = 0; i + 1 < words.length; i++) put(`bg=${words[i]}_${words[i + 1]}`);
  return feats;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

interface Head {
  weights: number[];
  mtimeMs: number;
  sha: string;
}
let cached: Head | null = null;
let lastPointer = "";

/**
 * The compiled-in fallback head. On-disk pointers exist on a source checkout and a
 * machine that has run the refit, but the bundled npm/worker build flattens paths and
 * the vocab-scrub renames files — so no on-disk pointer ships to users. A static import
 * always travels with the bundle, so the loaded ranker works in EVERY runtime. Synthetic
 * embeds are refused (the generator only emits real, passing heads).
 */
function embeddedHead(): Head | null {
  const h = EMBEDDED_HEAD as { weights?: number[]; synthetic?: boolean; sha?: string } | null;
  if (!h || h.synthetic) return null;
  if (!Array.isArray(h.weights) || h.weights.length !== FEAT_DIM) return null;
  if (cached && lastPointer === "embedded" && cached.sha === h.sha) return cached;
  cached = { weights: h.weights, mtimeMs: 0, sha: h.sha || "embedded" };
  lastPointer = "embedded";
  return cached;
}

/** Load the shipped head, re-reading when the pointer file changes (rollout). null = none. */
function loadHead(): Head | null {
  if (process.env.UNBROWSE_LEARNED_ENERGY === "0") return null;
  const ptr = pointerPath();
  try {
    if (!existsSync(ptr)) return embeddedHead();
    const st = statSync(ptr);
    if (cached && lastPointer === ptr && cached.mtimeMs === st.mtimeMs) return cached;
    const meta = JSON.parse(readFileSync(ptr, "utf8")) as { pointer?: string; sha256_8?: string; synthetic?: boolean };
    const artName = meta.pointer;
    if (!artName) return embeddedHead();
    // The production ranker only trusts a head fit on the REAL ledger. A synthetic
    // (witness-only) head is refused unless explicitly allowed, so it can never move
    // real-domain ranking even if it lands in the live pointer.
    if (meta.synthetic && process.env.UNBROWSE_EBM_ALLOW_SYNTHETIC !== "1") return embeddedHead();
    const art = JSON.parse(readFileSync(join(dirname(ptr), artName), "utf8")) as { weights?: number[] };
    if (!Array.isArray(art.weights) || art.weights.length !== FEAT_DIM) return embeddedHead();
    cached = { weights: art.weights, mtimeMs: st.mtimeMs, sha: meta.sha256_8 || "" };
    lastPointer = ptr;
    return cached;
  } catch {
    return embeddedHead();
  }
}

/**
 * Learned P(success) for a route from the shipped energy head, or null when no head is
 * shipped (caller falls back to the layer-1 back-off energy). Fails closed to null.
 */
export function learnedEnergy(
  domain: string | undefined,
  endpointId: string | undefined,
  source?: string,
  intent?: string,
): number | null {
  const head = loadHead();
  if (!head || !endpointId) return null;
  const feats = featurize(domain ?? "", endpointId, source ?? "", intent ?? "");
  let z = 0;
  for (const [i, v] of feats) z += (head.weights[i] ?? 0) * v;
  return sigmoid(z);
}

/**
 * The blended route energy the ranker consumes: the layer-1 back-off statistic and the
 * layer-3 learned head, combined. When no learned head is shipped → pure back-off (layer 1
 * unchanged). When the back-off cell is COLD (NEUTRAL, no direct evidence) → trust the
 * learned head, which generalises there. Otherwise average the two. Always in [0,1].
 */
export function routeEnergy(
  domain: string | undefined,
  endpointId: string | undefined,
  source?: string,
  intent?: string,
): number {
  const backoff = ledgerEnergyCached(domain, endpointId, source);
  const learned = learnedEnergy(domain, endpointId, source, intent);
  if (learned === null) return backoff;
  if (Math.abs(backoff - LEDGER_NEUTRAL) < 1e-9) return learned; // back-off blind here
  return 0.5 * backoff + 0.5 * learned;
}

/** Test seam: drop the cached head so a fresh pointer is re-read. */
export function __resetLearnedCache(): void {
  cached = null;
  lastPointer = "";
}
