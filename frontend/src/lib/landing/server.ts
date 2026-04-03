import "server-only";

import { cache } from "react";
import type { LandingVariant, ResolvedLandingVariantResponse } from "./types";

const API_BASE = "https://beta-api.unbrowse.ai/v1";

export const getLandingVariant = cache(
  async (opts: { variantId?: string; icp?: string; experimentId?: string; seed?: string } = {}): Promise<LandingVariant | null> => {
    const query = new URLSearchParams();
    if (opts.variantId) query.set("variant_id", opts.variantId);
    if (opts.icp) query.set("icp", opts.icp);
    if (opts.experimentId) query.set("experiment_id", opts.experimentId);
    if (opts.seed) query.set("seed", opts.seed);
    if ([...query.keys()].length === 0) return null;

    try {
      const res = await fetch(`${API_BASE}/landing/resolve?${query.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) return null;
      const data = await res.json() as ResolvedLandingVariantResponse;
      return data.variant ?? null;
    } catch {
      return null;
    }
  },
);
