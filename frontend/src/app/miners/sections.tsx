import Link from "next/link";
import type { ReactNode } from "react";
import {
  Check,
  Copy,
  Crown,
  ExternalLink,
  Globe,
  Sparkles,
  Target,
  TrendingUp,
} from "lucide-react";
import type { DomainCoverage, LeaderboardEntry, MinerBounty, NetworkStats } from "@/lib/api";
export const TOP_DOMAINS = [
  "github.com",
  "google.com",
  "reddit.com",
  "stackoverflow.com",
  "news.ycombinator.com",
  "linkedin.com",
  "youtube.com",
  "x.com",
  "stripe.com",
  "aws.amazon.com",
  "npmjs.com",
  "pypi.org",
  "docs.google.com",
  "notion.so",
  "figma.com",
  "vercel.com",
  "cloudflare.com",
  "discord.com",
  "slack.com",
  "twitch.tv",
  "medium.com",
  "dev.to",
  "gitlab.com",
  "bitbucket.org",
  "heroku.com",
  "netlify.com",
  "supabase.com",
  "firebase.google.com",
  "airtable.com",
  "shopify.com",
] as const;

export function StatCard({ label, value, icon }: { label: string; value: string | number; icon: ReactNode }) {
  return (
    <div className="rounded-[20px] border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-text-muted">
        {icon}
        <span className="text-[11px] font-mono uppercase tracking-[0.18em]">{label}</span>
      </div>
      <p className="gradient-text mt-2 text-2xl font-bold">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
    </div>
  );
}

