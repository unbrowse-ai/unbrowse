import Link from "next/link";
import { Chapter, CtaLink } from "@/components/editions";
import { listPopularSkills, listSkillCards, type PopularSkillSummary, type SkillListItem } from "@/lib/api";
import "./chapters.css";

/**
 * Chapter [06] Marketplace — Wave-2B port of §9 PopularSkillsGrid +
 * §12 RegistryShowcase onto the cream surface.
 *
 * Two panes:
 *   - Top: 12 most-popular captured domains as a tile grid (live data).
 *   - Bottom: cream-themed terminal listing 30 most-recently-indexed skills.
 *
 * Both panes read live data from /v1/skills via lib/api. Cream-on-ink-text
 * everywhere; no dark <section> bleed.
 */

function formatExecutions(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

async function PopularSkillsBand() {
  let skills: PopularSkillSummary[] = [];
  try {
    skills = await listPopularSkills(12);
  } catch {
    skills = [];
  }
  const display = skills.slice(0, 12);
  if (display.length === 0) return null;

  return (
    <div>
      <p
        className="chapter-eyebrow"
        style={{ marginBottom: "1rem", color: "var(--ed-ink-muted)" }}
      >
        Top routes already cached
      </p>
      <div className="ed-marketplace-grid">
        {display.map((s) => (
          <Link
            key={s.skill_id}
            href={`/${s.domain}`}
            className="ed-marketplace-tile"
            prefetch={false}
          >
            <span className="tile-initial">{s.domain.charAt(0)}</span>
            <span className="tile-meta">
              <span className="tile-name">{s.name || s.domain}</span>
              <span className="tile-sub">
                {formatExecutions(s.total_executions)} calls
              </span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

async function RecentRegistryPane() {
  let skills: SkillListItem[] = [];
  try {
    skills = await listSkillCards({ limit: 30 });
  } catch {
    skills = [];
  }
  const display = skills.filter((s) => s.lifecycle !== "deprecated").slice(0, 30);

  return (
    <div className="ed-registry-card">
      <div className="ed-registry-card-head">
        <span className="label">Recently indexed skills</span>
        <Link href="/search" className="viewall">
          View all →
        </Link>
      </div>
      <div className="ed-registry-list">
        {display.length > 0 ? (
          display.map((skill) => {
            const avgScore = skill.avg_reliability_score ?? 0;
            const endpointCount =
              skill.endpoint_count ?? skill.endpoints?.length ?? 0;
            return (
              <Link
                key={skill.skill_id}
                href={`/skills/${skill.skill_id}`}
                className="ed-registry-row"
                prefetch={false}
              >
                <span className="row-initial">
                  {skill.domain.charAt(0)}
                </span>
                <span className="row-main">
                  <span>
                    <span className="row-name">{skill.name}</span>
                    {skill.lifecycle === "active" && <span className="row-dot" />}
                  </span>
                  <span className="row-domain">{skill.domain}</span>
                </span>
                <span className="row-stats">
                  <span className="stats-strong">{endpointCount} endpoints</span>
                  <br />
                  {Math.round(avgScore * 100)}% reliable
                </span>
              </Link>
            );
          })
        ) : (
          <div
            style={{
              padding: "2rem 1.25rem",
              fontFamily: "var(--font-mono)",
              fontSize: "0.85rem",
              color: "var(--ed-ink-muted)",
              textAlign: "center",
            }}
          >
            Loading registry skills…
          </div>
        )}
      </div>
    </div>
  );
}

export async function Ch06Marketplace() {
  const [popularBand, registryPane] = await Promise.all([
    PopularSkillsBand(),
    RecentRegistryPane(),
  ]);
  return (
    <Chapter
      id="marketplace"
      number="[06]"
      name="Marketplace"
      title="One agent discovers it. Every agent benefits."
      lede="The skills your route captures are public. Every other agent on the network can reuse them."
    >
      {/* Top pane — popular skills tile grid (live data) */}
      {popularBand}

      {/* Bottom pane — recently indexed skills (cream terminal, live data) */}
      {registryPane}

      <div style={{ marginTop: "2rem" }}>
        <CtaLink href="/search">Browse the marketplace →</CtaLink>
      </div>
    </Chapter>
  );
}
