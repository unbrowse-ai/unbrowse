import { fetchWithTimeout } from "@/lib/server-fetch";

export interface LandingVariantCopy {
  hero_headline: string;
  hero_emphasis: string;
  hero_subheadline: string;
  hero_support_line: string;
  trust_bar_order: Array<"benchmarks" | "speed" | "paper" | "github" | "npm">;
  definition_heading: string;
  definition_body: string;
  install_eyebrow: string;
  install_body: string;
  hero_cta_label?: string;
}

export interface LandingAssignmentEnvelope {
  assignment: {
    experiment_id: string;
    variant_id: string;
    assigned_at: string;
  };
  content: LandingVariantCopy;
  status: "shadow" | "canary" | "active" | "disabled";
}

const DEFAULT_ASSIGNMENT: LandingAssignmentEnvelope = {
  assignment: {
    experiment_id: "homepage-2026-04-browser-replacement",
    variant_id: "control-browser-replacement",
    assigned_at: "2026-04-03T00:00:00.000Z",
  },
  status: "active",
  content: {
    hero_headline: "A drop-in replacement",
    hero_emphasis: "for browser automation.",
    hero_subheadline:
      "Built for agent stacks that are tired of repeating the same browser workflow on every run. Unbrowse learns the request path behind the page, so repeat tasks run faster, cheaper, and with less breakage than driving the DOM every time.",
    hero_support_line: "Same websites. Same permissions. Same browser fallback when needed.",
    trust_bar_order: ["benchmarks", "speed", "paper", "github", "npm"],
    definition_heading: "The browser slot stays. The execution path changes.",
    definition_body:
      "Unbrowse is a drop-in replacement for browser automation in agent stacks. On the first pass it can use a real browser to capture the site's request flow. On later runs it reuses that learned route as a skill. The browser stays available for auth and hard cases, but repeated browser work becomes reusable infrastructure instead of repeated cost.",
    install_eyebrow: "Replace The Browser",
    install_body: "Install the runtime, then replace repeated browser automation with learned routes your agent can reuse.",
    hero_cta_label: "Copy Install",
  },
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://beta-api.unbrowse.ai";

export async function getHomepageLandingAssignment(): Promise<LandingAssignmentEnvelope> {
  try {
    const response = await fetchWithTimeout(`${API_URL}/v1/landing/homepage/active`, {
      next: { revalidate: 300 },
    });
    if (!response.ok) return DEFAULT_ASSIGNMENT;
    return await response.json() as LandingAssignmentEnvelope;
  } catch {
    return DEFAULT_ASSIGNMENT;
  }
}
