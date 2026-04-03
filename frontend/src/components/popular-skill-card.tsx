import type { PopularSkillSummary } from "@/lib/api";

const numberFormatter = new Intl.NumberFormat("en-US");

export function PopularSkillCard({ rank, skill }: { rank: number; skill: PopularSkillSummary }) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-border bg-surface p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 inline-flex rounded-full border border-orange-500/20 bg-orange-50 px-2.5 py-1 text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-orange-600">
            #{rank}
          </div>
          <h3 className="truncate text-base font-bold text-text-primary">{skill.name}</h3>
          <p className="mt-0.5 text-sm font-mono text-text-muted">{skill.domain}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface-sunken px-2 py-1 text-[10px] font-mono font-bold uppercase text-text-muted">
          {skill.execution_type}
        </div>
      </div>

      <p className="mb-5 line-clamp-3 flex-grow text-sm leading-relaxed text-text-secondary">
        {skill.description}
      </p>

      <div className="grid grid-cols-3 gap-3 border-t border-border pt-4 text-xs font-mono text-text-muted">
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em]">Execs</div>
          <div className="mt-1 text-sm font-bold text-text-primary">{numberFormatter.format(skill.total_executions)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em]">Success</div>
          <div className="mt-1 text-sm font-bold text-text-primary">
            {skill.total_executions > 0
              ? `${Math.round((skill.successful_executions / skill.total_executions) * 100)}%`
              : "0%"}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em]">Routes</div>
          <div className="mt-1 text-sm font-bold text-text-primary">{numberFormatter.format(skill.endpoint_count)}</div>
        </div>
      </div>
    </div>
  );
}
