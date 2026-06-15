/**
 * learned-energy-core — the fs-free EBM leaf. node:crypto only (the md5 featurizer), NO node:fs, so
 * it bundles into the Cloudflare worker (nodejs_compat) as cleanly as it does the CLI. Both the
 * client ranker (learned-energy.ts, which adds the fs rollout-pointer loader) and the server ranker
 * (backend rank.ts, embedded-head only) import from here, so the featurizer + head math live in ONE
 * place and stay byte-identical to the python trainer.
 */
import { createHash } from "node:crypto";
import { EMBEDDED_HEAD } from "./route-head.embedded.js";

export const FEAT_DIM = 512;
/** Neutral P(success): no opinion. Matches the ledger neutral so blends compose cleanly. */
export const LEARNED_NEUTRAL = 0.5;

export interface Head {
  weights: number[];
  sha: string;
}

/** md5(tok) mod (FEAT_DIM-1) + 1 — identical bucketing to the python trainer's `_featurize`. */
function bucket(tok: string): number {
  const hex = createHash("md5").update(tok).digest("hex");
  return Number(BigInt("0x" + hex) % BigInt(FEAT_DIM - 1)) + 1;
}

export function featurize(domain: string, endpoint: string, source: string, intent: string): Map<number, number> {
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

/** sigmoid(w·featurize(...)) — the head's P(success) for a route. */
export function scoreWithHead(head: Head, domain: string, endpointId: string, source: string, intent: string): number {
  const feats = featurize(domain, endpointId, source, intent);
  let z = 0;
  for (const [i, v] of feats) z += (head.weights[i] ?? 0) * v;
  return sigmoid(z);
}

let embedded: Head | null | undefined;
/**
 * The compiled-in head — real (non-synthetic), FEAT_DIM weights. Travels in every bundle (no fs), so
 * the learned ranker works in the worker AND the CLI. Synthetic embeds are refused.
 */
export function embeddedHead(): Head | null {
  if (embedded !== undefined) return embedded;
  const h = EMBEDDED_HEAD as { weights?: number[]; synthetic?: boolean; sha?: string } | null;
  embedded =
    h && !h.synthetic && Array.isArray(h.weights) && h.weights.length === FEAT_DIM
      ? { weights: h.weights, sha: h.sha || "embedded" }
      : null;
  return embedded;
}

/** Learned P(success) from the EMBEDDED head only — no fs/pointer (worker-safe). null = no head. */
export function learnedEnergyEmbedded(
  domain: string | undefined,
  endpointId: string | undefined,
  source?: string,
  intent?: string,
): number | null {
  const head = embeddedHead();
  if (!head || !endpointId) return null;
  return scoreWithHead(head, domain ?? "", endpointId, source ?? "", intent ?? "");
}

/**
 * Blend a GIVEN back-off (e.g. the durable statsKV reliability_score on the server, or the fs ledger
 * energy on the client) with the embedded learned head. No head → the back-off unchanged. Back-off
 * blind (NEUTRAL) → trust the head, which generalises to cold routes. Else average. Always [0,1].
 */
export function routeEnergyFromBackoff(
  backoff: number,
  domain: string | undefined,
  endpointId: string | undefined,
  source?: string,
  intent?: string,
): number {
  const learned = learnedEnergyEmbedded(domain, endpointId, source, intent);
  if (learned === null) return backoff;
  if (Math.abs(backoff - LEARNED_NEUTRAL) < 1e-9) return learned;
  return 0.5 * backoff + 0.5 * learned;
}
