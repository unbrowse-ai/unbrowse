import type { LandingVariant } from "./types";

export const DEFAULT_HOME_COPY = {
  heroTitle: "A drop-in replacement",
  heroHighlight: "for browser automation.",
  heroBody:
    "Built for agent builders, OpenClaw users, and MCP hosts that are tired of repeating the same browser workflow on every run. Unbrowse learns the request path behind the page, so repeat tasks run faster, cheaper, and with less breakage than driving the DOM every time.",
  heroSupporting: "Same websites. Same permissions. Same browser fallback when needed.",
  definitionTitle: "The browser slot stays. The execution path changes.",
  definitionBody:
    "Unbrowse is a drop-in replacement for browser automation in agent stacks. On the first pass it can use a real browser to capture the site's request flow. On later runs it reuses that learned route as a skill. The browser stays available for auth and hard cases, but repeated browser work becomes reusable infrastructure instead of repeated cost.",
  installSummary:
    "Local runtime first. Then pick the tab for your actual host: CLI, MCP, Claude Code, Cursor, or OpenClaw.",
};

export function mergeLandingCopy(variant: LandingVariant | null) {
  const content = variant?.content ?? {};
  return {
    variantId: variant?.variant_id ?? "default",
    icp: variant?.icp ?? "default",
    experimentId: variant?.experiment_id ?? "homepage",
    heroTitle: content.hero_title || DEFAULT_HOME_COPY.heroTitle,
    heroHighlight: content.hero_highlight || DEFAULT_HOME_COPY.heroHighlight,
    heroBody: content.hero_body || DEFAULT_HOME_COPY.heroBody,
    heroSupporting: content.hero_supporting || DEFAULT_HOME_COPY.heroSupporting,
    definitionTitle: content.definition_title || DEFAULT_HOME_COPY.definitionTitle,
    definitionBody: content.definition_body || DEFAULT_HOME_COPY.definitionBody,
    installSummary: content.install_summary || DEFAULT_HOME_COPY.installSummary,
  };
}
