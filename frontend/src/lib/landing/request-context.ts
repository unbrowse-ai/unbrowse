import type { AcquisitionContext, LandingAssignment } from "@/lib/acquisition/context";
import { resolveLandingRequestContext } from "@/lib/acquisition/context";

export interface LandingSearchParams {
  variantId?: string;
  icp?: string;
  experimentId?: string;
  seed?: string;
}

export function buildLandingRequestContext(args: {
  searchParams: LandingSearchParams;
  visitorId?: string;
  inferredIcp?: string;
  firstTouch?: AcquisitionContext | null;
  assignment?: LandingAssignment | null;
}) {
  return resolveLandingRequestContext({
    searchParams: args.searchParams,
    visitorId: args.visitorId,
    inferredIcp: args.inferredIcp,
    firstTouch: args.firstTouch,
    assignment: args.assignment,
  });
}

