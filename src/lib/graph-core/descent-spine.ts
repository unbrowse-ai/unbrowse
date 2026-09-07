/**
 * descent-spine — P2 of the hole-descent-dag: route the cross-layer dep chain into a
 * single SIGNED descent under one wallet root. P1 connected a hole to its producer at
 * the layer below (resolveHoleDep). This walks that connection ALL THE WAY DOWN the
 * descent ladder — screen → browser → cli → os → kernel → packet — and seals the whole
 * "string of deps" with signed-descent: every layer's operation chains to the one above
 * and descends from the same wallet key (the Crypto-paper claim, made runnable).
 *
 * The layers we actually capture today (browser, cli — and the skill/internal-api ops
 * that ride the cli layer) carry REAL operations resolved from the hole-dep edges. The
 * layers we do not yet capture (screen, os, kernel, packet) land as TYPED STUBS behind
 * the same edge type — present in the chain and marked `stub:`, so they verify as stubs,
 * never silent gaps. When capture for a layer lands, its stub is replaced by a real op
 * with zero shape change (the bottle was built for all six from day one).
 */
import { descend, verifyDescent, LAYERS, type DescentRecord, type DescentLayer } from "../../values/signed-descent.js";
import type { HoleDep } from "../../capture/hole-template.js";

/** A resolved op at one descent layer: either a real hole-dep edge or a typed stub. */
export interface LayerOp {
  layer: DescentLayer;
  /** the concrete operation string sealed at this layer (e.g. producer:binding). */
  op: string;
  /** true when this layer is not yet captured — present + marked, not a silent gap. */
  stub: boolean;
}

/** The signed cross-layer spine: the descent chain + which layers were stubs. */
export interface DescentSpine {
  chain: DescentRecord[];
  layers: LayerOp[];
}

/** Render a hole-dep edge into its canonical op string for a layer (producer:binding). */
function opFromDep(dep: HoleDep): string {
  return `${dep.producer}:${dep.binding}`;
}

/**
 * Assemble the per-layer ops from the dep edges the agent mapped. `depsByLayer` carries
 * the REAL edges for captured layers; any layer with no edge becomes a typed stub. The
 * order is always the full six-layer ladder (top→wire) so the spine has a fixed shape.
 */
export function layerOpsFromDeps(depsByLayer: Partial<Record<DescentLayer, HoleDep>>): LayerOp[] {
  return LAYERS.map((layer) => {
    const dep = depsByLayer[layer];
    return dep
      ? { layer, op: opFromDep(dep), stub: false }
      : { layer, op: `stub:${layer}`, stub: true };
  });
}

/**
 * Build the signed descent spine for `intent` from the agent-mapped dep edges. Seals all
 * six layers under one wallet root (descend). Returns the chain + the per-layer record so
 * a caller can see which layers were real vs stub. The raw secret never enters — only the
 * op string (producer:binding) and the wallet signature.
 */
export async function buildDescentSpine(
  intent: string,
  depsByLayer: Partial<Record<DescentLayer, HoleDep>>,
): Promise<DescentSpine> {
  const layers = layerOpsFromDeps(depsByLayer);
  const ops: Record<string, string> = {};
  for (const l of layers) ops[l.layer] = l.op;
  const chain = await descend(intent, ops);
  return { chain, layers };
}

/**
 * Seal the spine: every layer signed by the SAME wallet root + correctly chained
 * (verifyDescent), AND every layer accounted for — a stub is allowed but must be marked,
 * never an empty/missing op masquerading as real. Fails closed.
 */
export function verifyDescentSpine(spine: DescentSpine, expectRoot: string): boolean {
  if (!verifyDescent(spine.chain, expectRoot)) return false;
  if (spine.layers.length !== LAYERS.length) return false;
  for (const l of spine.layers) {
    // a stub must be explicitly marked AND carry the stub: op; a real layer must not.
    const isStubOp = l.op.startsWith("stub:");
    if (l.stub !== isStubOp) return false;
    if (!l.op) return false; // no silent gap
  }
  return true;
}
