import { getSkill, type SkillManifest } from "@/lib/api";
import Link from "next/link";
import { notFound } from "next/navigation";

export default async function SkillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const skill = await getSkill(id);
  if (!skill) notFound();

  return (
    <div className="max-w-4xl mx-auto px-6 pt-32 pb-20">
      {/* Header */}
      <div className="mb-8">
        <Link href="/search" className="text-sm text-text-muted hover:text-orange-500 transition-colors mb-4 inline-block">
          &larr; Back to Registry
        </Link>
        <h1 className="text-3xl font-bold">{skill.name}</h1>
        <div className="flex items-center gap-4 mt-2 text-sm text-text-muted font-mono">
          <span>{skill.domain}</span>
          <span>v{skill.version}</span>
          <span className={skill.lifecycle === "active" ? "text-emerald-500" : "text-red-400"}>
            {skill.lifecycle}
          </span>
          <span>{skill.execution_type}</span>
        </div>
        <p className="text-text-secondary mt-3">{skill.description}</p>
      </div>

      {/* Quick use */}
      <div className="mb-8 p-5 rounded-2xl border border-border bg-surface">
        <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wider mb-3">Execute</h2>
        <pre className="text-sm font-mono text-text-secondary bg-surface-raised rounded-xl p-4 overflow-x-auto">{`curl -X POST https://beta-api.unbrowse.ai/v1/skills/${skill.skill_id}/execute \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer \$UNBROWSE_API_KEY" \\
  -d '{"params":{}}'`}</pre>
      </div>

      {/* Endpoints */}
      <div>
        <h2 className="text-xl font-bold mb-4">
          Endpoints <span className="text-text-muted font-normal text-base">({skill.endpoints.length})</span>
        </h2>
        <div className="space-y-3">
          {skill.endpoints.map((ep) => (
            <div key={ep.endpoint_id} className="p-4 rounded-xl border border-border bg-surface">
              <div className="flex items-center gap-3 mb-2">
                <MethodBadge method={ep.method} />
                <code className="text-sm font-mono text-text-primary break-all">{ep.url_template}</code>
              </div>
              <div className="flex items-center gap-4 text-xs text-text-muted font-mono">
                <span>Score: {(ep.reliability_score * 100).toFixed(0)}%</span>
                <span className={
                  ep.verification_status === "verified" ? "text-emerald-500" :
                  ep.verification_status === "failed" ? "text-red-400" : ""
                }>
                  {ep.verification_status}
                </span>
                {ep.response_schema != null && <span className="text-blue-400">has schema</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Metadata */}
      <div className="mt-10 p-5 rounded-2xl border border-border bg-surface">
        <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wider mb-3">Metadata</h3>
        <div className="grid grid-cols-2 gap-3 text-sm font-mono">
          <div>
            <span className="text-text-muted">Skill ID</span>
            <div className="text-text-secondary break-all">{skill.skill_id}</div>
          </div>
          <div>
            <span className="text-text-muted">Intent</span>
            <div className="text-text-secondary">{skill.intent_signature}</div>
          </div>
          <div>
            <span className="text-text-muted">Created</span>
            <div className="text-text-secondary">{new Date(skill.created_at).toLocaleDateString()}</div>
          </div>
          <div>
            <span className="text-text-muted">Updated</span>
            <div className="text-text-secondary">{new Date(skill.updated_at).toLocaleDateString()}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: "bg-emerald-500/15 text-emerald-500",
    POST: "bg-blue-500/15 text-blue-500",
    PUT: "bg-orange-500/15 text-orange-500",
    PATCH: "bg-yellow-500/15 text-yellow-500",
    DELETE: "bg-red-500/15 text-red-400",
  };
  return (
    <span className={`px-2 py-0.5 rounded-md text-xs font-mono font-bold ${colors[method] ?? "bg-gray-500/15 text-gray-400"}`}>
      {method}
    </span>
  );
}
