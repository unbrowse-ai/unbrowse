/**
 * src/ranking/signals/learned-energy.ts — the CLIENT layer-3 of the EBM ledger-energy stack.
 *
 * The fs-free EBM leaf (featurizer + embedded head + the blend) lives in learned-energy-core.ts so
 * it bundles into the worker too. This module adds the CLIENT-only piece: the on-disk rollout pointer
 * (`bench/ebm/energy-head.latest.json`) so a refit ships a new head to long-lived CLI processes
 * without a rebuild. No pointer on disk (or no fs — a worker) → the embedded head. The featurizer
 * MUST match the python trainer byte-for-byte; that guarantee is enforced once, in the core.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerEnergyCached, LEDGER_NEUTRAL } from "../../lib/ranking-core/signals/ledger-energy.js";
import {
  FEAT_DIM, scoreWithHead, embeddedHead as embeddedCoreHead, type Head,
  learnedEnergyEmbedded, routeEnergyFromBackoff,
} from "./learned-energy-core.js";

// Re-export the fs-free leaf so server + client import the same names.
export { learnedEnergyEmbedded, routeEnergyFromBackoff } from "./learned-energy-core.js";

interface LoadedHead extends Head {
  mtimeMs: number;
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
function pointerPath(): string {
  return process.env.UNBROWSE_EBM_HEAD || join(repoRoot(), "bench", "ebm", "energy-head.latest.json");
}

let cached: LoadedHead | null = null;
let lastPointer = "";

function embeddedLoaded(): LoadedHead | null {
  const h = embeddedCoreHead();
  if (!h) return null;
  if (cached && lastPointer === "embedded" && cached.sha === h.sha) return cached;
  cached = { weights: h.weights, sha: h.sha, mtimeMs: 0 };
  lastPointer = "embedded";
  return cached;
}

/** Load the shipped head, re-reading when the pointer file changes (rollout). null = none → embedded. */
function loadHead(): LoadedHead | null {
  if (process.env.UNBROWSE_LEARNED_ENERGY === "0") return null;
  const ptr = pointerPath();
  try {
    if (!existsSync(ptr)) return embeddedLoaded();
    const st = statSync(ptr);
    if (cached && lastPointer === ptr && cached.mtimeMs === st.mtimeMs) return cached;
    const meta = JSON.parse(readFileSync(ptr, "utf8")) as { pointer?: string; sha256_8?: string; synthetic?: boolean };
    if (!meta.pointer) return embeddedLoaded();
    if (meta.synthetic && process.env.UNBROWSE_EBM_ALLOW_SYNTHETIC !== "1") return embeddedLoaded();
    const art = JSON.parse(readFileSync(join(dirname(ptr), meta.pointer), "utf8")) as { weights?: number[] };
    if (!Array.isArray(art.weights) || art.weights.length !== FEAT_DIM) return embeddedLoaded();
    cached = { weights: art.weights, mtimeMs: st.mtimeMs, sha: meta.sha256_8 || "" };
    lastPointer = ptr;
    return cached;
  } catch {
    return embeddedLoaded();
  }
}

/** Learned P(success) for a route from the shipped head (fs pointer or embedded), or null. */
export function learnedEnergy(
  domain: string | undefined,
  endpointId: string | undefined,
  source?: string,
  intent?: string,
): number | null {
  const head = loadHead();
  if (!head || !endpointId) return null;
  return scoreWithHead(head, domain ?? "", endpointId, source ?? "", intent ?? "");
}

/**
 * The blended route energy the client ranker consumes: the layer-1 fs back-off and the layer-3
 * learned head. No head → pure back-off. Cold back-off (NEUTRAL) → the head. Else averaged. [0,1].
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
  if (Math.abs(backoff - LEDGER_NEUTRAL) < 1e-9) return learned;
  return 0.5 * backoff + 0.5 * learned;
}

/** Test seam: drop the cached head so a fresh pointer is re-read. */
export function __resetLearnedCache(): void {
  cached = null;
  lastPointer = "";
}
