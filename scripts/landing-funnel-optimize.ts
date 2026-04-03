import type {
  LandingAngleFamily,
  LandingHomepageAnalyticsSummary,
  LandingHomepageExperimentConfig,
  LandingVariantConfig,
  LandingVariantCopy,
} from "../backend/src/services/landing-experiments.js";

const API_URL = process.env.UNBROWSE_OPTIMIZER_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "https://beta-api.unbrowse.ai";
const API_KEY = process.env.UNBROWSE_OPTIMIZER_API_KEY ?? process.env.UNBROWSE_API_KEY ?? "";
const WINDOW_DAYS = Number.parseInt(process.env.UNBROWSE_OPTIMIZER_WINDOW_DAYS ?? "30", 10);
const MIN_ACTIVE_WEIGHT = Number.parseFloat(process.env.UNBROWSE_OPTIMIZER_MIN_ACTIVE_WEIGHT ?? "0.12");
const MIN_CANARY_SAMPLE = Number.parseInt(process.env.UNBROWSE_OPTIMIZER_MIN_CANARY_SAMPLE ?? "40", 10);
const PROMOTE_DELTA = Number.parseFloat(process.env.UNBROWSE_OPTIMIZER_PROMOTE_DELTA ?? "0.015");
const DISABLE_DELTA = Number.parseFloat(process.env.UNBROWSE_OPTIMIZER_DISABLE_DELTA ?? "0.05");
const BOUNCE_DELTA_LIMIT = Number.parseFloat(process.env.UNBROWSE_OPTIMIZER_BOUNCE_DELTA_LIMIT ?? "0.12");

const APPROVED_FAMILIES: LandingAngleFamily[] = [
  "browser-replacement",
  "speed-proof",
  "reliability",
  "learn-once-reuse-later",
];

