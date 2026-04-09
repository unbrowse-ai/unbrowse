import Link from "next/link";
import Image from "next/image";
import type { ReactNode } from "react";
import { ChatDemo } from "@/components/chat-demo";
import { AcquisitionTracker } from "@/components/acquisition-tracker";
import { InstallInstructions } from "@/components/install-instructions";
import { LandingAssignmentSync } from "@/components/landing-assignment-sync";
import { HeroCTA } from "@/components/hero-cta";
import { getHomepageLandingAssignment, type LandingVariantCopy } from "@/lib/landing-experiment";
import {
  FIRST_TASK_CMD,
  INSTALL_CMD_GENERIC,
  INSTALL_CMD_MCP,
  INSTALL_CMD_OPENCLAW,
  INSTALL_CMD_SKILL,
  MCP_CONFIG_PATH,
  UPGRADE_CMD_GENERIC,
  UPGRADE_CMD_MCP,
} from "@/lib/install-command";
import { Activity, ArrowRight, CheckCircle2, Github, Globe, Shield, Zap } from "lucide-react";

export const revalidate = 300;

const WHITEPAPER_URL = "https://arxiv.org/abs/2604.00694";
const DOCS_URL = "https://docs.unbrowse.ai";
const SHOW_ALL_INSTALL_OPTIONS = true;
const INSTALL_ANSWER = SHOW_ALL_INSTALL_OPTIONS
  ? `Recommended: ${INSTALL_CMD_OPENCLAW}. That makes Unbrowse your agent's native browser — every page.goto() routes through direct API calls automatically. The package pulls in the local runtime. For standalone CLI installs, use ${INSTALL_CMD_GENERIC}. After install, hosts with skills support can also use ${INSTALL_CMD_SKILL} for slash-command or host discovery. For generic MCP hosts, run ${INSTALL_CMD_MCP}; that writes a ready-to-import config to ${MCP_CONFIG_PATH}. Upgrade CLI installs with ${UPGRADE_CMD_GENERIC} and MCP installs with ${UPGRADE_CMD_MCP}.`
  : `Recommended: ${INSTALL_CMD_OPENCLAW}. For standalone CLI: ${INSTALL_CMD_GENERIC}. After install, hosts with skills support can also use ${INSTALL_CMD_SKILL}. Generic MCP hosts can use ${INSTALL_CMD_MCP}. Upgrade with ${UPGRADE_CMD_GENERIC} or ${UPGRADE_CMD_MCP}.`;

const TRUST_BAR_ITEMS: Record<LandingVariantCopy["trust_bar_order"][number], ReactNode> = {
  benchmarks: <span>94 domains benchmarked</span>,
  speed: <span>3.6x faster than Playwright on average</span>,
  paper: (
    <a
      href={WHITEPAPER_URL}
      target="_blank"
      rel="noopener"
      data-exploration-id="paper"
      className="hover:text-text-primary transition-colors"
    >
      Peer-reviewed on arXiv with NUS
    </a>
  ),
  github: (
    <a
      href="https://github.com/unbrowse-ai/unbrowse"
      target="_blank"
      rel="noopener"
      data-exploration-id="github"
      className="flex items-center gap-1.5 hover:text-text-primary transition-colors"
    >
      <Github className="h-3.5 w-3.5" />
      600+ GitHub stars
    </a>
  ),
  npm: <span>5K+ npm downloads</span>,
};

const WEDGE_CARDS = [
  {
    eyebrow: "100x faster",
    title: "Skip screenshots and DOM waits.",
    body: "OpenClaw usually pays the full browser tax on every run. Unbrowse learns the useful path once and reuses it on the next task.",
    icon: Globe,
  },
  {
    eyebrow: "90% cheaper",
    title: "Pay for the task, not the browser.",
    body: "Return structured data or actions without shipping a full browser loop through every run.",
    icon: Zap,
  },
  {
    eyebrow: "Compounds",
    title: "Mine routes that can earn passive income.",
    body: "Mine the internet into reusable skills. If other agents keep reusing what you mined, contributor payouts can compound from that reuse.",
    icon: Shield,
  },
] as const;

