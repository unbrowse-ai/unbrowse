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
import { graphRoot, type Contribution } from "../services/graph-merge/index.js";
import { submitContribution } from "./contribution.js";
import {
  loadGraph, saveGraph, loadLedger, saveLedger, type GraphKV,
} from "../services/graph-store.js";

export const contributionRoutes = new Hono<{ Bindings: Env }>();

contributionRoutes.use("/contribute", rateLimit({ limit: 60, window: 60, prefix: "contribute" }));
contributionRoutes.use("/contribute/*", rateLimit({ limit: 120, window: 60, prefix: "contribute-read" }));

/** The KV the shared graph lives in. STATS_KV is the one namespace provisioned (real id)
 *  in every env, so the shared graph uses it under a `contrib:` key prefix; a dedicated
 *  namespace is a later refinement. Honest-fail when no KV is available at all. */
function graphKV(env: Env): GraphKV | null {
  const kv = env.STATS_KV as unknown as GraphKV | undefined;
  return kv ?? null;
}

contributionRoutes.post("/contribute", async (c) => {
  const kv = graphKV(c.env);
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

  const g = await loadGraph(kv);
  const ledger = await loadLedger(kv);
  const receipt = submitContribution(g, ledger, body);

  if (!receipt.admitted) {
    // rejected at the gate — nothing persisted
    return c.json({ ok: false, admitted: false, reason: receipt.reason }, 422);
  }
  await saveGraph(kv, g);
  await saveLedger(kv, ledger);
  return c.json({
    ok: true,
    admitted: true,
    deltaId: receipt.deltaId,
    endpoint: receipt.endpoint,
    contributor: receipt.contributor,
    graphRoot: receipt.graphRoot,
    graphSize: g.winners.size,
  });
});

contributionRoutes.get("/contribute/root", async (c) => {
  const kv = graphKV(c.env);
  if (!kv) return c.json({ ok: false, error: "graph store unavailable" }, 503);
  const g = await loadGraph(kv);
  return c.json({ ok: true, root: graphRoot(g), endpoints: g.winners.size });
});