export function LeaderboardSection({ entries }: { entries: LeaderboardEntry[] }) {
  const podium = entries.slice(0, 3);
  const rest = entries.slice(3);

  return (
    <div>
      <div className="grid gap-6 lg:grid-cols-3">
        {podium.map((entry, index) => (
          <article
            key={entry.agent_id}
            className={`rounded-[28px] border p-6 transition-all hover:scale-[1.01] ${
              index === 0 ? "orange-glow border-orange-500/30 bg-orange-500/12" : "border-border bg-surface"
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs font-mono uppercase tracking-[0.2em] text-text-muted">
                {index === 0 ? <Crown className="h-3.5 w-3.5 text-orange-500" /> : <Sparkles className="h-3.5 w-3.5 text-orange-500" />}
                Rank #{index + 1}
              </div>
              <span className="text-xs text-text-muted">{new Date(entry.created_at).toLocaleDateString()}</span>
            </div>
            <h2 className="mt-5 truncate text-2xl font-semibold">{entry.name}</h2>
            <p className="gradient-text mt-2 text-4xl font-bold">{entry.contribution_score.toFixed(4)}</p>
            <div className="mt-5 space-y-3">
              <BoardMetric label="USDC Earned" value={`$${entry.total_earned_usd.toFixed(6)}`} />
              <BoardMetric label="Executions" value={String(entry.executions)} />
              <BoardMetric label="Routes Discovered" value={String(entry.skills_discovered)} />
              <BoardMetric
                label="Time Saved"
                value={entry.time_saved_hours == null ? "Not enough data yet" : `${entry.time_saved_hours.toFixed(4)}h`}
              />
            </div>
            <div className="mt-4 border-t border-border/70 pt-4">
              <button
                onClick={() => {
                  const text = `I'm ranked #${index + 1} on the Unbrowse contributor leaderboard with a score of ${entry.contribution_score.toFixed(4)}.\n\nhttps://unbrowse.ai/miners`;
                  window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}`, "_blank");
                }}
                className="w-full rounded-xl border border-border px-4 py-2 text-xs font-medium text-text-secondary transition-all hover:border-orange-500/30 hover:text-orange-500"
              >
                Share ranking on X
              </button>
            </div>
          </article>
        ))}
      </div>

      <div className="mt-8 rounded-[32px] border border-border bg-surface p-4 sm:p-6">
        <div className="flex items-center justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.22em] text-text-muted">Full board</p>
            <h2 className="mt-2 text-2xl font-semibold">All contributors</h2>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-orange-500/20 bg-orange-500/10 px-3 py-1 text-xs font-mono uppercase tracking-[0.2em] text-orange-500">
            <TrendingUp className="h-3.5 w-3.5" />
            {entries.length} ranked
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left">
            <thead>
              <tr className="text-xs font-mono uppercase tracking-[0.18em] text-text-muted">
                <th className="px-3 py-3">Rank</th>
                <th className="px-3 py-3">Contributor</th>
                <th className="px-3 py-3">Score</th>
                <th className="px-3 py-3">USDC Earned</th>
                <th className="px-3 py-3">Executions</th>
                <th className="px-3 py-3">Routes</th>
                <th className="px-3 py-3">Share</th>
              </tr>
            </thead>
            <tbody>
              {rest.length > 0 ? (
                rest.map((entry, index) => (
                  <tr key={entry.agent_id} className="border-t border-border/70 transition-colors hover:bg-orange-500/5">
                    <td className="px-3 py-4 text-sm font-semibold text-text-primary">#{index + 4}</td>
                    <td className="px-3 py-4">
                      <div className="max-w-[200px] truncate font-medium text-text-primary">{entry.name}</div>
                      <div className="mt-1 text-xs font-mono text-text-muted">
                        norms {entry.score_components.earned_norm.toFixed(2)} / {entry.score_components.execution_norm.toFixed(2)} / {entry.score_components.discovery_norm.toFixed(2)}
                      </div>
                    </td>
                    <td className="px-3 py-4 text-sm font-semibold text-orange-500">{entry.contribution_score.toFixed(4)}</td>
                    <td className="px-3 py-4 text-sm text-text-primary">${entry.total_earned_usd.toFixed(6)}</td>
                    <td className="px-3 py-4 text-sm text-text-primary">{entry.executions}</td>
                    <td className="px-3 py-4 text-sm text-text-primary">{entry.skills_discovered}</td>
                    <td className="px-3 py-4">
                      <button
                        onClick={() => {
                          const text = `I'm ranked #${index + 4} on the Unbrowse contributor leaderboard.\n\nhttps://unbrowse.ai/miners`;
                          window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}`, "_blank");
                        }}
                        className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-muted transition-all hover:border-orange-500/30 hover:text-orange-500"
                      >
                        Share
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-sm text-text-muted">
                    No ranked contributors yet. Be the first.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function CoverageAtlasSection({
  network,
  domains,
  demandTargets,
  indexedSet,
  topDomains,
  onCopy,
  copiedId,
}: {
  network: NetworkStats | null;
  domains: DomainCoverage[];
  demandTargets: MinerBounty[];
  indexedSet: Set<string>;
  topDomains: readonly string[];
  onCopy: (cmd: string, id: string) => void;
  copiedId: string | null;
}) {
  const trackedCoverage = topDomains.filter((domain) => isCovered(indexedSet, domain)).length;
  const trackedCoveragePct = topDomains.length > 0 ? Math.round((trackedCoverage / topDomains.length) * 100) : 0;
  const avgRoutesPerDomain = domains.length > 0 && network ? network.total_routes / domains.length : 0;
  const resolvesPerRoute = network && network.total_routes > 0 ? network.total_resolves / network.total_routes : 0;
  const surfacedTargets = demandTargets.slice(0, 5);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
      <section className="rounded-[32px] border border-border bg-surface p-6">
        <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.22em] text-cyan-300">Coverage signal</p>
            <h2 className="mt-2 text-2xl font-semibold">Coverage globe</h2>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs font-mono uppercase tracking-[0.2em] text-cyan-300">
            {domains.length} domains live
          </div>
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_260px]">
          <CoverageGlobe domains={domains} trackedCoveragePct={trackedCoveragePct} topDomains={topDomains.length} />
          <div className="space-y-4">
            <MetricPanel label="Tracked demand coverage" value={`${trackedCoveragePct}%`} detail={`${trackedCoverage}/${topDomains.length} reference domains indexed`} />
            <MetricPanel label="Average routes per domain" value={avgRoutesPerDomain > 0 ? avgRoutesPerDomain.toFixed(1) : "0.0"} detail="Useful density signal. Bigger is better." />
            <MetricPanel label="Resolve pressure per route" value={resolvesPerRoute > 0 ? resolvesPerRoute.toFixed(1) : "0.0"} detail="How hard the current graph is being hit." />
            <MetricPanel label="Market reuse" value={network ? `${network.marketplace_hit_rate}%` : "0%"} detail="Real marketplace/cache hit rate from resolver telemetry." />
          </div>
        </div>

        <p className="mt-4 text-xs text-text-muted">
          Abstract network view, not a geographic map. Bright nodes are indexed domains. More routes and more reuse make the sphere denser.
        </p>
      </section>

      <section className="rounded-[32px] border border-border bg-surface p-6">
        <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.22em] text-orange-500">Demand signal</p>
            <h2 className="mt-2 text-2xl font-semibold">Priority targets</h2>
          </div>
          <Link href="/top-domains-to-mine" className="inline-flex items-center gap-1 text-xs text-orange-500 hover:underline">
            Field guide <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
        <p className="mt-3 text-sm text-text-secondary">
          Ordered by what agents have actually been asking for lately. No fake multipliers. The value comes from future reuse if you cover the right routes.
        </p>

        <div className="mt-5 space-y-3">
          {surfacedTargets.length > 0 ? (
            surfacedTargets.map((target) => {
              const cmdId = `demand-${target.domain}`;
              const covered = isCovered(indexedSet, target.domain);
              return (
                <article key={target.id} className="rounded-2xl border border-border/70 bg-surface-raised p-4 transition-all hover:border-orange-500/20">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate font-medium text-text-primary">{target.domain}</h3>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase ${covered ? "border-green-500/20 bg-green-500/10 text-green-500" : "border-orange-500/20 bg-orange-500/10 text-orange-500"}`}>
                          {covered ? "covered" : "open"}
                        </span>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-text-secondary">{target.description}</p>
                    </div>
                    <button
                      onClick={() => onCopy(`unbrowse go https://${target.domain}`, cmdId)}
                      className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-border px-3 py-2 text-xs text-text-muted transition-all hover:border-orange-500/30 hover:text-orange-500"
                    >
                      {copiedId === cmdId ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      {copiedId === cmdId ? "Copied" : "Mine"}
                    </button>
                  </div>
                </article>
              );
            })
          ) : (
            <div className="rounded-2xl border border-border/70 bg-surface-raised px-4 py-8 text-center text-sm text-text-muted">
              Demand telemetry has not produced live targets yet.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export function DomainMapSection({
  domains,
  topDomains,
  indexedSet,
  onCopy,
  copiedId,
}: {
  domains: DomainCoverage[];
  topDomains: readonly string[];
  indexedSet: Set<string>;
  onCopy: (cmd: string, id: string) => void;
  copiedId: string | null;
}) {
  return (
    <div className="space-y-6">
      <div className="rounded-[32px] border border-border bg-surface p-6">
        <div className="flex items-center justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.22em] text-text-muted">Live registry</p>
            <h2 className="mt-2 text-2xl font-semibold">Indexed domains</h2>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-green-500/20 bg-green-500/10 px-3 py-1 text-xs font-mono uppercase tracking-[0.2em] text-green-500">
            {domains.length} active
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {domains.map((domain) => (
            <div key={domain.domain} className="rounded-2xl border border-border/70 bg-surface-raised p-4 transition-all hover:border-orange-500/20">
              <div className="flex items-center justify-between">
                <span className="truncate text-sm font-medium text-text-primary">{domain.domain}</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-mono uppercase text-green-500">
                  indexed
                </span>
              </div>
              <div className="mt-3 flex items-center gap-4 text-xs text-text-muted">
                <span>{domain.endpoints} routes</span>
                <span>{domain.skills} skills</span>
              </div>
              <div className="mt-2 text-[10px] text-text-muted">Updated {new Date(domain.updated_at).toLocaleDateString()}</div>
            </div>
          ))}
          {domains.length === 0 && (
            <div className="col-span-full py-8 text-center text-sm text-text-muted">
              No domains indexed yet. Start the graph.
            </div>
          )}
        </div>
      </div>

      <div className="rounded-[32px] border border-orange-500/20 bg-surface p-6">
        <div className="flex items-center justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.22em] text-orange-500">Reference set</p>
            <h2 className="mt-2 text-2xl font-semibold">Tracked priority domains</h2>
          </div>
          <Link href="/top-domains-to-mine" className="inline-flex items-center gap-1 text-xs text-orange-500 hover:underline">
            Full guide <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
        <p className="mt-3 text-sm text-text-secondary">
          High-signal domains we use as a rough surface-area benchmark. Not ownership. Not a claim list. Just good places to expand the graph.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {topDomains.map((domain) => {
            const covered = isCovered(indexedSet, domain);
            const cmdId = `registry-${domain}`;
            return (
              <div key={domain} className="group relative">
                <button
                  onClick={() => {
                    if (!covered) onCopy(`unbrowse go https://${domain}`, cmdId);
                  }}
                  className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition-all ${
                    covered
                      ? "cursor-default border-green-500/20 bg-green-500/8 text-green-500"
                      : "cursor-pointer border-orange-500/20 bg-orange-500/8 text-orange-500 hover:bg-orange-500/15"
                  }`}
                >
                  {covered || copiedId === cmdId ? <Check className="h-3 w-3" /> : <Target className="h-3 w-3" />}
                  {domain}
                </button>
                {!covered && copiedId === cmdId && (
                  <span className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-border bg-surface-raised px-2 py-1 text-[10px] text-text-muted">
                    Copied command
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CoverageGlobe({
  domains,
  trackedCoveragePct,
  topDomains,
}: {
  domains: DomainCoverage[];
  trackedCoveragePct: number;
  topDomains: number;
}) {
  const plotted = domains.slice(0, 40).map((domain, index) => {
    const longitude = (((index * 137.5) + domain.endpoints * 11) % 360) * (Math.PI / 180);
    const latitude = ((((index % 9) - 4) * 17) + ((domain.skills % 3) - 1) * 6) * (Math.PI / 180);
    const depth = Math.cos(longitude) * Math.cos(latitude);
    return {
      key: domain.domain,
      x: 160 + Math.sin(longitude) * Math.cos(latitude) * 112,
      y: 160 + Math.sin(latitude) * 78,
      size: 2.5 + Math.min(4.5, domain.endpoints / 6),
      opacity: 0.28 + Math.max(0, depth) * 0.55,
      front: depth >= 0,
    };
  });

  const arcs = plotted.filter((node) => node.front).slice(0, 7).map((node, index, front) => {
    const target = front[(index + 2) % front.length];
    return {
      key: `${node.key}-${target?.key ?? index}`,
      d: `M ${node.x.toFixed(1)} ${node.y.toFixed(1)} Q 160 ${(84 + index * 10).toFixed(1)} ${target?.x.toFixed(1) ?? node.x.toFixed(1)} ${target?.y.toFixed(1) ?? node.y.toFixed(1)}`,
      opacity: 0.14 + index * 0.05,
    };
  });

  return (
    <div className="relative overflow-hidden rounded-[28px] border border-border/70 bg-[#07111a] p-5">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgba(56,189,248,0.18),transparent_24%),radial-gradient(circle_at_35%_30%,rgba(255,109,0,0.18),transparent_22%),linear-gradient(180deg,rgba(8,17,26,0.3),rgba(8,17,26,0.9))]" />
      <div className="relative mx-auto aspect-square max-w-[460px]">
        <div className="absolute inset-[8%] rounded-full border border-cyan-300/12" />
        <div className="absolute inset-[16%] rounded-full border border-orange-400/10" />
        <svg viewBox="0 0 320 320" className="h-full w-full">
          <defs>
            <radialGradient id="globeFill" cx="50%" cy="38%" r="65%">
              <stop offset="0%" stopColor="rgba(56,189,248,0.22)" />
              <stop offset="45%" stopColor="rgba(14,116,144,0.14)" />
              <stop offset="100%" stopColor="rgba(7,17,26,0.94)" />
            </radialGradient>
          </defs>

          <circle cx="160" cy="160" r="118" fill="url(#globeFill)" stroke="rgba(125,211,252,0.28)" strokeWidth="1.2" />
          {[-70, -35, 0, 35, 70].map((offset) => (
            <ellipse
              key={`lat-${offset}`}
              cx="160"
              cy={160 + offset * 0.7}
              rx={Math.max(26, 114 - Math.abs(offset) * 1.1)}
              ry={16}
              fill="none"
              stroke="rgba(125,211,252,0.16)"
              strokeWidth="1"
            />
          ))}
          {[0, 30, 60, 90, 120, 150].map((rotation) => (
            <ellipse
              key={`lon-${rotation}`}
              cx="160"
              cy="160"
              rx="46"
              ry="118"
              fill="none"
              stroke="rgba(251,146,60,0.14)"
              strokeWidth="1"
              transform={`rotate(${rotation} 160 160)`}
            />
          ))}

          {arcs.map((arc) => (
            <path key={arc.key} d={arc.d} fill="none" stroke={`rgba(56,189,248,${arc.opacity})`} strokeWidth="1.2" strokeLinecap="round" />
          ))}

          {plotted
            .sort((a, b) => Number(a.front) - Number(b.front))
            .map((node) => (
              <circle
                key={node.key}
                cx={node.x}
                cy={node.y}
                r={node.size}
                fill={node.front ? "rgba(255,159,64,0.95)" : "rgba(125,211,252,0.32)"}
                opacity={node.opacity}
              />
            ))}
        </svg>

        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-full border border-white/10 bg-black/20 px-6 py-4 text-center backdrop-blur-sm">
            <p className="text-[10px] font-mono uppercase tracking-[0.26em] text-cyan-200/80">Tracked demand coverage</p>
            <p className="mt-2 text-4xl font-semibold text-white">{trackedCoveragePct}%</p>
            <p className="mt-1 text-[11px] text-text-muted">{topDomains} reference domains in watchlist</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function BoardMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/70 py-2.5 last:border-b-0">
      <span className="text-sm text-text-secondary">{label}</span>
      <span className="text-sm font-medium text-text-primary">{value}</span>
    </div>
  );
}

function MetricPanel({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-surface-raised p-4">
      <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-text-muted">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-text-primary">{value}</p>
      <p className="mt-2 text-xs leading-5 text-text-secondary">{detail}</p>
    </div>
  );
}

function isCovered(indexedSet: Set<string>, domain: string) {
  return indexedSet.has(domain) || indexedSet.has(`www.${domain}`);
}
