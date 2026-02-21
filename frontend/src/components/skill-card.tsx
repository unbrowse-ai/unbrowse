import Link from "next/link";
import type { SkillManifest } from "@/lib/api";

const METHOD_COLORS: Record<string, string> = {
  GET: "text-emerald-600 bg-emerald-50 border-emerald-200",
  POST: "text-blue-600 bg-blue-50 border-blue-200",
  PUT: "text-amber-600 bg-amber-50 border-amber-200",
  PATCH: "text-purple-600 bg-purple-50 border-purple-200",
  DELETE: "text-red-600 bg-red-50 border-red-200",
};

const STATUS_DOTS: Record<string, string> = {
  verified: "bg-emerald-500",
  unverified: "bg-amber-400",
  failed: "bg-red-500",
  pending: "bg-blue-400 animate-pulse",
};

export function SkillCard({ skill }: { skill: SkillManifest }) {
  const avgScore = skill.endpoints.length > 0
    ? skill.endpoints.reduce((s, e) => s + e.reliability_score, 0) / skill.endpoints.length
    : 0;

  return (
    <Link
      href={`/skills/${skill.skill_id}`}
      className="group block p-6 bg-surface rounded-2xl border border-border
                 hover:border-orange-300 hover:shadow-lg hover:shadow-glow
                 transition-all duration-300"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <h3 className="font-bold text-base truncate group-hover:text-orange-500 transition-colors">
            {skill.name}
          </h3>
          <p className="text-sm text-text-muted font-mono mt-0.5">{skill.domain}</p>
        </div>
        <div className={`flex-shrink-0 px-2 py-0.5 rounded-lg text-[10px] font-mono font-bold uppercase
          ${skill.lifecycle === "active"
            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
            : "bg-surface-sunken text-text-muted border border-border"}
        `}>
          {skill.lifecycle}
        </div>
      </div>

      {/* Intent */}
      <p className="text-sm text-text-secondary leading-relaxed mb-5 line-clamp-2">
        {skill.intent_signature}
      </p>

      {/* Endpoints */}
      <div className="flex flex-wrap gap-1.5 mb-5">
        {skill.endpoints.slice(0, 4).map((ep) => (
          <span
            key={ep.endpoint_id}
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md
                       text-[10px] font-mono font-bold border
                       ${METHOD_COLORS[ep.method] ?? "text-text-muted bg-surface-sunken border-border"}`}
          >
            <span className={`w-1 h-1 rounded-full ${STATUS_DOTS[ep.verification_status] ?? "bg-gray-400"}`} />
            {ep.method}
          </span>
        ))}
        {skill.endpoints.length > 4 && (
          <span className="text-[10px] font-mono text-text-muted px-1">+{skill.endpoints.length - 4}</span>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-4 border-t border-border">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-16 bg-surface-sunken rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-orange-400 to-orange-500 transition-all"
              style={{ width: `${Math.round(avgScore * 100)}%` }}
            />
          </div>
          <span className="text-[11px] font-mono text-text-muted">
            {Math.round(avgScore * 100)}%
          </span>
        </div>
        <span className="text-[11px] font-mono text-text-muted">
          v{skill.version}
        </span>
      </div>
    </Link>
  );
}
