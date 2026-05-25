/**
 * Runpod pod adapter — provisions per-contract VMs whose own sleep() IS the
 * substrate clock for that contract. See docs/design/runpod-bound-contract-vm.md.
 *
 * Substrate-faithful properties:
 *   - One adapter per provider (Runpod here; Fly.io / Hetzner are siblings
 *     of this same factory pattern)
 *   - Cost-bounded: every spawn checks the rolling-30d-spend ceiling
 *     declared on the parent provisioner contract; over-cap = 402-shaped
 *     refusal, not silent over-spend
 *   - Identity-bound: every pod's WireGuard pubkey IS the contract's
 *     env_pubkey (derived from lineage root key); the mesh ACL IS the
 *     lineage chain
 *
 * SCAFFOLD ONLY. The actual fetch() calls to api.runpod.io are stubbed
 * pending Lewis's go-ahead on:
 *   1. Hard monthly spend ceiling
 *   2. Mesh transport (WireGuard vs Tailscale)
 *   3. Pod TTL default
 *   4. CPU-only vs always-GPU-ready default tier
 * The shape is locked here so the live integration is a one-edit unlock
 * once the answers land.
 */

export interface PodSpawnRequest {
  /** Contract id this pod will inhabit (the pod's name + identity). */
  contract_id: string;
  /** Ed25519 pubkey hex — pod's WireGuard identity. Derived from
   *  lineage root key + contract_id; see libcontract/lineage.zig. */
  env_pubkey: string;
  /** Pubkey allowlist for inbound mesh dials. Equals the contract's
   *  lineage chain (parent_id walk + descendants via contract:<id>
   *  synapses) — see isCallerInLineage in services/contract-ledger.ts. */
  mesh_acl_pubkeys: string[];
  /** Tier signal from the declared row. CPU is the default and the
   *  long-tail-cheap case; GPU triggers when the contract's action
   *  explicitly declares inference need. */
  tier: "cpu-tiny" | "cpu-small" | "gpu-t4" | "gpu-a100";
  /** Optional `at:<RFC3339>` from the contract's synapses — pod sleeps
   *  until then before firing. Null = fire immediately on boot. */
  fire_at?: string;
  /** Optional `repeat:<cron>` — pod loops with this schedule after
   *  initial fire. */
  repeat_cron?: string;
  /** Pod's plan + action — pasted into env so the pod's runtime
   *  loop reads the contract's declared intent and dispatches. */
  contract_plan: string;
  contract_action: string;
}

export interface PodSpawnResult {
  /** Provider-side pod id (Runpod's internal identifier). */
  pod_id: string;
  /** Mesh-only address. NOT a public IP. Reachable only by peers whose
   *  pubkey appears in mesh_acl_pubkeys. */
  mesh_endpoint: string;
  /** Provider tier actually allocated (may downgrade tier on capacity). */
  tier_allocated: string;
  /** Per-second cost rate from the provider. Used for the rolling-
   *  spend tracking on the provisioner contract. */
  cost_per_sec_usdc: number;
}

export interface PodTerminateRequest {
  contract_id: string;
  pod_id: string;
  reason: "satisfied" | "dead" | "ttl-exceeded" | "user-teardown";
}

export interface PodTerminateResult {
  pod_id: string;
  total_uptime_seconds: number;
  total_cost_usdc: number;
}

/**
 * Provisioner-contract API. Each method maps 1:1 onto a contract action
 * that the substrate fires via parent-child propagation (per the HOLD-is-
 * non-terminal rule). Calling spawn() is itself an `iterated` event on
 * the provisioner contract; the iterate carries the pod_id forward.
 */
export interface RunpodPodAdapter {
  spawn(req: PodSpawnRequest): Promise<PodSpawnResult>;
  status(pod_id: string): Promise<PodStatusResult>;
  terminate(req: PodTerminateRequest): Promise<PodTerminateResult>;
}

export interface PodStatusResult {
  pod_id: string;
  /**
   * Pod lifecycle states. `sleeping` = inside `Bun.sleep()` until fire_at;
   * `firing` = action running; `repeating` = waiting for next cron tick;
   * `idle-reapable` = no activity for > N min, candidate for pause.
   */
  state: "provisioning" | "sleeping" | "firing" | "repeating" | "idle-reapable" | "terminated";
  uptime_seconds: number;
  cost_so_far_usdc: number;
}

const RUNPOD_API_BASE = "https://api.runpod.io/v2";

