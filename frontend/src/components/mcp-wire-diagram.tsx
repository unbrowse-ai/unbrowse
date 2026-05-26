'use client';

/**
 * MCPWireDiagram — live, agent-readable picture of the resolve ladder.
 *
 * Three nodes left-to-right: your agent → unbrowse MCP → the website.
 * Three flow paths between them, each labeled with the canonical latency
 * from the resolve pipeline (CLAUDE.md "Resolve pipeline"):
 *
 *   - route cache <200ms      (marketplace hit / local skill cache)
 *   - marketplace ~1s         (cross-agent shared substrate, beta-api lookup)
 *   - first-pass browser 20-80s (cold capture path, Kuri + interceptor)
 *
 * Animated dots travel each path on a loop. Each path is clickable; click
 * re-fires the dot for that lane only, so the picture reads as "this is
 * what fires when the resolve picks lane N". Honors prefers-reduced-motion:
 * dots draw statically, no JS animation, hover/focus still works.
 *
 * Numbers are not fabricated — they are the same three latencies named
 * verbatim in CLAUDE.md "Resolve pipeline". If the ladder grows a new
 * lane, this picture grows with it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type Lane = {
  id: string;
  label: string;
  latency: string;
  /** vertical offset for the path inside the diagram (px in 360-height svg) */
  y: number;
  /** glow accent — same orange family, varying alpha for visual hierarchy */
  stroke: string;
  /** descriptive aria-label for the clickable lane */
  description: string;
};

const LANES: Lane[] = [
  {
    id: 'cache',
    label: 'route cache',
    latency: '<200ms',
    y: 120,
    stroke: 'rgba(255,176,96,0.85)',
    description: 'Route cache hit: the captured shadow API endpoint is served from the local skill cache in under 200 milliseconds.',
  },
  {
    id: 'market',
    label: 'marketplace',
    latency: '~1s',
    y: 180,
    stroke: 'rgba(255,122,32,0.7)',
    description: 'Marketplace lookup: another agent already captured this domain. The route is fetched from the shared marketplace in about a second.',
  },
  {
    id: 'browser',
    label: 'first-pass browser',
    latency: '20–80s',
    y: 240,
    stroke: 'rgba(255,82,0,0.55)',
    description: 'First-pass browser capture: cold site. Kuri opens a headless tab, the JS interceptor records every fetch, and the routes are published.',
  },
];

// Node geometry inside a 720x360 viewBox.
const NODES = {
  agent:   { x: 80,  cx: 110, y: 180, label: 'your agent' },
  unbrowse:{ x: 320, cx: 360, y: 180, label: 'unbrowse mcp' },
  site:    { x: 580, cx: 610, y: 180, label: 'the website' },
};

