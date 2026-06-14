/* /skill/[id] — skill detail page (the unbrowse analog of Smithery's
 * /servers/<id> data sheet). Header + stats, the endpoints list (analog of
 * Smithery's tools), and an Integrate panel. This route did not exist before
 * (it 404'd); it is the registry's highest-value, trust-building surface.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { getSkill } from "@/lib/api";

export const revalidate = 120;

export default async function SkillDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const skill = await getSkill(id).catch(() => null);
  if (!skill) notFound();

  const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(skill.domain)}&sz=64`;
  const verifiedRoutes = skill.endpoints.filter((e) => e.verification_status === "verified").length;

  return (
    <main className="mx-auto max-w-4xl px-5 sm:px-8 py-10">
      <Link href="/" className="text-[13px]" style={{ color: "var(--text-muted)" }}>← Registry</Link>

      {/* Header */}
      <header className="mt-4 flex items-start gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={favicon} alt="" width={48} height={48} className="rounded-xl shrink-0" style={{ background: "var(--surface-sunken)" }} />
        <div className="min-w-0 flex-1">
          <h1 className="text-[24px] font-semibold tracking-tight text-text-primary">{skill.name}</h1>
          <p className="text-[13px] font-mono text-text-muted">{skill.domain} · v{skill.version} · {skill.lifecycle}</p>
        </div>
        <Link href={`/aiko`} className="shrink-0 px-4 py-2 rounded-xl text-[13px] font-medium" style={{ background: "var(--orange-500, #FF5200)", color: "#0c0500" }}>
          Use in Aiko →
        </Link>
      </header>

      <p className="mt-4 text-[15px] text-text-secondary max-w-2xl">{skill.description || `API skill for ${skill.domain}`}</p>

      {/* Stat pills */}
      <div className="mt-5 flex flex-wrap gap-3 text-[12px] font-mono">
        <span className="px-3 py-1.5 rounded-lg" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>{skill.endpoints.length} routes</span>
        <span className="px-3 py-1.5 rounded-lg" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>{verifiedRoutes} verified</span>
        <span className="px-3 py-1.5 rounded-lg" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>{skill.execution_type}</span>
      </div>

      {/* Endpoints (analog of Smithery's tools) */}
      <section className="mt-10">
        <h2 className="text-[16px] font-semibold text-text-primary mb-4">Routes ({skill.endpoints.length})</h2>
        <ul className="grid gap-2">
          {skill.endpoints.map((e) => {
            const desc = (e as { description?: string }).description;
            return (
              <li key={e.endpoint_id} className="rounded-xl border border-border bg-surface-raised p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold" style={{ background: "var(--surface-sunken)", color: "var(--orange-400, #FF6A00)" }}>{e.method}</span>
                  <code className="text-[12px] font-mono truncate text-text-secondary">{e.url_template}</code>
                  {e.verification_status === "verified" && <span className="text-[11px]" style={{ color: "#4ADE80" }} title="Verified">✦</span>}
                </div>
                {desc && <p className="mt-1.5 text-[12px] text-text-muted line-clamp-2">{desc}</p>}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Integrate */}
      <section className="mt-10">
        <h2 className="text-[16px] font-semibold text-text-primary mb-4">Integrate</h2>
        <pre className="rounded-xl p-4 text-[12px] font-mono overflow-x-auto" style={{ background: "var(--code-bg, rgba(8,7,6,0.96))", border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
{`# CLI
unbrowse resolve "${skill.intent_signature}" --domain ${skill.domain}
unbrowse execute <endpoint_id>

# Legacy MCP stdio (manual-only)
unbrowse mcp`}
        </pre>
      </section>
    </main>
  );
}
