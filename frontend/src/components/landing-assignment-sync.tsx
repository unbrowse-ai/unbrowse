"use client";

import { useEffect } from "react";
import {
  LANDING_ASSIGNMENT_COOKIE,
  serializeLandingAssignment,
} from "@/lib/acquisition/context";

const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function LandingAssignmentSync() {
  useEffect(() => {
    const root = document.getElementById("landing-page-root");
    if (!root) return;

    const params = new URLSearchParams(window.location.search);
    if (params.has("variant_id") || params.has("seed")) return;

    const variantId = root.getAttribute("data-landing-variant-id");
    const icp = root.getAttribute("data-landing-icp") ?? undefined;
    const experimentId = root.getAttribute("data-landing-experiment-id") ?? undefined;
    if (!variantId || variantId === "default") return;

    const value = serializeLandingAssignment({
      variant_id: variantId,
      icp,
      experiment_id: experimentId,
    });

    document.cookie = `${LANDING_ASSIGNMENT_COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax`;
  }, []);

  return null;
}

