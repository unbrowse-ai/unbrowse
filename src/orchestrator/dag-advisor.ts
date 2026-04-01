/**
 * DAG advisory planner bridge — backend-first with local fallback (Issue #218).
 *
 * The orchestrator calls fetchDagAdvisoryPlan with a full SkillManifest.
 * This module tries the backend graph (via fetchChain) first for cross-session
 * intelligence, then falls back to the local planner when the backend is
 * unavailable or returns no data.
 */

import type { SkillManifest } from "../types/index.js";
import {
  fetchDagAdvisoryPlan as localFetchDagAdvisoryPlan,
  applyDagAdvisoryBoosts,
} from "../graph/planner.js";
import type { DagAdvisoryPlan } from "../graph/planner.js";
import { fetchChain } from "../client/graph-client.js";

export { applyDagAdvisoryBoosts };
export type { DagAdvisoryPlan };

/**
 * Fetch a DAG advisory plan — tries backend graph first, falls back to local.
 *
 * @param skill  The full skill manifest (used for local fallback planning).
 * @param targetEndpointId  The endpoint we want to execute.
 * @param knownBindingKeys  Binding keys already available from context/params.
 */
export async function fetchDagAdvisoryPlan(
  skill: SkillManifest,
  targetEndpointId: string,
  knownBindingKeys: string[],
): Promise<DagAdvisoryPlan> {
  // Try backend graph first — provides cross-session intelligence
  if (skill.domain) {
    try {
      const chain = await fetchChain(skill.domain, targetEndpointId, knownBindingKeys);
      if (chain && Array.isArray(chain.chain) && chain.chain.length > 0) {
        // Validate that chain endpoints exist in the local skill — discard stale backend data
        const localEndpointIds = new Set(skill.endpoints.map((ep) => ep.endpoint_id));
        const validPrereqs = chain.chain.filter(
          (link) => link.endpoint_id !== targetEndpointId && localEndpointIds.has(link.endpoint_id),
        );
        if (validPrereqs.length > 0) {
          return {
            chain_ready: chain.resolved ?? true,
            prerequisite_order: validPrereqs.map((link) => link.endpoint_id),
            predicted_next: [],
            skippable: [],
          };
        }
      }
    } catch {
      // Backend unavailable — fall through to local planner
    }
  }

  // Local fallback — uses the in-memory operation graph
  return localFetchDagAdvisoryPlan(skill, targetEndpointId, knownBindingKeys);
}
