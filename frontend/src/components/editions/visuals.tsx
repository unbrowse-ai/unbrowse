/**
 * Editions visual artifacts — CSS-only primary chapter visuals.
 *
 * Per taste-DAG (ONE CLAIM PER CHAPTER): every chapter
 * leads with a primary visual artifact, not feature-grid. We can't ship
 * product videos in one turn, so we build the visuals as drawn diagrams
 * that carry the chapter's claim.
 *
 * Style: ink + cream + one orange accent. No gradients. No glassmorphism.
 * Generous whitespace inside each diagram so it READS as a focused moment.
 */
import { Suspense } from "react";

/**
 * ShadowFlow — diagrams the capture-then-replay flow that IS the
 * Unbrowse thesis. The website's UI uses an internal API; the agent
 * captures that API on first visit; later calls bypass the browser.
 *
 * One frame, three columns, three arrows. No animation here — the
 * scroll-reveal carries the entrance; the diagram itself sits still.
 */
export function ShadowFlow() {
  return (
    <figure
      role="img"
      aria-label="Diagram showing an agent capturing a website's internal API on first visit, then calling that API directly on every later request"
      className="relative w-full max-w-[64rem] mx-auto animate-media-entrance"
    >
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1.2fr_auto_1fr] gap-6 md:gap-4 items-center py-12 md:py-20">
        {/* Column 1 — Agent */}
        <div className="flex flex-col items-center gap-3">
          <div
            className="w-20 h-20 md:w-24 md:h-24 border border-border-strong rounded-full flex items-center justify-center"
            style={{ background: "var(--surface-raised)" }}
          >
            <span className="font-display text-2xl md:text-3xl text-text-primary" aria-hidden>A</span>
          </div>
          <span className="stamp-label">Your agent</span>
          <span className="text-xs text-text-muted text-center max-w-[12rem]">
            asks in plain language
          </span>
        </div>

        {/* Arrow 1 */}
        <Arrow label="watches" />

        {/* Column 2 — Website (the capture target) */}
        <div className="flex flex-col items-center gap-3">
          <div className="relative w-full max-w-[18rem]">
            <div
              className="border border-border-strong rounded-sm overflow-hidden font-mono text-[11px]"
              style={{ background: "var(--surface)" }}
            >
              {/* Browser chrome */}
              <div className="px-3 py-2 border-b border-border flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-text-muted/40" aria-hidden />
                <span className="w-2 h-2 rounded-full bg-text-muted/40" aria-hidden />
                <span className="w-2 h-2 rounded-full bg-text-muted/40" aria-hidden />
                <span className="ml-2 text-text-muted truncate">airbnb.com</span>
              </div>
              {/* "UI calls its own API" cross-section */}
              <div className="p-3 grid gap-1.5">
                <span className="text-text-secondary">[Reserve →]</span>
                <span className="text-text-muted text-[10px] italic">↓ POSTs to</span>
                <span className="text-orange-text font-medium">/api/v3/reservations</span>
              </div>
            </div>
          </div>
          <span className="stamp-label">The site</span>
          <span className="text-xs text-text-muted text-center max-w-[14rem]">
            its own UI already calls a JSON API
          </span>
        </div>

        {/* Arrow 2 */}
        <Arrow label="calls direct" />

        {/* Column 3 — Direct API */}
        <div className="flex flex-col items-center gap-3">
          <div
            className="w-full max-w-[14rem] border border-border-strong rounded-sm font-mono text-[11px] p-3"
            style={{ background: "var(--surface-raised)" }}
          >
            <div className="text-text-muted text-[10px] mb-1">unbrowse_execute</div>
            <div className="text-text-primary leading-relaxed">
              <span className="text-orange-text">POST</span> /api/v3/reservations
              <br />
              <span className="text-text-muted">→ 142 ms · 280 tokens</span>
            </div>
          </div>
          <span className="stamp-label">Every visit after</span>
          <span className="text-xs text-text-muted text-center max-w-[14rem]">
            your agent calls the API itself, no browser
          </span>
        </div>
      </div>

      <figcaption className="sr-only">
        First visit: the site shows your agent which API its own UI calls. Every visit after: your agent calls that API itself, signed in with the user&apos;s cookies.
      </figcaption>
    </figure>
  );
}

