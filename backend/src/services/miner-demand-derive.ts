import type { FunnelEvent, MinerBounty, MinerQuest } from "../types.js";

const MAX_BOUNTIES = 8;
const FALLBACK_BOUNTY_DOMAINS = [
  "github.com",
  "stripe.com",
  "reddit.com",
  "news.ycombinator.com",
  "npmjs.com",
  "linkedin.com",
  "youtube.com",
  "stackoverflow.com",
];

export type DomainCoverageSnapshot = {
  endpoints: number;
  skills: number;
};

type DomainDemand = {
  domain: string;
  started: number;
  completed: number;
  failed: number;
  unique_install_ids: Set<string>;
  intents: Map<string, number>;
};

function cleanDomain(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const parsed = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return trimmed.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") || null;
  }
}

function domainFromEvent(event: FunnelEvent): string | null {
  const props = event.properties ?? {};
  const direct = cleanDomain(
    typeof props.domain === "string"
      ? props.domain
      : typeof props.requested_domain === "string"
        ? props.requested_domain
        : null,
  );
  if (direct) return direct;
  const url = typeof props.url === "string"
    ? props.url
    : typeof props.context_url === "string"
      ? props.context_url
      : null;
  return cleanDomain(url);
}

function normalizeIntent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || null;
}

function topIntentExamples(intents: Map<string, number>, limit = 3): string[] {
  return Array.from(intents.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([intent]) => intent);
}

function classifyCategory(domain: string, intentExamples: string[]): string {
  const text = `${domain} ${intentExamples.join(" ")}`.toLowerCase();
  if (/\b(payment|checkout|invoice|billing|subscription|price)\b/.test(text)) return "Payments";
  if (/\b(repo|repository|package|docs|issue|pull request|commit|code|npm)\b/.test(text)) return "Developer";
  if (/\b(post|comment|feed|timeline|subreddit|tweet|social)\b/.test(text)) return "Social";
  if (/\b(profile|company|job|resume|candidate|connection)\b/.test(text)) return "Professional";
  if (/\b(video|channel|transcript|media|stream)\b/.test(text)) return "Media";
  return "Agent Demand";
}

function classifyDifficulty(domain: string, intentExamples: string[]): "easy" | "medium" | "hard" {
  const text = `${domain} ${intentExamples.join(" ")}`.toLowerCase();
  if (
    /\b(auth|oauth|login|checkout|payment|message|dm|purchase|publish|create|update|delete|send)\b/.test(text) ||
    /\b(linkedin|stripe|github|figma|notion)\b/.test(text)
  ) {
    return "hard";
  }
  if (/\b(search|list|get|view|details|profile|repository|package)\b/.test(text)) return "medium";
  return "easy";
}

function rewardMultiplier(coverage: DomainCoverageSnapshot | undefined, completionRate: number): number {
  const endpoints = coverage?.endpoints ?? 0;
  if (endpoints === 0 || completionRate < 0.25) return 5;
  if (completionRate < 0.5 || endpoints < 5) return 4;
  if (completionRate < 0.75 || endpoints < 12) return 3;
  return 2;
}

function demandScore(demand: DomainDemand, coverage: DomainCoverageSnapshot | undefined): number {
  const endpoints = coverage?.endpoints ?? 0;
  const incomplete = Math.max(0, demand.started - demand.completed);
  return (
    demand.started * 4 +
    demand.unique_install_ids.size * 3 +
    demand.failed * 5 +
    incomplete * 2 +
    (endpoints === 0 ? 18 : Math.max(0, 12 - endpoints))
  );
}

function buildFallbackBounties(domainCoverage: Map<string, DomainCoverageSnapshot>): MinerBounty[] {
  return FALLBACK_BOUNTY_DOMAINS.map((domain) => {
    const coverage = domainCoverage.get(domain);
    return {
      id: `fallback-${domain.replace(/[^a-z0-9]+/g, "-")}`,
      title: `High-demand ${domain} routes`,
      domain,
      description: coverage?.endpoints
        ? `Current coverage is ${coverage.endpoints} routes. Expand the domain with higher-value demand paths.`
        : "No recent demand telemetry yet. This domain remains a strong default mining target.",
      reward_multiplier: coverage?.endpoints ? 3 : 5,
      difficulty: classifyDifficulty(domain, []),
      category: classifyCategory(domain, []),
      claimed: false,
    };
  });
}

function buildFallbackQuests(
  bounties: MinerBounty[],
  domainCoverage: Map<string, DomainCoverageSnapshot>,
): MinerQuest[] {
  const first = bounties[0];
  const second = bounties[1];
  const uncoveredCount = bounties.filter((bounty) => (domainCoverage.get(bounty.domain)?.endpoints ?? 0) === 0).length;
  return [
    ...(first ? [{
      id: "quest-fallback-1",
      title: `First to index ${first.domain}`,
      description: `Be the first miner to publish meaningful route coverage for ${first.domain}.`,
      target_domain: first.domain,
      reward_multiplier: 5,
      type: "first-indexer" as const,
      deadline: "Sunday 23:59 UTC",
    }] : []),
    ...(second ? [{
      id: "quest-fallback-2",
      title: `First to index ${second.domain}`,
      description: "Capture the next highest-value demand target after the lead domain.",
      target_domain: second.domain,
      reward_multiplier: 4,
      type: "first-indexer" as const,
      deadline: "Sunday 23:59 UTC",
    }] : []),
    {
      id: "quest-fallback-3",
      title: "Cover requested domains",
      description: "Contribute routes to high-value domains that still have little or no active coverage.",
      reward_multiplier: 3,
      type: "domain-sprint" as const,
      deadline: "Sunday 23:59 UTC",
      progress: 0,
      goal: Math.max(3, Math.min(10, uncoveredCount || 5)),
    },
    {
      id: "quest-fallback-4",
      title: "40 routes in one session",
      description: "Discover 40+ new routes in one mining session across current demand targets.",
      reward_multiplier: 2,
      type: "route-count" as const,
      deadline: "Sunday 23:59 UTC",
      progress: 0,
      goal: 40,
    },
  ].slice(0, 4);
}