const SKILL_TRAITS = [
  {
    title: "Keeps login working",
    body: "A useful skill keeps the authenticated path intact while still using the browser for login, refresh, and fallback when needed.",
  },
  {
    title: "Returns data, not markup",
    body: "The output is a callable interface with inputs and structured responses, not another HTML page your agent has to parse.",
  },
  {
    title: "Refreshes when sites move",
    body: "When a route degrades, Unbrowse can re-browse, refresh the execution plan, and keep the task stable.",
  },
  {
    title: "Compounds on reuse",
    body: "Once a route is good, it stops being one-off automation and becomes infrastructure another agent can call again.",
  },
] as const;

const SECONDARY_PATHS = [
  {
    eyebrow: "Dashboard",
    title: "Track your routes, earnings, and wallet progress.",
    body: "The personal progress surface for contribution history, payouts, and wallet-level stats.",
    href: "/dashboard",
    cta: "Open dashboard",
  },
  {
    eyebrow: "Leaderboard",
    title: "See the contributor board and network coverage.",
    body: "The public board for ranked contributors, coverage growth, domain maps, and payout totals.",
    href: "/miners",
    cta: "Open leaderboard",
  },
  {
    eyebrow: "Contributors",
    title: "Your OpenClaw agent can earn while it works.",
    body: "The OpenClaw-specific payout story, plugin angle, and passive-income framing.",
    href: "/openclaw-earn",
    cta: "Open earning page",
  },
  {
    eyebrow: "Mining",
    title: "Mine the internet into reusable skills.",
    body: "The broader route-mining thesis, proof-of-indexing angle, and why reuse compounds.",
    href: "/mine-the-internet",
    cta: "Open mining page",
  },
] as const;

const FAQ_ITEMS = [
  {
    question: "Who is Unbrowse for?",
    answer:
      "It is for OpenClaw users and agent builders whose agents do repeated tasks on real websites and are tired of paying the full browser cost every time.",
  },
  {
    question: "How does Unbrowse work?",
    answer:
      "Use the browser once to learn the website task. After that, Unbrowse can replay the learned path as a reusable skill instead of forcing the agent to click through the whole UI again.",
  },
  {
    question: "How much faster is it than headless browser automation?",
    answer:
      "Across 94 benchmarked domains, the route-reuse path was 3.6x faster on average than Playwright. On repeated workflows, the gap is often bigger because Unbrowse avoids the full browser replay loop.",
  },
  {
    question: "Is this just scraping?",
    answer:
      "No. Scraping gives you page output. Unbrowse is trying to recover a callable execution path - something an agent can run again with auth, parameters, and structured responses.",
  },
  {
    question: "Do credentials leave my machine?",
    answer:
      "No. Unbrowse runs locally, keeps browser-backed auth local, and does not depend on a cloud proxy or man-in-the-middle layer.",
  },
  {
    question: "What if the website changes its internal API?",
    answer:
      "When a learned route goes stale, Unbrowse can re-browse the site, capture the updated flow, and refresh the skill instead of forcing you to rewrite selector-heavy scripts.",
  },
  {
    question: "How do I install it?",
    answer: INSTALL_ANSWER,
  },
  {
    question: "Does it work with OpenClaw?",
    answer:
      "Yes. Unbrowse can act like a drop-in browser replacement for OpenClaw, so the agent reaches websites through reusable skills instead of the normal browser loop when that path is available.",
  },
  {
    question: "What actually gets shared?",
    answer:
      "The point is to share the route knowledge and execution plan, not your personal session data. The reusable asset is the skill.",
  },
  {
    question: "Can I earn passive income from mined routes?",
    answer:
      "That is the contributor upside. If you mine useful routes and other agents keep reusing them, contributor payouts can accrue from that reuse instead of the work staying trapped in one local session.",
  },
  {
    question: "What is it not for?",
    answer:
      "If your main job is browser QA, visual regression testing, or full end-to-end UI testing, Playwright is still the better fit. Unbrowse is for agent execution on websites, not generic browser testing.",
  },
] as const;

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map(({ question, answer }) => ({
    "@type": "Question",
    name: question,
    acceptedAnswer: {
      "@type": "Answer",
      text: answer,
    },
  })),
};