function Arrow({ label }: { label: string }) {
  // arrow labels: "watches" (agent→site) on first visit, "calls" (agent→api) every visit after
  return (
    <div className="hidden md:flex flex-col items-center justify-center gap-2 px-2">
      <svg width="64" height="14" viewBox="0 0 64 14" aria-hidden className="text-text-muted">
        <line x1="0" y1="7" x2="56" y2="7" stroke="currentColor" strokeWidth="1" />
        <polyline
          points="50,2 56,7 50,12"
          stroke="currentColor"
          strokeWidth="1"
          fill="none"
        />
      </svg>
      <span className="stamp-label">{label}</span>
    </div>
  );
}

/**
 * SpeedupChart — the 3.6x claim, rendered as the artifact instead of
 * stamped as a number in a stats grid. Two horizontal bars: Playwright
 * (full width) vs Unbrowse (28% — the inverse of 3.6x). Real numbers
 * are read from the paper, not invented.
 *
 * The big "3.6x" sits next to the bars as display-type punctuation.
 */
export function SpeedupChart({
  meanMs = 1840,
  playwrightMs = 6624,
}: {
  meanMs?: number;
  playwrightMs?: number;
}) {
  const unbrowsePct = (meanMs / playwrightMs) * 100;
  return (
    <figure
      role="img"
      aria-label={`Speed chart showing Unbrowse at ${meanMs}ms mean vs Playwright at ${playwrightMs}ms mean, a 3.6x speedup`}
      className="w-full max-w-[64rem] mx-auto py-12 md:py-16 animate-media-entrance"
    >
      <div className="grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-10 lg:gap-16 items-center">
        {/* Big number — the artifact */}
        <div className="flex flex-col items-start">
          <span className="stamp-label">Mean speedup</span>
          <span
            className="font-display tabular-nums text-text-primary leading-none"
            style={{
              fontSize: "clamp(5rem, 14vw, 11rem)",
              letterSpacing: "-0.04em",
            }}
          >
            3.6×
          </span>
          <span className="text-sm text-text-muted mt-2 max-w-[22rem]">
            measured across 94 live domains. arXiv:2604.00694.
          </span>
        </div>

        {/* Bars */}
        <div className="flex flex-col gap-6 w-full">
          <BarRow label="Playwright" ms={playwrightMs} widthPct={100} dim />
          <BarRow label="Unbrowse" ms={meanMs} widthPct={unbrowsePct} accent />
        </div>
      </div>
    </figure>
  );
}

function BarRow({
  label,
  ms,
  widthPct,
  dim,
  accent,
}: {
  label: string;
  ms: number;
  widthPct: number;
  dim?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={
            (dim ? "text-text-muted" : "text-text-primary") +
            " font-display text-base tracking-tight"
          }
        >
          {label}
        </span>
        <span className="font-mono text-sm tabular-nums text-text-secondary">
          {ms.toLocaleString()} ms
        </span>
      </div>
      <div className="relative h-3 w-full border border-border" aria-hidden>
        <div
          style={{
            width: `${widthPct}%`,
            background: accent ? "var(--orange-600)" : "color-mix(in oklab, var(--text-primary) 14%, transparent)",
          }}
          className="h-full"
        />
      </div>
    </div>
  );
}

/**
 * FlywheelDiagram — the marketplace incentive cycle. Four nodes around
 * a circle, arrows along the path. The chapter's claim is "capture once
 * earn forever" and the diagram literally shows the cycle.
 *
 * SVG-rendered so it's crisp at any zoom. No Lottie, no canvas — just
 * geometry that holds the chapter's moment.
 */