function assertConfig(): void {
  if (!API_KEY) {
    throw new Error("Missing UNBROWSE_OPTIMIZER_API_KEY or UNBROWSE_API_KEY");
  }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${method} ${path} failed: ${response.status} ${text}`);
  }
  return response.json() as Promise<T>;
}

function posteriorMean(successes: number, trials: number): number {
  return (successes + 1) / (Math.max(trials, 0) + 2);
}

function normalizeActiveWeights(config: LandingHomepageExperimentConfig, analytics: LandingHomepageAnalyticsSummary): void {
  const activeVariants = config.variants.filter((variant) => variant.status === "active");
  if (activeVariants.length === 0) return;
  if (activeVariants.length === 1) {
    activeVariants[0].weight = 1;
    return;
  }

  const scores = activeVariants.map((variant) => {
    const metrics = analytics.variants.find((entry) => entry.variant_id === variant.variant_id);
    const score = metrics
      ? posteriorMean(metrics.first_resolve_succeeded, metrics.landing_visitors)
      : 0.5;
    return {
      variant,
      score: Math.max(score, MIN_ACTIVE_WEIGHT),
    };
  });

  const total = scores.reduce((sum, entry) => sum + entry.score, 0) || 1;
  for (const entry of scores) {
    entry.variant.weight = entry.score / total;
  }
}

function sessionRate(count: number, total: number): number {
  return total > 0 ? count / total : 0;
}

function evaluateCanaries(config: LandingHomepageExperimentConfig, analytics: LandingHomepageAnalyticsSummary): string[] {
  const notes: string[] = [];
  const control = analytics.variants.find((variant) => variant.variant_id === config.control_variant_id);
  if (!control) return notes;

  const controlPrimary = control.rates.first_resolve_succeeded_from_landing;
  const controlSetup = control.rates.setup_completed_from_landing;
  const controlBounce = sessionRate(control.bounce_sessions, control.landing_sessions);

  for (const variant of config.variants.filter((entry) => entry.status === "canary")) {
    const metrics = analytics.variants.find((entry) => entry.variant_id === variant.variant_id);
    if (!metrics || metrics.landing_visitors < MIN_CANARY_SAMPLE) continue;

    const primaryDelta = metrics.rates.first_resolve_succeeded_from_landing - controlPrimary;
    const setupDelta = metrics.rates.setup_completed_from_landing - controlSetup;
    const bounceDelta = sessionRate(metrics.bounce_sessions, metrics.landing_sessions) - controlBounce;

    if (primaryDelta <= -DISABLE_DELTA || setupDelta <= -DISABLE_DELTA || bounceDelta >= BOUNCE_DELTA_LIMIT) {
      variant.status = "disabled";
      variant.disabled_reason = `auto-disabled ${new Date().toISOString()}: primary=${primaryDelta.toFixed(3)} setup=${setupDelta.toFixed(3)} bounce=${bounceDelta.toFixed(3)}`;
      variant.weight = 0;
      notes.push(`disabled ${variant.variant_id}`);
      continue;
    }

    if (primaryDelta >= PROMOTE_DELTA && setupDelta >= -0.01 && bounceDelta <= 0.05) {
      variant.status = "active";
      variant.disabled_reason = undefined;
      variant.canary_started_at = undefined;
      variant.weight = Math.max(variant.weight, MIN_ACTIVE_WEIGHT);
      notes.push(`promoted ${variant.variant_id}`);
    }
  }

  return notes;
}

function nextTemplateFamily(config: LandingHomepageExperimentConfig, analytics: LandingHomepageAnalyticsSummary): LandingAngleFamily | null {
  const rankedFamilies = analytics.variants
    .filter((variant) => variant.landing_visitors > 0)
    .sort((a, b) => b.rates.first_resolve_succeeded_from_landing - a.rates.first_resolve_succeeded_from_landing)
    .map((variant) => variant.angle_family);
  const existingShadowFamilies = new Set(
    config.variants
      .filter((variant) => variant.status === "shadow")
      .map((variant) => variant.angle_family),
  );
  for (const family of [...rankedFamilies, ...APPROVED_FAMILIES]) {
    if (!existingShadowFamilies.has(family)) return family;
  }
  return null;
}

function makeVariantId(config: LandingHomepageExperimentConfig, family: LandingAngleFamily): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const base = `shadow-${family}-${stamp}`;
  if (!config.variants.some((variant) => variant.variant_id === base)) return base;
  let suffix = 2;
  while (config.variants.some((variant) => variant.variant_id === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function buildTemplateCopy(family: LandingAngleFamily): LandingVariantCopy {
  const library: Record<LandingAngleFamily, LandingVariantCopy> = {
    "browser-replacement": {
      hero_headline: "Replace browser automation",
      hero_emphasis: "without losing browser auth.",
      hero_subheadline: "Built for agent stacks that keep falling back to the browser. Unbrowse swaps repeated DOM-driving for reusable learned routes, so the browser slot stays but the expensive path stops repeating.",
      hero_support_line: "Keep the real browser for auth and edge cases. Reuse the faster path for repeat work.",
      trust_bar_order: ["benchmarks", "speed", "paper", "github", "npm"],
      definition_heading: "Keep the browser slot. Remove the repeated browser work.",
      definition_body: "Unbrowse is a drop-in replacement for browser automation in agent stacks. It can learn the request path behind a site with a real browser, then reuse that route on later runs so repeat execution stops depending on the DOM.",
      install_eyebrow: "Replace Browser Automation",
      install_body: "Install the runtime first. After that, your agent can replace repeat browser tasks with learned routes and keep browser fallback when needed.",
      hero_cta_label: "Copy Runtime Install",
    },
    "speed-proof": {
      hero_headline: "Replace slow browser loops",
      hero_emphasis: "with learned routes.",
      hero_subheadline: "Built for agent stacks where every repeated task still replays the same browser workflow. Unbrowse learns the request path behind the page so repeat runs finish faster, cheaper, and with less wasted browser time.",
      hero_support_line: "Same websites. Same permissions. Less waiting on the DOM.",
      trust_bar_order: ["speed", "benchmarks", "paper", "github", "npm"],
      definition_heading: "Use the path the site already depends on.",
      definition_body: "Browser automation repeats the human path. Unbrowse captures the request path behind the page, packages it as a reusable skill, and leaves the browser available only when you actually need it.",
      install_eyebrow: "Install The Faster Path",
      install_body: "Install once, then route repeat browser work through reusable request paths instead of replaying the full page flow.",
      hero_cta_label: "Copy Fast Install",
    },
    reliability: {
      hero_headline: "Replace brittle browser scripts",
      hero_emphasis: "with reusable routes.",
      hero_subheadline: "Built for agent stacks tired of selectors, flake, and repeated rediscovery. Unbrowse learns the request flow behind the page so UI churn stops breaking every repeat task.",
      hero_support_line: "Browser-backed auth when needed. Less DOM breakage on the path that repeats.",
      trust_bar_order: ["paper", "benchmarks", "speed", "github", "npm"],
      definition_heading: "The page can change. The request path can still be reused.",
      definition_body: "Unbrowse replaces repeated browser automation with reusable learned routes. Agents can still browse for auth or edge cases, but the default repeat path becomes a route layer that is more stable than selector-driven browser code.",
      install_eyebrow: "Install The Stable Path",
      install_body: "Install the runtime, keep the browser for auth, and move repeat execution onto learned routes that survive UI churn better than DOM scripts.",
      hero_cta_label: "Copy Stable Install",
    },
    "learn-once-reuse-later": {
      hero_headline: "Learn the site once",
      hero_emphasis: "reuse the route later.",
      hero_subheadline: "Built for agent stacks where each run rediscovers the same browser workflow. Unbrowse learns the request path once, then lets later runs reuse it instead of paying browser cost again.",
      hero_support_line: "One learned route can replace many repeated browser sessions.",
      trust_bar_order: ["github", "benchmarks", "speed", "paper", "npm"],
      definition_heading: "Capture once. Reuse later.",
      definition_body: "Unbrowse is a drop-in replacement for browser automation in agent stacks. It uses a real browser when needed to learn the site, then turns that request path into reusable infrastructure for later runs.",
      install_eyebrow: "Install And Reuse",
      install_body: "Install the runtime now. Let later tasks reuse learned request paths instead of remapping the same site through the browser.",
      hero_cta_label: "Copy Reuse Install",
    },
  };

  return library[family];
}

function generateShadowVariant(
  config: LandingHomepageExperimentConfig,
  analytics: LandingHomepageAnalyticsSummary,
): LandingVariantConfig | null {
  const shadowCount = config.variants.filter((variant) => variant.status === "shadow").length;
  const limit = config.shadow_generation_limit ?? 3;
  if (shadowCount >= limit) return null;

  const family = nextTemplateFamily(config, analytics);
  if (!family) return null;

  const variantId = makeVariantId(config, family);
  return {
    variant_id: variantId,
    label: `Auto ${family}`,
    status: "shadow",
    source: "auto_generated",
    angle_family: family,
    weight: 0,
    generated_at: new Date().toISOString(),
    rationale: `Auto-generated shadow variant from ${family} family using approved homepage slots only.`,
    copy: buildTemplateCopy(family),
  };
}

async function main(): Promise<void> {
  assertConfig();

  const [config, analytics] = await Promise.all([
    api<LandingHomepageExperimentConfig>("GET", "/v1/landing/homepage/config"),
    api<LandingHomepageAnalyticsSummary>("GET", `/v1/analytics/landing-funnel?days=${WINDOW_DAYS}`),
  ]);

  const nextConfig: LandingHomepageExperimentConfig = {
    ...config,
    variants: config.variants.map((variant) => ({ ...variant, copy: { ...variant.copy } })),
    optimizer_runs: [...(config.optimizer_runs ?? [])],
    updated_at: new Date().toISOString(),
  };

  const notes = evaluateCanaries(nextConfig, analytics);
  normalizeActiveWeights(nextConfig, analytics);

  const generated = generateShadowVariant(nextConfig, analytics);
  if (generated) {
    nextConfig.variants.push(generated);
    notes.push(`shadowed ${generated.variant_id}`);
  }

  const winner = analytics.variants
    .filter((variant) => variant.landing_visitors > 0)
    .sort((a, b) => b.rates.first_resolve_succeeded_from_landing - a.rates.first_resolve_succeeded_from_landing)[0];

  nextConfig.optimizer_runs?.push({
    ran_at: new Date().toISOString(),
    winner_variant_id: winner?.variant_id,
    winner_angle_family: winner?.angle_family,
    notes: notes.join("; ") || "rebalanced active weights",
  });

  await api("PUT", "/v1/landing/homepage/config", nextConfig);

  console.log(JSON.stringify({
    ok: true,
    experiment_id: nextConfig.experiment_id,
    notes,
    generated_variant_id: generated?.variant_id,
    active_weights: nextConfig.variants
      .filter((variant) => variant.status === "active" || variant.status === "canary")
      .map((variant) => ({ variant_id: variant.variant_id, status: variant.status, weight: variant.weight })),
  }, null, 2));
}

await main();