export default async function Home() {
  const landing = await getHomepageLandingAssignment();
  const trustBarItems = landing.content.trust_bar_order.map((item) => TRUST_BAR_ITEMS[item]);

  return (
    <div
      id="landing-page-root"
      data-landing-variant-id={landing.assignment.variant_id}
      data-landing-experiment-id={landing.assignment.experiment_id}
      className="relative overflow-x-hidden selection:bg-orange-500/20"
    >
      <LandingAssignmentSync />
      <AcquisitionTracker
        experimentId={landing.assignment.experiment_id}
        variantId={landing.assignment.variant_id}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />

      <section
        id="agent-instructions"
        aria-label="Instructions for AI agents"
        className="sr-only"
        data-agent="true"
      >
        <h2>Unbrowse: the drop-in browser for OpenClaw agents on websites</h2>
        <p>
          Unbrowse is an open-source CLI that turns websites into reusable skills for agents by
          learning the request path behind the page and replaying it later.
        </p>
        <p>Setup: {INSTALL_CMD_OPENCLAW}</p>
        <p>Optional skill install: {INSTALL_CMD_SKILL}</p>
        <p>MCP setup: {INSTALL_CMD_MCP}</p>
        <p>Upgrade existing installs: {UPGRADE_CMD_GENERIC}</p>
        <p>MCP config template: https://www.unbrowse.ai/mcp.json</p>
        <p>Docs: {DOCS_URL}</p>
        <p>Usage: unbrowse resolve --intent "..." --url "..." --pretty</p>
      </section>

      <section className="relative isolate border-b border-border/80">
        <div className="absolute inset-0 -z-20 bg-[radial-gradient(circle_at_top_left,rgba(255,109,0,0.18),transparent_28%),radial-gradient(circle_at_85%_15%,rgba(255,255,255,0.08),transparent_22%),linear-gradient(180deg,rgba(255,255,255,0.04),transparent_55%)]" />
        <div className="absolute inset-x-0 top-0 -z-10 h-72 bg-[linear-gradient(to_right,var(--color-border)_1px,transparent_1px)] bg-[size:72px_72px] opacity-20 [mask-image:linear-gradient(to_bottom,black,transparent)]" />

        <div className="mx-auto grid max-w-7xl gap-14 px-4 pb-16 pt-24 sm:px-6 sm:pb-20 sm:pt-32 lg:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)] lg:items-center">
          <div className="max-w-3xl">
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-2 rounded-full border border-orange-500/20 bg-orange-50/70 px-3 py-1.5 text-sm font-medium tracking-tight text-orange-700 transition-colors hover:border-orange-500/40 hover:bg-orange-100/80"
            >
              <Github className="h-4 w-4" />
              Free, open source, local-first
            </a>

            <p className="mt-7 text-[11px] font-medium uppercase tracking-[0.28em] text-orange-700 sm:text-xs">
              For OpenClaw agents on real websites
            </p>

            <h1 className="mt-4 max-w-4xl text-balance font-display text-[3rem] leading-[0.96] tracking-[-0.04em] text-text-primary sm:text-[4.5rem] lg:text-[5.5rem]">
              Make your OpenClaw agent 100x faster,
              <span className="block text-orange-500">90% cheaper on websites.</span>
            </h1>

            <p className="mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
              Install one plugin. Skip screenshots, DOM waits, and selector repair. Unbrowse uses
              the browser once to learn the useful path, then reuses it on the next run.
            </p>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-text-muted sm:text-base">
              Built for agents that currently depend on Playwright-style browser loops to reach real
              websites. Good routes compound into reusable skills, and shared reuse can turn mined
              routes into contributor income.
            </p>
            <p className="mt-3 max-w-2xl text-xs font-medium uppercase tracking-[0.2em] text-text-muted sm:text-[0.82rem]">
              Also works with Claude Code, Codex, Cursor, and MCP hosts.
            </p>

            <div className="mt-8 flex flex-wrap gap-2.5 text-sm text-text-secondary">
              {trustBarItems.map((item, index) => (
                <div
                  key={landing.content.trust_bar_order[index]}
                  className="rounded-full border border-border bg-surface/70 px-3 py-1.5 backdrop-blur"
                >
                  {item}
                </div>
              ))}
            </div>

            <div className="mt-8 max-w-3xl">
              <HeroCTA
                experimentId={landing.assignment.experiment_id}
                variantId={landing.assignment.variant_id}
                primaryLabel={landing.content.hero_cta_label}
              />
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-4 text-sm text-text-secondary">
              <span className="rounded-full border border-orange-500/20 bg-orange-50/70 px-3 py-1.5 text-orange-700">
                Drop-in OpenClaw browser
              </span>
              <Link
                href="#install"
                className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/70 px-4 py-2 transition-colors hover:border-orange-500/30 hover:text-text-primary"
              >
                Full install matrix
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="#demo"
                className="inline-flex items-center gap-2 rounded-full border border-transparent px-1 py-2 transition-colors hover:text-text-primary"
              >
                See live flow
                <ArrowRight className="h-4 w-4" />
              </Link>
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noopener"
                data-exploration-id="docs"
                className="transition-colors hover:text-text-primary"
              >
                Docs
              </a>
            </div>
          </div>

          <div className="relative">
            <div className="absolute -inset-6 -z-10 rounded-[2rem] bg-orange-500/10 blur-3xl" />
            <div className="overflow-hidden rounded-[2rem] border border-border bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.01))] shadow-[0_30px_90px_rgba(0,0,0,0.18)]">
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">
                    Browser tax vs route reuse
                  </p>
                  <p className="mt-1 text-sm font-medium text-text-primary">
                    Same website. Less browser.
                  </p>
                </div>
                <div className="rounded-full border border-orange-500/20 bg-orange-50 px-3 py-1 text-xs font-medium text-orange-700">
                  replay-ready
                </div>
              </div>

              <div className="space-y-6 p-5">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-2xl border border-border bg-surface-sunken p-4">
                    <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">
                      Browser automation
                    </p>
                    <p className="mt-2 text-lg font-semibold tracking-tight text-text-primary">
                      Re-do the website
                    </p>
                    <div className="mt-4 space-y-3">
                      {[
                        ["Open page", "1.8s"],
                        ["Wait for DOM", "4.9s"],
                        ["Click + scrape", "9.3s"],
                        ["Parse output", "14.6s"],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <div className="flex items-center justify-between text-xs text-text-secondary">
                            <span>{label}</span>
                            <span className="font-mono">{value}</span>
                          </div>
                          <div className="mt-2 h-2 rounded-full bg-surface">
                            <div
                              className="h-2 rounded-full bg-text-muted/45"
                              style={{
                                width:
                                  value === "14.6s"
                                    ? "88%"
                                    : value === "9.3s"
                                      ? "63%"
                                      : value === "4.9s"
                                        ? "36%"
                                        : "18%",
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-orange-500/20 bg-orange-50/70 p-4 shadow-[0_18px_50px_rgba(255,109,0,0.08)]">
                    <p className="text-[11px] uppercase tracking-[0.24em] text-orange-700">
                      Unbrowse skill
                    </p>
                    <p className="mt-2 text-lg font-semibold tracking-tight text-text-primary">
                      Replay the useful path
                    </p>
                    <div className="mt-4 space-y-3">
                      {[
                        ["Resolve skill", "42ms"],
                        ["Call route", "118ms"],
                        ["Return data", "184ms"],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <div className="flex items-center justify-between text-xs text-text-secondary">
                            <span>{label}</span>
                            <span className="font-mono text-orange-700">{value}</span>
                          </div>
                          <div className="mt-2 h-2 rounded-full bg-white/70">
                            <div
                              className="h-2 rounded-full bg-orange-500 animate-pulse"
                              style={{
                                width:
                                  value === "184ms" ? "72%" : value === "118ms" ? "48%" : "26%",
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-border bg-surface-sunken/80 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">
                        What ships as the skill
                      </p>
                      <p className="mt-2 text-sm leading-7 text-text-secondary">
                        Not just a URL. Auth path, parameters, schema, and enough reliability state
                        to keep the task useful.
                      </p>
                    </div>
                    <code className="rounded-xl border border-orange-500/20 bg-orange-50 px-3 py-2 font-mono text-xs text-orange-700">
                      {FIRST_TASK_CMD}
                    </code>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {["auth-aware", "structured output", "refreshable", "browser fallback"].map(
                      (item) => (
                        <span
                          key={item}
                          className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium uppercase tracking-[0.16em] text-text-secondary"
                        >
                          {item}
                        </span>
                      ),
                    )}
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <MetricCard value="50-200ms" label="direct replay" />
                  <MetricCard value="~200" label="tokens / action" />
                  <MetricCard value="local" label="auth + cookies" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-border/70 py-14 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-4 px-4 sm:px-6 lg:grid-cols-3">
          {WEDGE_CARDS.map(({ eyebrow, title, body, icon: Icon }) => (
            <div
              key={title}
              className="rounded-[1.75rem] border border-border bg-surface/70 p-6 shadow-sm backdrop-blur"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-orange-500/20 bg-orange-50">
                <Icon className="h-5 w-5 text-orange-500" />
              </div>
              <p className="mt-5 text-[11px] font-medium uppercase tracking-[0.24em] text-orange-700">
                {eyebrow}
              </p>
              <h2 className="mt-5 text-xl font-semibold tracking-tight text-text-primary">
                {title}
              </h2>
              <p className="mt-3 text-sm leading-7 text-text-secondary">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-b border-border/70 py-16 sm:py-24">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-start">
          <div className="max-w-xl">
            <SectionEyebrow>Why OpenClaw Users Switch</SectionEyebrow>
            <h2 className="mt-5 text-balance text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
              Replace the browser loop. Keep the website task.
            </h2>
            <p className="mt-5 text-base leading-8 text-text-secondary sm:text-lg">
              Unbrowse is for agents that need to log in, click through real sites, and bring back
              data or actions. It is not for generic browser QA, pixel tests, or full end-to-end UI
              suites.
            </p>

            <div className="mt-8 space-y-4">
              {[
                "Old way: Playwright, screenshots, waits, selectors, retries.",
                "New way: install Unbrowse as the OpenClaw browser layer and reuse the learned path.",
                "When the site shifts: re-browse once, refresh the route, keep going.",
              ].map((item) => (
                <div key={item} className="flex items-start gap-3">
                  <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-orange-500" />
                  <p className="text-sm leading-7 text-text-secondary">{item}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[2rem] border border-border bg-surface p-4 shadow-sm sm:p-6">
            <div className="rounded-[1.5rem] border border-orange-500/20 bg-orange-50/70 p-5">
              <p className="text-[11px] uppercase tracking-[0.24em] text-orange-700">
                What compounds
              </p>
              <p className="mt-3 text-2xl font-semibold tracking-tight text-text-primary">
                The first good run pays for the next ones.
              </p>
              <p className="mt-3 text-sm leading-7 text-text-secondary">
                One working route removes a lot of repeated browser work. When you publish a route
                other agents reuse, that shared reuse can turn into contributor income.
              </p>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {SKILL_TRAITS.map((trait) => (
                <div
                  key={trait.title}
                  className="rounded-[1.5rem] border border-border bg-surface-sunken p-5"
                >
                  <p className="text-lg font-semibold tracking-tight text-text-primary">
                    {trait.title}
                  </p>
                  <p className="mt-3 text-sm leading-7 text-text-secondary">{trait.body}</p>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-[1.5rem] border border-border bg-surface-raised px-5 py-4">
              <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">
                Why teams switch
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <MetricCard value="5-30s" label="browser replay" />
                <MetricCard value="50-200ms" label="skill replay" />
                <MetricCard value="~200" label="tokens / action" />
              </div>
              <p className="mt-4 text-sm leading-7 text-text-secondary">
                Not for generic browser QA. Very much for OpenClaw and agent workflows on real
                websites, especially when mined routes can be reused by others.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="install" className="border-b border-border/70 py-16 sm:py-24">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
          <div className="max-w-xl">
            <SectionEyebrow>{landing.content.install_eyebrow}</SectionEyebrow>
            <h2 className="mt-5 text-balance text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
              Install the plugin. Then watch one real website task work.
            </h2>
            <p className="mt-5 text-base leading-8 text-text-secondary sm:text-lg">
              Fastest way to pattern-match the product: install Unbrowse into OpenClaw, run one
              website task, then watch the next run skip most of the browser loop.
            </p>

            <div className="mt-8 space-y-4">
              <div className="rounded-[1.5rem] border border-orange-500/20 bg-orange-50/70 p-5">
                <p className="text-[11px] uppercase tracking-[0.24em] text-orange-700">
                  Recommended
                </p>
                <code className="mt-3 block break-all font-mono text-sm text-orange-700">
                  npx unbrowse-openclaw install --restart
                </code>
              </div>

              <div className="rounded-[1.5rem] border border-border bg-surface p-5">
                <p className="text-sm leading-7 text-text-secondary">
                  One command. Makes Unbrowse the native browser — every page.goto() routes
                  through direct API calls automatically. No code changes needed. Add the skill
                  or MCP wiring only after the local path is healthy.
                </p>
                <p className="mt-2 text-xs leading-6 text-text-muted">
                  Includes{" "}
                  <a href="https://www.crossmint.com" target="_blank" rel="noopener" className="text-orange-700 hover:text-orange-600 transition-colors">
                    Crossmint
                  </a>{" "}
                  wallet setup — earn USDC when other agents use your routes.
                </p>
                <div className="mt-4 flex flex-wrap gap-2 text-xs font-medium uppercase tracking-[0.18em] text-text-muted">
                  <span className="rounded-full border border-orange-500/30 bg-orange-50 px-3 py-1.5 text-orange-700">OpenClaw</span>
                  <span className="rounded-full border border-border px-3 py-1.5">CLI</span>
                  <span className="rounded-full border border-border px-3 py-1.5">Codex</span>
                  <span className="rounded-full border border-border px-3 py-1.5">Claude Code</span>
                  <span className="rounded-full border border-border px-3 py-1.5">Cursor</span>
                  <span className="rounded-full border border-border px-3 py-1.5">MCP</span>
                </div>
              </div>

              <div className="rounded-[1.5rem] border border-border bg-surface p-5">
                <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">
                  Canonical quickstart
                </p>
                <code className="mt-3 block break-all font-mono text-sm text-orange-700">
                  {FIRST_TASK_CMD}
                </code>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <InstallInstructions
              experimentId={landing.assignment.experiment_id}
              variantId={landing.assignment.variant_id}
            />
            <div
              id="demo"
              className="rounded-[2rem] border border-border bg-surface p-5 shadow-sm sm:p-6"
            >
              <div className="max-w-2xl">
                <SectionEyebrow>Demo</SectionEyebrow>
                <h2 className="mt-5 text-balance text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
                  One agent mines Airbnb once. The next agent just uses the skill.
                </h2>
                <p className="mt-4 text-sm leading-7 text-text-secondary sm:text-base">
                  This is the product in one motion: mine the route, package it, replay it.
                </p>
              </div>
              <div className="mt-8">
                <ChatDemo />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 sm:pb-20">
          <div className="rounded-[2rem] border border-border bg-surface/70 p-6 shadow-sm backdrop-blur sm:p-8">
            <div className="max-w-2xl">
              <SectionEyebrow>Other Paths</SectionEyebrow>
              <h2 className="mt-5 text-balance text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
                The contributor and mining work did not go away.
              </h2>
              <p className="mt-4 text-sm leading-7 text-text-secondary sm:text-base">
                It moved off the homepage so the main wedge stayed clear. These pages carry the
                route-mining, payout, leaderboard, and proof-of-indexing story in full.
              </p>
            </div>

            <div className="mt-8 grid gap-4 lg:grid-cols-3">
              {SECONDARY_PATHS.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group rounded-[1.5rem] border border-border bg-surface p-5 transition-colors hover:border-orange-500/30 hover:bg-orange-50/40"
                >
                  <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-orange-700">
                    {item.eyebrow}
                  </p>
                  <h3 className="mt-4 text-xl font-semibold tracking-tight text-text-primary">
                    {item.title}
                  </h3>
                  <p className="mt-3 text-sm leading-7 text-text-secondary">{item.body}</p>
                  <div className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-orange-700">
                    {item.cta}
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="faq" className="py-16 sm:py-24">
        <div className="mx-auto max-w-4xl px-4 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <SectionEyebrow>FAQ</SectionEyebrow>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
              Questions skeptical builders actually ask
            </h2>
          </div>

          <div className="mt-12 grid gap-4">
            {FAQ_ITEMS.map((item) => (
              <FAQCard key={item.question} question={item.question} answer={item.answer} />
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-border/50 py-10">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <p className="text-center text-[11px] font-medium uppercase tracking-[0.28em] text-text-muted">
            Payments powered by
          </p>
          <div className="mt-4 flex items-center justify-center gap-8">
            <a
              href="https://www.crossmint.com"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/70 px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-orange-500/30 hover:text-text-primary"
            >
              <span className="font-semibold tracking-tight">Crossmint</span>
              <span className="hidden text-xs text-text-muted sm:inline">Agent payment infrastructure</span>
            </a>
            <a
              href="https://x402.org"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/70 px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-orange-500/30 hover:text-text-primary"
            >
              <span className="font-semibold tracking-tight font-mono">x402</span>
              <span className="hidden text-xs text-text-muted sm:inline">Protocol</span>
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-border/80 py-10 text-text-secondary">
        <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 sm:px-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <Image
                src="/logo.png"
                alt="unbrowse"
                width={28}
                height={28}
                unoptimized
                className="rounded-md"
              />
              <span className="text-base font-semibold tracking-tight text-text-primary">
                unbrowse
              </span>
            </div>
            <p className="mt-4 max-w-md text-sm leading-7">
              100x faster. 90% cheaper. Mine the internet into reusable skills for agents.
            </p>
            <div className="mt-5 inline-flex items-center gap-3 rounded-full border border-border bg-surface px-4 py-2">
              <Image
                src="/nvidia-inception.png"
                alt="NVIDIA Inception Program"
                width={96}
                height={36}
                className="block opacity-80"
              />
              <span className="text-xs uppercase tracking-[0.2em] text-text-muted">
                In NVIDIA Inception
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm font-medium">
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="hover:text-text-primary transition-colors"
            >
              GitHub
            </a>
            <a
              href="https://discord.gg/VWugEeFNsG"
              target="_blank"
              rel="noopener"
              className="hover:text-text-primary transition-colors"
            >
              Discord
            </a>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener"
              className="hover:text-text-primary transition-colors"
            >
              Docs
            </a>
            <Link href="/search" className="hover:text-text-primary transition-colors">
              Registry
            </Link>
            <Link href="/dashboard" className="hover:text-text-primary transition-colors">
              Dashboard
            </Link>
            <Link href="/terms" className="hover:text-text-primary transition-colors">
              Terms
            </Link>
            <Link href="/privacy" className="hover:text-text-primary transition-colors">
              Privacy
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function SectionEyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-orange-500/20 bg-orange-50/70 px-3 py-1.5 text-xs font-medium uppercase tracking-[0.24em] text-orange-700">
      <Activity className="h-3.5 w-3.5" />
      {children}
    </div>
  );
}

function MetricCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface px-4 py-3">
      <p className="text-lg font-semibold tracking-tight text-text-primary">{value}</p>
      <p className="mt-1 text-[11px] uppercase tracking-[0.2em] text-text-muted">{label}</p>
    </div>
  );
}

function FAQCard({ question, answer }: { question: string; answer: string }) {
  return (
    <div className="rounded-[1.5rem] border border-border bg-surface/80 p-6 shadow-sm">
      <h3 className="text-lg font-semibold tracking-tight text-text-primary">{question}</h3>
      <p className="mt-3 text-sm leading-7 text-text-secondary">{answer}</p>
    </div>
  );
}