export function FlywheelDiagram() {
  const nodes = [
    { x: 50, y: 8, label: "Capture", sub: "first agent indexes" },
    { x: 92, y: 50, label: "Publish", sub: "route hits marketplace" },
    { x: 50, y: 92, label: "Discover", sub: "every later agent finds it" },
    { x: 8, y: 50, label: "Earn", sub: "indexer gets USDC royalty" },
  ];
  return (
    <figure
      role="img"
      aria-label="Marketplace flywheel: agent captures a route, publishes it, other agents discover it, indexer earns USDC"
      className="w-full max-w-[44rem] mx-auto py-12 md:py-16 animate-media-entrance"
    >
      <div className="relative aspect-square">
        <svg viewBox="0 0 100 100" className="w-full h-full" aria-hidden>
          {/* Cycle path — restrained curve, not a full ring */}
          <defs>
            <marker
              id="arr"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="4"
              markerHeight="4"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          <g
            stroke="currentColor"
            strokeWidth="0.4"
            fill="none"
            className="text-border-strong"
          >
            <path d="M 50 12 A 38 38 0 0 1 88 50" markerEnd="url(#arr)" />
            <path d="M 88 50 A 38 38 0 0 1 50 88" markerEnd="url(#arr)" />
            <path d="M 50 88 A 38 38 0 0 1 12 50" markerEnd="url(#arr)" />
            <path d="M 12 50 A 38 38 0 0 1 50 12" markerEnd="url(#arr)" />
          </g>
          {/* Central note */}
          <text
            x="50"
            y="49"
            textAnchor="middle"
            className="font-display"
            style={{ fontSize: "5px", letterSpacing: "0.18em", textTransform: "uppercase" }}
            fill="currentColor"
          >
            <tspan className="text-text-muted">marketplace</tspan>
          </text>
          <text
            x="50"
            y="56"
            textAnchor="middle"
            className="font-display"
            style={{ fontSize: "4px" }}
            fill="currentColor"
          >
            <tspan className="text-text-muted">USDC · Solana · Faremeter</tspan>
          </text>
        </svg>
        {/* Node labels overlaid in HTML so type renders crisply */}
        {nodes.map((n) => (
          <div
            key={n.label}
            className="absolute flex flex-col items-center gap-1 px-2 py-1"
            style={{
              left: `${n.x}%`,
              top: `${n.y}%`,
              transform: "translate(-50%, -50%)",
              background: "var(--surface)",
            }}
          >
            <span className="font-display text-lg tracking-tight text-text-primary">
              {n.label}
            </span>
            <span className="text-[11px] text-text-muted text-center whitespace-nowrap">
              {n.sub}
            </span>
          </div>
        ))}
      </div>
    </figure>
  );
}

/**
 * InstallArtifact — replaces the legacy tan-terminal install-instructions
 * for the install chapter. Editorial code-block treatment: real install
 * command + host badge grid, both clean, both AA-compliant.
 *
 * The legacy InstallInstructions stays available on /install for the
 * full multi-host walkthrough. This is the chapter-moment version.
 */
export function InstallArtifact() {
  const cmd = "npx unbrowse setup --mcp";
  return (
    <figure className="w-full max-w-[56rem] mx-auto py-10 md:py-14 animate-media-entrance">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-10 items-center">
        {/* Editorial code block */}
        <div
          className="font-mono text-base md:text-lg leading-relaxed border border-border-strong rounded-sm"
          style={{ background: "var(--surface-ink)", color: "var(--text-inverse)" }}
        >
          <div
            className="px-5 py-3 border-b text-[11px] tracking-[0.18em] uppercase"
            style={{
              borderColor: "color-mix(in oklab, var(--text-inverse) 14%, transparent)",
              color: "color-mix(in oklab, var(--text-inverse) 60%, transparent)",
            }}
          >
            one command, any MCP host
          </div>
          <div className="px-5 py-7">
            <div className="flex items-baseline gap-3">
              <span style={{ color: "color-mix(in oklab, var(--text-inverse) 50%, transparent)" }}>$</span>
              <span style={{ color: "var(--text-inverse)" }}>{cmd}</span>
            </div>
          </div>
        </div>

        {/* Host badges */}
        <div className="flex flex-col gap-3 min-w-[14rem]">
          <span className="stamp-label">Plugs into</span>
          <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-sm text-text-secondary">
            <span>Claude Code</span>
            <span>Claude Desktop</span>
            <span>Cursor</span>
            <span>Codex</span>
            <span>Windsurf</span>
            <span>OpenClaw</span>
            <span>LangChain</span>
            <span>CrewAI</span>
          </div>
        </div>
      </div>
    </figure>
  );
}
