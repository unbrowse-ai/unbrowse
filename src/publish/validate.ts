export interface PublishGateEndpoint {
  success_rate: number;
  verified: boolean;
}

export interface PublishGateInput {
  skill_id: string;
  endpoints: PublishGateEndpoint[];
}

export type PublishGateResult =
  | { ok: true; mean_success_rate: number; verified_count: number }
  | {
      ok: false;
      next_action: "publish_rejected";
      reason:
        | "success_rate_below_floor"
        | "no_verified_endpoints"
        | "no_endpoints";
      detail: string;
      mean_success_rate: number;
      verified_count: number;
    };

export const MIN_SUCCESS_RATE = 0.5;
export const MIN_VERIFIED_ENDPOINTS = 1;

export function validatePublishGate(input: PublishGateInput): PublishGateResult {
  const endpoints = input.endpoints ?? [];
  if (endpoints.length === 0) {
    return {
      ok: false,
      next_action: "publish_rejected",
      reason: "no_endpoints",
      detail: `skill ${input.skill_id} has zero endpoints to publish`,
      mean_success_rate: 0,
      verified_count: 0,
    };
  }

  const rawMean =
    endpoints.reduce((sum, e) => sum + (e.success_rate ?? 0), 0) /
    endpoints.length;
  const meanSuccessRate = Number.isFinite(rawMean) ? rawMean : 0;
  const verifiedCount = endpoints.filter((e) => e.verified).length;

  if (!(meanSuccessRate >= MIN_SUCCESS_RATE)) {
    return {
      ok: false,
      next_action: "publish_rejected",
      reason: "success_rate_below_floor",
      detail: `mean endpoint success rate ${meanSuccessRate.toFixed(3)} < floor ${MIN_SUCCESS_RATE} (paper §6.1). Test against sandbox marketplace via UNBROWSE_PUBLISH_NAMESPACE=sandbox.`,
      mean_success_rate: meanSuccessRate,
      verified_count: verifiedCount,
    };
  }

  if (verifiedCount < MIN_VERIFIED_ENDPOINTS) {
    return {
      ok: false,
      next_action: "publish_rejected",
      reason: "no_verified_endpoints",
      detail: `skill ${input.skill_id} has ${verifiedCount} verified endpoints; needs >= ${MIN_VERIFIED_ENDPOINTS} (paper §6.1). Test against sandbox marketplace via UNBROWSE_PUBLISH_NAMESPACE=sandbox.`,
      mean_success_rate: meanSuccessRate,
      verified_count: verifiedCount,
    };
  }

  return {
    ok: true,
    mean_success_rate: meanSuccessRate,
    verified_count: verifiedCount,
  };
}
