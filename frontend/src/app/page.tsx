/* Homepage — the unbrowse skill registry (Smithery-style: search over a visible
 * grid). The registry is the front door (the moat: websites → API routes); the
 * Aiko chat is a flagship feature at /aiko, surfaced as a section here. The old
 * long-form marketing site lives at /classic.
 */

/* Visual layer governed by design.md (editorial-restraint DNA). Content + IA + routes
 * preserved; particle/constellation backdrop dropped per the locked system. */
import Link from "next/link";
import { listPopularSkills, getStatsSummary, type PopularSkillSummary, type StatsSummary } from "@/lib/api";
import { RegistrySearch } from "@/components/registry-search";
import { RegistryCard } from "@/components/registry-card";
// Restored cool sections from the pre-registry homepage — woven back in to enrich
// the front door (the value-narrative the minimal registry had dropped).
import { SpeedComparison } from "@/components/speed-comparison";
import { WorksWith } from "@/components/works-with";
import { UseCasesBand } from "@/components/use-cases-band";
import { InternetEvolution } from "@/components/internet-evolution";
import { UniversalProofBand } from "@/components/universal-proof-band";
import { AdoptersRail } from "@/components/adopters-rail";
import { TrustStrip } from "@/components/trust-strip";

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

      {/* Hero — H1 Marquee: eyebrow → editorial headline → the live action.
          One restrained warm radial glow replaces the particle backdrop. */}
      <section className="relative overflow-hidden pt-20 sm:pt-28 pb-12 text-center">
        <div className="hero-glow" aria-hidden="true" />
        <div className="relative z-10">
          <span className="eyebrow reveal reveal-1">The registry of website API routes</span>
          <h1
            className="reveal reveal-2 mx-auto mt-4 mb-4 max-w-3xl font-semibold text-text-primary"
            style={{ fontSize: "clamp(2.25rem, 6vw, 4rem)", lineHeight: 1.05, letterSpacing: "-0.025em" }}
          >
            Any website, <span className="serif-em" style={{ color: "var(--orange-400, #FF6A00)" }}>instantly</span> an API for your agent
          </h1>
          <p className="reveal reveal-2 mx-auto mb-9 max-w-xl text-[15px] leading-relaxed text-text-secondary">
            {stats
              ? `Browse ${nf.format(stats.skills)} skills across ${nf.format(stats.domains)} domains · ${nf.format(stats.executions)} live calls`
              : "Resolve an intent to a ranked endpoint. Execute for real data. No per-site setup."}
          </p>
          <div className="reveal reveal-3">
            <RegistrySearch pool={resolvePool} perf={stats?.perf ?? null} />
          </div>
          {/* Peer-reviewed credibility — the paper's strongest citable proof, surfaced
              on the front door. Numbers are the published benchmark (arXiv:2604.00694);
              link goes to the full deep-dive. Kept subordinate to the live search. */}
          <p className="reveal reveal-3 mt-6 text-[12px] text-text-muted">
            <span className="eyebrow" style={{ color: "var(--text-muted)" }}>Peer-reviewed</span>{" · "}
            <Link
              href="/benchmark-deep-dive"
              className="font-medium underline underline-offset-2 transition-opacity hover:opacity-80"
              style={{ color: "var(--orange-400, #FF6A00)" }}
            >
              94-domain benchmark
            </Link>
            {" "}· 3.6× mean speedup (5.4× median), 100% win rate
          </p>
        </div>
      </section>

      {/* Categories */}
      <nav className="flex flex-wrap gap-2 justify-center pb-14">
        {CATEGORIES.map((c) => (
          <Link key={c} href={`/search?q=${encodeURIComponent(c)}`} className="rounded-full px-3.5 py-1.5 text-[13px] transition-colors duration-200 hover:text-text-primary hover:border-border-strong" style={{ border: "var(--rule)", color: "var(--text-secondary)" }}>
            {c}
          </Link>
        ))}
      </nav>

      {/* Popular skills grid — the catalog is the proof of value */}
      <section className="pb-20">
        <div className="section-head">
          <span className="eyebrow">Catalog</span>
          <div className="flex items-end justify-between gap-4">
            <h2 className="text-[20px] font-semibold tracking-tight text-text-primary">Most-used skills</h2>
            <Link href="/search" className="shrink-0 text-[13px] transition-opacity hover:opacity-80" style={{ color: "var(--orange-400, #FF6A00)" }}>Browse all →</Link>
          </div>
          {/* Explain the catalog once here, not on every card — the cards then carry
              only their own real signals (domain, routes, calls, reliability). */}
          <p className="mt-2 mb-6 max-w-xl text-[13px] leading-relaxed text-text-secondary">Captured routes you replay as a direct API — no browser, no scraping.</p>
        </div>
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

      {/* Restored value-narrative sections (woven into the registry homepage),
          ordered: why it matters → what you do → the vision → proof → integrations
          → who runs it. */}
      <SpeedComparison />
      <UseCasesBand />
      <InternetEvolution />
      <UniversalProofBand />
      <WorksWith />
      <AdoptersRail />
      <TrustStrip />

      {/* Try Aiko live — the chat is the demo of the registry */}
      <section className="pb-20">
        <div className="rounded-3xl bg-surface-raised p-9 sm:p-12 text-center" style={{ border: "var(--rule)", boxShadow: "0 24px 90px -56px var(--glow, rgba(255,82,0,0.45))" }}>
          <span className="eyebrow">✦ aiko-0.8b</span>
          <h2 className="mt-3 mb-2 font-semibold text-text-primary" style={{ fontSize: "clamp(1.5rem, 3.5vw, 1.875rem)", letterSpacing: "-0.02em" }}>
            See it work — ask Aiko <span className="serif-em">anything</span>
          </h2>
          <p className="mx-auto mb-7 max-w-lg text-[14px] leading-relaxed text-text-secondary">
            Aiko answers live through these routes. Watch a real question resolve and execute in seconds — the registry, in motion.
          </p>
          <Link href="/aiko" className="inline-block rounded-xl px-6 py-3 text-[14px] font-medium transition-transform duration-200 hover:-translate-y-px" style={{ background: "var(--orange-500, #FF5200)", color: "#0c0500" }}>
            Open Aiko →
          </Link>
        </div>
      </section>

      {/* Install */}
      <section className="pb-28">
        <div className="section-head text-center">
          <span className="eyebrow" style={{ display: "block" }}>Get started</span>
          <h2 className="mt-2 mb-5 text-[20px] font-semibold tracking-tight text-text-primary">Wire it into your agent</h2>
          <code className="inline-block rounded-xl px-4 py-2.5 font-mono text-[13px]" style={{ background: "var(--code-bg, rgba(8,7,6,0.96))", border: "var(--rule)", color: "var(--orange-400, #FF6A00)" }}>
            npx unbrowse setup --mcp
          </code>
          <div className="mt-5 text-[13px]">
            <Link href="/classic" className="transition-opacity hover:opacity-80" style={{ color: "var(--text-muted)" }}>The full overview →</Link>
          </div>
        </div>
      </section>
    </main>
  );
}
