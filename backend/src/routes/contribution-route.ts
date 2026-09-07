/**
 * contribution-route — the HTTP surface for the ZK-gated delta contribution
 * (deploy wiring for plan node 5). SERVER-ONLY.
 *
 *   POST /v1/contribute       body {delta, validity, attestation} → validate at the gate,
 *                             merge into the shared graph, record the verified attribution,
 *                             return the receipt + new graph root.
 *   GET  /v1/contribute/root  the current Merkle root + endpoint count of the shared graph.
 *
 * The route is cryptographically gated, NOT api-key gated: the bounded-validity proof, the
 * execution attestation, and the wallet signature ARE the identity (trustless / ERC-8004
 * shape). A forged or unproven contribution is rejected by the gate, never admitted, never
 * recorded, never earns. Rate-limited only, for anti-spam. The shared graph + ledger persist
 * in KV (graph-store); the on-chain Merkle checkpoint + live x402 payout are the next deploy
 * step (the root returned here is exactly the value a checkpoint would publish).
 */
import { Hono } from "hono";
import type { Env } from "../types.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { graphRoot, gateAndCompare, type Contribution } from "../services/graph-merge/index.js";
import { deltaId } from "../../../src/values/route-delta.js";
import {
  makeGraphKV, buildEmergentGraphKV, loadGraph, loadWinner, saveWinner,
  appendLedgerRecord, ledgerNextSeq, type GraphKV,
} from "../services/graph-store.js";

export const contributionRoutes = new Hono<{ Bindings: Env }>();

contributionRoutes.use("/contribute", rateLimit({ limit: 60, window: 60, prefix: "contribute" }));
contributionRoutes.use("/contribute/*", rateLimit({ limit: 120, window: 60, prefix: "contribute-read" }));

/** The graph store. EmergentDB-primary is OPT-IN via UNBROWSE_GRAPH_STORE=emergentdb (its
 *  per-endpoint logic is unit-green, but the live workerd EdbKV path is still being debugged —
 *  a Buffer/crypto arg-type error that does not occur locally). Default = the dedicated CF
 *  GRAPH_KV primary + STATS_KV fallback (makeGraphKV), which is verified working on staging.
 *  When EmergentDB is enabled it is wrapped over CF (FallbackGraphKV) so a primary error
 *  degrades to CF rather than 500. */
function graphStore(env: Env): { kv: GraphKV | null; tier: string } {
  const useEmergent = (env as { UNBROWSE_GRAPH_STORE?: string }).UNBROWSE_GRAPH_STORE === "emergentdb";
  let emergent: GraphKV | null = null;
  if (useEmergent) {
    try { emergent = buildEmergentGraphKV(env as unknown as Parameters<typeof buildEmergentGraphKV>[0]); }
    catch { emergent = null; }
  }
  return makeGraphKV(env as unknown as Parameters<typeof makeGraphKV>[0], { emergent });
}

contributionRoutes.post("/contribute", async (c) => {
  const { kv, tier } = graphStore(c.env);
  if (!kv) return c.json({ ok: false, error: "graph store unavailable", next_step: "retry_later" }, 503);

  let body: Contribution;
  try {
    body = (await c.req.json()) as Contribution;
  } catch {
    return c.json({ ok: false, error: "invalid json" }, 400);
  }
  if (!body?.delta || !body?.validity || !body?.attestation) {
    return c.json({ ok: false, error: "expected {delta, validity, attestation}" }, 400);
  }

  // The gate is pure (no store) — a forged contribution is rejected even if the store is down.
  const current = await loadWinner(kv, body.delta.endpoint).catch(() => null);
  const result = gateAndCompare(current, body);
  if (!result.admitted) {
    return c.json({ ok: false, admitted: false, reason: result.reason }, 422);
  }
  try {
    // O(1) per-endpoint persist: one winner key + one ledger key.
    await saveWinner(kv, body.delta);
    const seq = await ledgerNextSeq(kv);
    await appendLedgerRecord(kv, {
      deltaId: deltaId(body.delta),
      endpoint: body.delta.endpoint,
      contributor: body.delta.walletRoot,
      freshness: body.delta.freshness,
      seq,
    });
    const g = await loadGraph(kv);
    return c.json({
      ok: true,
      admitted: true,
      deltaId: deltaId(body.delta),
      endpoint: body.delta.endpoint,
      contributor: body.delta.walletRoot,
      graphRoot: graphRoot(g),
      graphSize: g.winners.size,
      store: tier,
    });
  } catch (e) {
    return c.json({ ok: false, error: "graph store write failed", reason: String(e).slice(0, 160), store: tier }, 503);
  }
});

contributionRoutes.get("/contribute/root", async (c) => {
  const { kv, tier } = graphStore(c.env);
  if (!kv) return c.json({ ok: false, error: "graph store unavailable" }, 503);
  try {
    const g = await loadGraph(kv);
    return c.json({ ok: true, root: graphRoot(g), endpoints: g.winners.size, store: tier });
  } catch (e) {
    return c.json({ ok: false, error: "graph store read failed", reason: String(e).slice(0, 160), store: tier }, 503);
  }
});
