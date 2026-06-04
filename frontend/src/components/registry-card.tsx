import Link from "next/link";
import type { PopularSkillSummary } from "@/lib/api";
import { humanizeDomain } from "@/lib/humanize";

const nf = new Intl.NumberFormat("en-US");

/**
 * Registry card — the unbrowse analog of a Smithery server card. Links to the
 * skill detail page. Shows the trust signals Smithery leads with, mapped to our
 * nouns: favicon + name + domain + verified badge + calls (total_executions) +
 * quality (avg_reliability_score) + routes (endpoint_count) + description.
 */
export function RegistryCard({ skill }: { skill: PopularSkillSummary }) {
  const quality = Math.round((skill.avg_reliability_score || 0) * 100);
  const verified = quality >= 70;
  const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(skill.domain)}&sz=64`;
  return (
    <Link
      href={`/skill/${encodeURIComponent(skill.skill_id)}`}
      className="group flex h-full flex-col rounded-2xl border border-border bg-surface-raised p-5 transition-colors hover:border-border-strong"
    >
      <div className="mb-3 flex items-start gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={favicon} alt="" width={36} height={36} className="rounded-lg shrink-0" style={{ background: "var(--surface-sunken)" }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-[15px] font-semibold text-text-primary">{humanizeDomain(skill.domain)}</h3>
            {verified && (
              <span className="shrink-0 text-[11px]" style={{ color: "var(--orange-400, #FF6A00)" }} title="Verified">✦</span>
            )}
          </div>
          <p className="truncate text-[12px] font-mono text-text-muted">{skill.domain}</p>
        </div>
      </div>
      {/* Only show a description when it's a REAL per-skill one. The generic
          "API skill for <domain>" placeholder is repeated filler — the catalog's
          one-line explanation lives once above the grid, and each card carries its
          own real signals below. A flex-grow spacer keeps card heights equal. */}
      {skill.description && !skill.description.startsWith("API skill for") ? (
        <p className="mb-4 line-clamp-2 flex-grow text-[13px] leading-relaxed text-text-secondary">
          {skill.description}
        </p>
      ) : (
        <div className="flex-grow" aria-hidden />
      )}
      <div className="flex items-center gap-4 border-t border-border pt-3 text-[11px] font-mono text-text-muted">
        <span title="Total calls">▸ {nf.format(skill.total_executions || 0)} calls</span>
        <span title="Quality score">★ {quality}</span>
        <span title="Routes">⛓ {nf.format(skill.endpoint_count || 0)}</span>
      </div>
    </Link>
  );
}