/**
 * Factory. The single source of truth for the adapter; everything else
 * (provision-pod route, mesh ACL store) reads through this.
 *
 * `env` carries the secrets bound to the running Worker:
 *   - RUNPOD_API_KEY   — secret (set via wrangler secret)
 *   - RUNPOD_SPEND_CEILING_USDC_MONTHLY — wrangler var
 *   - MESH_ACL_KV      — KV binding holding the lineage ACL store
 */
export function makeRunpodAdapter(env: {
  RUNPOD_API_KEY?: string;
  RUNPOD_SPEND_CEILING_USDC_MONTHLY?: string;
  MESH_ACL_KV?: KVNamespace;
}): RunpodPodAdapter {
  return {
    async spawn(req: PodSpawnRequest): Promise<PodSpawnResult> {
      if (!env.RUNPOD_API_KEY) {
        throw new Error(
          "[runpod-adapter] RUNPOD_API_KEY secret not set — scaffold-only mode. " +
          "Lewis must approve cost ceiling + provision the secret via " +
          "`bunx wrangler secret put RUNPOD_API_KEY` before this can fire.",
        );
      }
      // Spend-ceiling guard. Real implementation queries the running
      // 30-day window from EmergentDB; this scaffold throws if not set
      // so the failure mode is loud (no silent over-spend).
      if (!env.RUNPOD_SPEND_CEILING_USDC_MONTHLY) {
        throw new Error(
          "[runpod-adapter] RUNPOD_SPEND_CEILING_USDC_MONTHLY var unset. " +
          "Hard ceiling must be declared before any pod is provisioned. " +
          "Recommended starter: $50/mo (allows ~10 always-on CPU pods or " +
          "~1k pod-hours of intermittent fire-and-sleep).",
        );
      }

      // ---- LIVE INTEGRATION (gated; not exercised until env vars land) ----
      // const podSpec = buildRunpodSpec(req);
      // const res = await fetch(`${RUNPOD_API_BASE}/pods`, {
      //   method: "POST",
      //   headers: {
      //     "content-type": "application/json",
      //     authorization: `Bearer ${env.RUNPOD_API_KEY}`,
      //   },
      //   body: JSON.stringify(podSpec),
      // });
      // const data = await res.json();
      // await env.MESH_ACL_KV?.put(
      //   `pod:${data.id}`,
      //   JSON.stringify({ allowed: req.mesh_acl_pubkeys, contract: req.contract_id }),
      // );
      // return { pod_id: data.id, mesh_endpoint: data.privateIp, tier_allocated: data.tier, cost_per_sec_usdc: data.costPerSec };

      throw new Error(
        "[runpod-adapter] scaffold-only — live POST /pods call gated on Lewis approval",
      );
    },

    async status(pod_id: string): Promise<PodStatusResult> {
      if (!env.RUNPOD_API_KEY) {
        throw new Error("[runpod-adapter] scaffold-only mode (no RUNPOD_API_KEY)");
      }
      // const res = await fetch(`${RUNPOD_API_BASE}/pods/${pod_id}`, {
      //   headers: { authorization: `Bearer ${env.RUNPOD_API_KEY}` },
      // });
      // const data = await res.json();
      // return { pod_id, state: mapRunpodStateToPodState(data.status), uptime_seconds: data.uptime, cost_so_far_usdc: data.cost };
      throw new Error("[runpod-adapter] scaffold-only — live status call gated");
    },

    async terminate(req: PodTerminateRequest): Promise<PodTerminateResult> {
      if (!env.RUNPOD_API_KEY) {
        throw new Error("[runpod-adapter] scaffold-only mode (no RUNPOD_API_KEY)");
      }
      // const res = await fetch(`${RUNPOD_API_BASE}/pods/${req.pod_id}`, {
      //   method: "DELETE",
      //   headers: { authorization: `Bearer ${env.RUNPOD_API_KEY}` },
      // });
      // const data = await res.json();
      // await env.MESH_ACL_KV?.delete(`pod:${req.pod_id}`);
      // return { pod_id: req.pod_id, total_uptime_seconds: data.uptime, total_cost_usdc: data.cost };
      throw new Error("[runpod-adapter] scaffold-only — live terminate call gated");
    },
  };
}

// Minimal types for the KV / Hono env binding so this file typechecks
// against the existing Worker setup without pulling in unrelated infra.
type KVNamespace = {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
};
