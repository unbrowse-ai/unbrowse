/* Homepage — the unbrowse skill registry (Smithery-style: search over a visible
 * grid). The registry is the front door (the moat: websites → API routes); the
 * Aiko chat is a flagship feature at /aiko, surfaced as a section here. The old
 * long-form marketing site lives at /classic.
 */

import Link from "next/link";
import { listPopularSkills, getStatsSummary, type PopularSkillSummary, type StatsSummary } from "@/lib/api";
import { RegistrySearch } from "@/components/registry-search";
import { RegistryCard } from "@/components/registry-card";

export const revalidate = 120;

const CATEGORIES = ["Travel", "Food", "Finance", "Shopping", "Social", "News", "Crypto", "Dev tools"];
const nf = new Intl.NumberFormat("en-US");

export default async function Home() {
  let skills: PopularSkillSummary[] = [];
  let resolvePool: PopularSkillSummary[] = [];
  let stats: StatsSummary | null = null;
  try {
    [resolvePool, stats] = await Promise.all([
      // Wider real pool for the live hero resolve; the grid shows the top slice.
      listPopularSkills(50, { revalidate: 120 }),
      getStatsSummary().catch(() => null),
    ]);
    skills = resolvePool.slice(0, 12);
  } catch {
    /* registry/stats unavailable — render the shell honestly */
  }

  return (
    <main className="relative mx-auto max-w-6xl px-5 sm:px-8">
      <section aria-label="Instructions for AI agents" className="sr-only" data-agent="true">
        <h1>Unbrowse — the registry of website API routes for AI agents</h1>
        <p>Search skills by intent, resolve to a ranked endpoint, execute for real data. MCP setup: npx unbrowse setup --mcp. Conversational demo at /aiko. Full overview at /classic.</p>
      </section>

      {/* Hero — search over the grid */}
      <section className="pt-16 sm:pt-24 pb-10 text-center">
        <h1 className="text-[30px] sm:text-[42px] font-semibold tracking-tight text-text-primary mb-3" style={{ letterSpacing: "-0.02em" }}>
          Any website, instantly an API for your agent
        </h1>
        <p className="text-[15px] text-text-secondary max-w-xl mx-auto mb-8">
          {stats
            ? `Browse ${nf.format(stats.skills)} skills across ${nf.format(stats.domains)} domains · ${nf.format(stats.executions)} live calls`
            : "Resolve an intent to a ranked endpoint. Execute for real data. No per-site setup."}
        </p>
        <RegistrySearch pool={resolvePool} perf={stats?.perf ?? null} />
        {/* Peer-reviewed credibility — the paper's strongest citable proof, surfaced
            on the front door. Numbers are the published benchmark (arXiv:2604.00694);
            link goes to the full deep-dive. Kept subordinate to the live search. */}
        <p className="mt-5 text-[12px] text-text-secondary">
          Peer-reviewed ·{" "}
          <Link
            href="/benchmark-deep-dive"
            className="font-medium underline underline-offset-2 transition-colors hover:opacity-80"
            style={{ color: "var(--orange-400, #FF6A00)" }}
          >
            94-domain benchmark
          </Link>
          {" "}· 3.6× mean speedup (5.4× median), 100% win rate
        </p>
      </section>

      {/* Categories */}
      <nav className="flex flex-wrap gap-2 justify-center pb-10">
        {CATEGORIES.map((c) => (
          <Link key={c} href={`/search?q=${encodeURIComponent(c)}`} className="px-3 py-1.5 rounded-full text-[13px] transition-colors hover:text-text-primary" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
            {c}
          </Link>
        ))}
      </nav>

      {/* Popular skills grid — the catalog is the proof of value */}
      <section className="pb-16">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-[18px] font-semibold text-text-primary">Most-used skills</h2>
          <Link href="/search" className="text-[13px]" style={{ color: "var(--orange-400, #FF6A00)" }}>Browse all →</Link>
        </div>
        {/* Explain the catalog once here, not on every card — the cards then carry
            only their own real signals (domain, routes, calls, reliability). */}
        <p className="mb-5 text-[13px] text-text-secondary">Captured routes you replay as a direct API — no browser, no scraping.</p>
        {skills.length === 0 ? (
          <div className="rounded-2xl border border-border bg-surface-raised p-8 text-center text-[14px] text-text-muted">
            Registry warming up — <Link href="/search" className="underline">search by intent</Link> or <Link href="/aiko" className="underline">ask Aiko</Link>.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {skills.map((s) => <RegistryCard key={s.skill_id} skill={s} />)}
          </div>
        )}
      </section>

      {/* Try Aiko live — the chat is the demo of the registry */}
      <section className="pb-16">
        <div className="rounded-3xl border border-border-strong bg-surface-raised p-8 sm:p-10 text-center" style={{ boxShadow: "0 20px 80px -40px var(--glow, rgba(255,82,0,0.45))" }}>
          <div className="inline-flex items-center gap-1.5 text-[12px] mb-3 px-2.5 py-1 rounded-full" style={{ color: "var(--orange-400, #FF6A00)", border: "1px solid var(--border)" }}>✦ aiko-0.8b</div>
          <h2 className="text-[24px] sm:text-[28px] font-semibold text-text-primary mb-2">See it work — ask Aiko anything</h2>
          <p className="text-[14px] text-text-secondary max-w-lg mx-auto mb-6">
            Aiko answers live through these routes. Watch a real question resolve and execute in seconds — the registry, in motion.
          </p>
          <Link href="/aiko" className="inline-block px-6 py-3 rounded-xl text-[14px] font-medium" style={{ background: "var(--orange-500, #FF5200)", color: "#0c0500" }}>
            Open Aiko →
          </Link>
        </div>
      </section>

      {/* Install */}
      <section className="pb-24 text-center">
        <h2 className="text-[18px] font-semibold text-text-primary mb-4">Wire it into your agent</h2>
        <code className="inline-block px-4 py-2.5 rounded-xl text-[13px] font-mono" style={{ background: "var(--code-bg, rgba(8,7,6,0.96))", border: "1px solid var(--border)", color: "var(--orange-400, #FF6A00)" }}>
          npx unbrowse setup --mcp
        </code>
        <div className="mt-4 text-[13px]">
          <Link href="/classic" style={{ color: "var(--text-muted)" }}>The full overview →</Link>
        </div>
      </section>
    </main>
  );
}