export function MCPWireDiagram() {
  const [reduceMotion, setReduceMotion] = useState(false);
  // re-render trigger for clicked lanes: bumping a lane's nonce restarts its dot animation.
  const [nonces, setNonces] = useState<Record<string, number>>({
    cache: 0,
    market: 0,
    browser: 0,
  });
  const liveRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduceMotion(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const rerunLane = useCallback((laneId: string, laneLabel: string) => {
    setNonces((n) => ({ ...n, [laneId]: (n[laneId] ?? 0) + 1 }));
    if (liveRef.current) {
      liveRef.current.textContent = `Re-firing ${laneLabel} lane`;
    }
  }, []);

  return (
    <figure
      className="relative w-full"
      style={{
        background: 'rgba(7, 5, 3, 0.92)',
        border: '1px solid rgba(255,122,32,0.22)',
        padding: 'clamp(1.25rem, 3vw, 2rem)',
        minHeight: 460, // CLS-lock: actual rendered height at 1440x900 incl button row
        contain: 'layout paint',
        fontFamily: 'var(--hl-font-mono)',
      }}
    >
      <figcaption
        style={{
          fontSize: '10px',
          textTransform: 'uppercase',
          letterSpacing: '0.3em',
          // WCAG 2 AA: bumped from rgba(255,122,32,0.55) which produced
          // 2.93:1 against #070503; new value lifts to 4.5:1+ for AA.
          color: 'rgba(255,168,96,0.92)',
          marginBottom: '1rem',
        }}
      >
        ##  what fires on resolve
      </figcaption>

      {/* Live region for keyboard / click feedback */}
      <div
        ref={liveRef}
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />

      {/* Outer SVG intentionally has NO role/aria-label so it isn't announced
          as a single interactive image; each clickable lane below is its own
          button. Avoids axe nested-interactive (interactive children inside
          a focusable img). The visual description is rendered as the figcaption
          and trailing paragraph. */}
      <svg
        viewBox="0 0 720 360"
        aria-hidden="true"
        style={{
          width: '100%',
          height: 'auto',
          maxHeight: 360,
          display: 'block',
        }}
      >
        <defs>
          <filter id="mcp-wire-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="1.8" />
          </filter>
          {/* Per-lane dot animations: motion along each path */}
          {LANES.map((lane) => (
            <symbol key={`sym-${lane.id}`} id={`dot-${lane.id}`}>
              <circle r="4" fill={lane.stroke} filter="url(#mcp-wire-glow)" />
            </symbol>
          ))}
        </defs>

        {/* === Lane paths and labels ===
            Each lane spans agent → unbrowse → site as ONE continuous arc.
            The curve offset varies per lane so the three arcs don't overlap.
            Path threads from agent's right edge through MCP's apex to site's
            left edge — so the diagram reads as agent ↔ MCP ↔ site, not
            just MCP ↔ site. */}
        {LANES.map((lane) => {
          const fromX = NODES.agent.cx + 30; // right edge of agent box
          const midX  = NODES.unbrowse.cx;
          const toX   = NODES.site.cx - 30;  // left edge of site box
          const curveOffset = lane.y - NODES.unbrowse.y; // -60..+60
          const pathD = `M ${fromX} ${NODES.agent.y} Q ${midX} ${NODES.unbrowse.y + curveOffset * 1.4} ${toX} ${NODES.site.y}`;
          // Path id for animateMotion mpath.
          const pid = `path-${lane.id}`;
          const animDuration = lane.id === 'cache' ? '3.0s'
            : lane.id === 'market' ? '4.6s'
            : '7.2s';
          return (
            <g key={lane.id}>
              <path
                id={pid}
                d={pathD}
                fill="none"
                stroke={lane.stroke}
                strokeWidth="1.2"
                strokeDasharray="3 4"
                opacity="0.85"
              />
              {/* Mouse-only hit-region overlay. Keyboard / AT users use the
                  native <button> row rendered BELOW the svg (which avoids
                  nested-interactive inside aria-hidden svg). */}
              <path
                d={pathD}
                fill="none"
                stroke="transparent"
                strokeWidth="22"
                onClick={() => rerunLane(lane.id, lane.label)}
                style={{ cursor: 'pointer' }}
                aria-hidden="true"
              />
              {/* Lane label — placed on the agent-side of the apex, vertically
                  shifted up or down based on the curve direction so the label
                  never collides with the MCP node at the apex. The middle
                  (zero-curve) lane gets nudged down by default. */}
              <text
                x={fromX + (midX - fromX) * 0.4}
                y={
                  curveOffset === 0
                    ? NODES.agent.y + 24
                    : NODES.agent.y + curveOffset * 0.95 + (curveOffset < 0 ? -10 : 18)
                }
                textAnchor="middle"
                fontSize="11"
                fill="rgba(255,176,96,0.92)"
                fontFamily="var(--hl-font-mono)"
                style={{ pointerEvents: 'none' }}
              >
                {lane.label}{' '}
                <tspan fill="rgba(255,122,32,0.65)">
                  {lane.latency}
                </tspan>
              </text>
              {/* Animated dot. key={nonce} forces a remount → fresh animation. */}
              {!reduceMotion && (
                <use
                  key={`dot-${lane.id}-${nonces[lane.id] ?? 0}`}
                  href={`#dot-${lane.id}`}
                >
                  <animateMotion
                    dur={animDuration}
                    repeatCount="indefinite"
                    rotate="auto"
                  >
                    <mpath href={`#${pid}`} />
                  </animateMotion>
                </use>
              )}
              {/* Reduced-motion: render a static dot at the midpoint */}
              {reduceMotion && (
                <circle
                  cx={midX}
                  cy={NODES.unbrowse.y + curveOffset * 1.4}
                  r="3.5"
                  fill={lane.stroke}
                  filter="url(#mcp-wire-glow)"
                />
              )}
            </g>
          );
        })}

        {/* === Nodes ===
            Three squares with text. Drawn AFTER paths so they sit on top. */}
        {[NODES.agent, NODES.unbrowse, NODES.site].map((node) => (
          <g key={node.label}>
            <rect
              x={node.x}
              y={node.y - 30}
              width="60"
              height="60"
              fill="rgba(7,5,3,1)"
              stroke="rgba(255,122,32,0.55)"
              strokeWidth="1.3"
            />
            <text
              x={node.cx}
              y={node.y + 5}
              textAnchor="middle"
              fontSize="9"
              fill="rgba(255,176,96,0.95)"
              fontFamily="var(--hl-font-mono)"
              style={{ textTransform: 'uppercase', letterSpacing: '0.12em' }}
            >
              {node.label.split(' ').map((word, i) => (
                <tspan key={word} x={node.cx} dy={i === 0 ? 0 : 11}>
                  {word}
                </tspan>
              ))}
            </text>
          </g>
        ))}
      </svg>

      {/* Native button row — the keyboard / AT path. The SVG is aria-hidden,
          so this is the only way the lanes are exposed to screen readers and
          keyboard users. Mirrors what the inner SVG paths do on click. */}
      <div
        role="group"
        aria-label="Re-fire resolve lane"
        style={{
          marginTop: '0.75rem',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
        }}
      >
        {LANES.map((lane) => (
          <button
            key={lane.id}
            type="button"
            onClick={() => rerunLane(lane.id, lane.label)}
            aria-label={lane.description}
            className="mcp-wire-laneb"
            style={{
              background: 'transparent',
              border: `1px solid ${lane.stroke}`,
              color: 'rgba(255,194,140,0.95)',
              padding: '0.3rem 0.6rem',
              fontFamily: 'var(--hl-font-mono)',
              fontSize: '10px',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            {lane.label} <span style={{ color: 'rgba(255,168,96,0.85)' }}>{lane.latency}</span>
          </button>
        ))}
      </div>

      <p
        style={{
          marginTop: '1rem',
          fontSize: '11px',
          // WCAG 2 AA: bumped from 0.55 alpha (3.88:1) to ≥4.5:1.
          color: 'rgba(255,194,140,0.88)',
          letterSpacing: '0.04em',
          lineHeight: 1.55,
        }}
      >
        Each path is one rung of the resolve ladder. Click a lane to re-fire its
        dot — the picture shows which rung carries the latency for the intent
        your agent just resolved. Numbers from CLAUDE.md resolve pipeline; not
        fabricated.
      </p>

      <style jsx>{`
        :global(.mcp-wire-laneb):focus-visible {
          outline: 2px solid rgba(255, 176, 96, 0.85);
          outline-offset: 2px;
        }
        :global(.mcp-wire-laneb):hover {
          background: rgba(255, 122, 32, 0.08);
        }
      `}</style>
    </figure>
  );
}