export function buildMinerDemandBoardFromEvents(
  events: FunnelEvent[],
  domainCoverage: Map<string, DomainCoverageSnapshot>,
): { bounties: MinerBounty[]; quests: MinerQuest[] } {
  const demandByDomain = new Map<string, DomainDemand>();

  for (const event of events) {
    if (!["resolve_started", "resolve_completed", "resolve_failed", "search_started", "search_completed", "search_failed"].includes(event.name)) {
      continue;
    }

    const domain = domainFromEvent(event);
    const intent = normalizeIntent(event.properties?.intent);
    if (!domain || !intent) continue;

    const entry = demandByDomain.get(domain) ?? {
      domain,
      started: 0,
      completed: 0,
      failed: 0,
      unique_install_ids: new Set<string>(),
      intents: new Map<string, number>(),
    };

    if (event.name === "resolve_started" || event.name === "search_started") entry.started++;
    if (event.name === "resolve_completed" || event.name === "search_completed") entry.completed++;
    if (String(event.name).endsWith("_failed")) entry.failed++;

    entry.unique_install_ids.add(event.install_id);
    entry.intents.set(intent, (entry.intents.get(intent) ?? 0) + 1);
    demandByDomain.set(domain, entry);
  }

  const bounties = Array.from(demandByDomain.values())
    .map((demand) => {
      const coverage = domainCoverage.get(demand.domain);
      const intents = topIntentExamples(demand.intents);
      const completionRate = demand.started > 0 ? demand.completed / demand.started : 0;
      return {
        bounty: {
          id: `demand-${demand.domain.replace(/[^a-z0-9]+/g, "-")}`,
          title: `High-demand ${demand.domain} routes`,
          domain: demand.domain,
          description: intents.length > 0
            ? `Recent asks: ${intents.join(", ")}. Coverage is ${coverage?.endpoints ?? 0} routes with ${Math.round(completionRate * 100)}% completion.`
            : `Recent demand is clustering on ${demand.domain}. Coverage is ${coverage?.endpoints ?? 0} routes.`,
          reward_multiplier: rewardMultiplier(coverage, completionRate),
          difficulty: classifyDifficulty(demand.domain, intents),
          category: classifyCategory(demand.domain, intents),
          claimed: completionRate >= 0.85 && (coverage?.endpoints ?? 0) >= 20,
        } satisfies MinerBounty,
        score: demandScore(demand, coverage),
      };
    })
    .sort((a, b) => b.score - a.score || a.bounty.domain.localeCompare(b.bounty.domain))
    .slice(0, MAX_BOUNTIES)
    .map((entry) => entry.bounty);

  const effectiveBounties = bounties.length > 0 ? bounties : buildFallbackBounties(domainCoverage);
  const uncovered = effectiveBounties.filter((bounty) => (domainCoverage.get(bounty.domain)?.endpoints ?? 0) === 0);
  const leaders = uncovered.slice(0, 2);
  const routeGoal = Math.max(25, Math.min(75, effectiveBounties.length * 5));
  const domainGoal = Math.max(3, Math.min(10, uncovered.length || Math.ceil(effectiveBounties.length / 2)));

  const quests: MinerQuest[] = leaders.length > 0
    ? [
        ...leaders.map((bounty) => ({
          id: `quest-${bounty.domain.replace(/[^a-z0-9]+/g, "-")}`,
          title: `First to index ${bounty.domain}`,
          description: `Most-requested uncovered target. ${bounty.description}`,
          target_domain: bounty.domain,
          reward_multiplier: Math.max(4, bounty.reward_multiplier),
          type: "first-indexer" as const,
          deadline: "Sunday 23:59 UTC",
        })),
        {
          id: "quest-demand-domain-sprint",
          title: "Cover requested domains",
          description: "Contribute routes to high-demand domains that still have no active coverage.",
          reward_multiplier: 3,
          type: "domain-sprint" as const,
          deadline: "Sunday 23:59 UTC",
          progress: 0,
          goal: domainGoal,
        },
        {
          id: "quest-demand-route-count",
          title: `${routeGoal} routes from demand targets`,
          description: "Discover new routes across domains agents are actively requesting this week.",
          reward_multiplier: 2,
          type: "route-count" as const,
          deadline: "Sunday 23:59 UTC",
          progress: 0,
          goal: routeGoal,
        },
      ].slice(0, 4)
    : buildFallbackQuests(effectiveBounties, domainCoverage);

  return { bounties: effectiveBounties, quests };
}
