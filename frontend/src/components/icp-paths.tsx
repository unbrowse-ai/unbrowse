"use client";

import { Activity, CheckCircle2, ChevronRight, Globe, Zap } from "lucide-react";
import { trackWebEvent } from "@/lib/web-telemetry";

const ICP_PATHS = [
  {
    id: "agent-builders",
    eyebrow: "For Agent Builders",
    title: "Replace Playwright on repeat web flows",
    body:
      "Built for Claude Code, Cursor, and custom agent stacks that are tired of rewriting brittle browser logic every time a UI changes.",
    points: [
      "Compare against Playwright, Puppeteer, and browser-use style flows",
      "Keep browser fallback for auth and edge cases",
      "Turn repeated browser work into reusable routes",
    ],
    href: "/compare/playwright",
    cta: "See the Playwright comparison",
    icon: Activity,
  },
  {
    id: "openclaw-normie",
    eyebrow: "For OpenClaw Users",
    title: "Install one plugin. Make your agent faster on websites.",
    body:
      "Built for the OpenClaw normie who just wants their agent to search, log in, check dashboards, and fetch results without waiting on screenshots.",
    points: [
      "One-command OpenClaw install",
      "Same tasks, less browser waiting",
      "Falls back to the browser when needed",
    ],
    href: "/personal-agents",
    cta: "Read the OpenClaw guide",
    icon: Globe,
  },
  {
    id: "mcp-hosts",
    eyebrow: "For MCP Hosts",
    title: "Add live website actions to any MCP client",
    body:
      "Built for MCP-native stacks that need one local website-action layer instead of a pile of one-off browser scripts or hand-wired site APIs.",
    points: [
      "Works with generic MCP hosts",
      "Local execution, reusable skills",
      "Ready config path, not custom glue",
    ],
    href: "/mcp.json",
    cta: "Grab the MCP config",
    icon: Zap,
  },
] as const;

export function IcpPaths() {
  return (
    <div id="icp-paths" className="animate-fade-up stagger-3 mt-8 sm:mt-10 w-full max-w-6xl">
      <div className="text-center mb-5 sm:mb-6">
        <p className="text-xs font-mono uppercase tracking-[0.22em] text-orange-600">Pick Your Starting Point</p>
        <p className="mt-2 text-sm sm:text-base text-text-secondary">
          Same runtime. Different buying story. Use the line that matches how you evaluate tools.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {ICP_PATHS.map((path) => {
          const Icon = path.icon;
          return (
            <div
              key={path.title}
              className="rounded-2xl border border-border bg-surface p-5 sm:p-6 text-left shadow-sm"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-orange-500/20 bg-orange-50">
                  <Icon className="h-5 w-5 text-orange-500" />
                </div>
                <p className="text-[11px] font-mono uppercase tracking-[0.22em] text-orange-700">
                  {path.eyebrow}
                </p>
              </div>
              <h3 className="mt-4 text-xl font-semibold tracking-tight text-text-primary">
                {path.title}
              </h3>
              <p className="mt-3 text-sm sm:text-base leading-relaxed text-text-secondary">
                {path.body}
              </p>
              <ul className="mt-4 space-y-2 text-sm text-text-secondary">
                {path.points.map((point) => (
                  <li key={point} className="flex items-start gap-2.5">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
              <a
                href={path.href}
                onClick={() => {
                  trackWebEvent("icp_path_clicked", {
                    target_id: path.id,
                    target_href: path.href,
                  });
                }}
                className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-orange-600 transition-colors hover:text-orange-700"
              >
                {path.cta}
                <ChevronRight className="h-4 w-4" />
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}
