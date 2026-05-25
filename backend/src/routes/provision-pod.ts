/**
 * POST /v1/contract/provision-pod — spawn the per-contract VM described
 * in docs/design/runpod-bound-contract-vm.md.
 *
 * Substrate-shape: this endpoint is itself an `iterated` event on the
 * provisioner contract (lineage-bound). Calling it appends an event to
 * the ledger; the pod's first POST-back appends another (signed by the
 * pod's env_pubkey).
 *
 * Wired into Hono router via:
 *   app.route("/v1", provisionPodRoutes)
 *
 * Auth: caller must present a signed declare-style envelope identifying
 * themselves as the contract's owner OR a lineage ancestor with write
 * scope. Same shape as #797 signed-declare.
 *
 * SCAFFOLD ONLY until Lewis approves the runpod cost ceiling + secrets
 * are provisioned. The route returns 503 with a clear "scaffold-only,
 * Lewis-approval-pending" message rather than throwing 500.
 */

import { Hono } from "hono";
import { makeRunpodAdapter, type PodSpawnRequest } from "../services/runpod-pod-adapter";
import { verifyDeclareSignature, type CanonicalDeclareBody } from "../services/declare-signature";

export interface ProvisionPodRequest {
  /** Contract id to inhabit. */
  contract_id: string;
  /** Caller's ed25519 pubkey — must be a lineage ancestor or self. */
  caller_pubkey: string;
  /** Signature over canonical envelope (action + contract_id + ts). */
  caller_signature: string;
  /** Timestamp the caller signed over — server checks against drift. */
  ts: string;
  /** Tier requested (default cpu-tiny — long-tail-cheap). */
  tier?: "cpu-tiny" | "cpu-small" | "gpu-t4" | "gpu-a100";
}

export interface ProvisionPodResponse {
  /** Provider pod id. */
  pod_id?: string;
  /** Mesh-only endpoint (lineage peers only). */
  mesh_endpoint?: string;
  /** Cost rate the pod was allocated at. */
  cost_per_sec_usdc?: number;
  /** Status — `provisioning` means the pod is booting; caller polls
   *  /v1/contract/status?id=<contract_id> for the iterated rows
   *  the pod will append once it's up. */
  status: "provisioning" | "scaffold-only" | "error";
  /** Human-readable detail. Always present when status !== "provisioning". */
  message?: string;
}

type ProvEnv = {
  RUNPOD_API_KEY?: string;
  RUNPOD_SPEND_CEILING_USDC_MONTHLY?: string;
  MESH_ACL_KV?: any;
};

export const provisionPodRoutes = new Hono<{ Bindings: ProvEnv }>();

provisionPodRoutes.post("/contract/provision-pod", async (c) => {
  const req = (await c.req.json()) as ProvisionPodRequest;
  if (!req.contract_id) {
    return c.json({ status: "error", message: "contract_id required" } as ProvisionPodResponse, 400);
  }
  if (!req.caller_pubkey || !req.caller_signature || !req.ts) {
    return c.json(
      { status: "error", message: "caller_pubkey + caller_signature + ts required" } as ProvisionPodResponse,
      400,
    );
  }

  // Verify caller's signature over the provision envelope. Same shape as
  // the #797 signed-declare — we reuse CanonicalDeclareBody with
  // action='provision-pod' as the signed action.
  const canonical: CanonicalDeclareBody = {
    plan: `provision-pod for ${req.contract_id}`,
    action: "provision-pod",
    parent_id: null,
    agent: null,
    wallet_identity: req.caller_pubkey,
    ts: req.ts,
  };
  const sigOk = await verifyDeclareSignature(canonical, req.caller_signature);
  if (!sigOk) {
    return c.json(
      { status: "error", message: "caller_signature invalid" } as ProvisionPodResponse,
      401,
    );
  }

  // Reconcile lineage: caller_pubkey must be on the contract's lineage
  // chain. The reader is wired in handleStatus — we reuse it (TODO: extract
  // into a shared `assertCallerInLineage` helper in a follow-up PR; for the
  // scaffold this branch is a placeholder that the live integration will fill).

  const adapter = makeRunpodAdapter(c.env);
  try {
    const result = await adapter.spawn({
      contract_id: req.contract_id,
      env_pubkey: "", // TODO: derive from libcontract lineage scheme
      mesh_acl_pubkeys: [req.caller_pubkey], // TODO: walk lineage chain
      tier: req.tier ?? "cpu-tiny",
      contract_plan: "", // TODO: read declared row
      contract_action: "",
    });
    return c.json({
      status: "provisioning",
      pod_id: result.pod_id,
      mesh_endpoint: result.mesh_endpoint,
      cost_per_sec_usdc: result.cost_per_sec_usdc,
    } as ProvisionPodResponse);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Scaffold-only path: surface the gating reason explicitly.
    return c.json(
      {
        status: "scaffold-only",
        message: msg,
      } as ProvisionPodResponse,
      503,
    );
  }
});
