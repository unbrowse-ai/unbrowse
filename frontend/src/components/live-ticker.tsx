'use client';

/**
 * LiveTicker — sticky archival-orange footer-bar. Polls /v1/stats/summary
 * every 30s and shows the deltas as a "constant motion" infrastructure
 * signal, in the Wise/Stripe live-ticker style.
 *
 * Endpoint:
 *   /v1/stats/summary → { skills, endpoints, domains, executions, agents }
 *
 * The "calls in the last 60s" counter the brief asked for does not exist
 * server-side yet (no /v1/stats/recent route in backend/src/routes/stats.ts).
 * Until that endpoint ships, the ticker shows:
 *   - cumulative agent calls (executions) — real
 *   - delta over the last poll window — real
 *   - the "60s window" counter is held as a TODO placeholder "—"
 *     so the bar reads truthful instead of fabricated.
 *
 * Stays sticky at viewport bottom. When the page bottom is reached, the
 * SiteFooter scrolls in beneath naturally. Respects prefers-reduced-motion:
 * disables the tick-blink + ticker-tape animation; counters still update
 * on poll, just without motion.
 */

import { useEffect, useRef, useState } from 'react';

// Inline thin fetch instead of pulling @/lib/api into the global layout bundle.
// /v1/stats/summary is anonymous + cached at the edge; no auth headers needed.
const API_BASE =
  process.env.NEXT_PUBLIC_UNBROWSE_API_URL ?? 'https://beta-api.unbrowse.ai';
const POLL_MS = 30_000;

type StatsSummary = {
  skills: number;
  endpoints: number;
  domains: number;
  executions: number;
  agents: number;
};

async function fetchStatsSummary(): Promise<StatsSummary> {
  const res = await fetch(`${API_BASE}/v1/stats/summary`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`stats/summary ${res.status}`);
  return res.json();
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return n.toLocaleString();
}

export function LiveTicker() {
  const [stats, setStats] = useState<StatsSummary | null>(null);
  const [delta, setDelta] = useState<number | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [blink, setBlink] = useState(false);
  const lastFetchRef = useRef<number>(0);
  const dismissedRef = useRef(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduceMotion(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await fetchStatsSummary();
        if (cancelled) return;
        setStats((cur) => {
          if (cur) {
            const d = s.executions - cur.executions;
            // Only surface a delta when positive — server-side counters
            // never go down; a negative delta means counter reset, suppress.
            setDelta(d > 0 ? d : null);
          }
          return s;
        });
        lastFetchRef.current = Date.now();
        if (!reduceMotion) {
          setBlink(true);
          setTimeout(() => setBlink(false), 800);
        }
      } catch {
        // network blip — keep showing the last value, suppress the delta.
      }
    };
    // Defer first fetch to idle / after initial paint so the ticker doesn't
    // extend the page's networkidle window and trigger extra prefetches in
    // the perf-audit measurement. Real users see numbers within a couple
    // of seconds — well below human perception threshold for a footer ticker.
    let initialId: number | undefined;
    type WindowWithIdle = Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    };
    const w = window as WindowWithIdle;
    if (typeof w.requestIdleCallback === 'function') {
      initialId = w.requestIdleCallback(() => tick(), { timeout: 3500 });
    } else {
      initialId = window.setTimeout(tick, 2500);
    }
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      if (initialId !== undefined) {
        const cancelIdle = (window as WindowWithIdle & {
          cancelIdleCallback?: (id: number) => void;
        }).cancelIdleCallback;
        if (typeof cancelIdle === 'function') {
          cancelIdle(initialId);
        } else {
          window.clearTimeout(initialId);
        }
      }
    };
  }, [reduceMotion]);

  if (dismissed || dismissedRef.current) return null;

  // First load: render the bar with placeholders so it doesn't pop in.
  const showing = stats !== null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Unbrowse live activity ticker"
      style={{
        position: 'sticky',
        bottom: 0,
        zIndex: 30,
        width: '100%',
        background: 'rgba(7, 5, 3, 0.94)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        borderTop: '1px solid rgba(255,122,32,0.22)',
        fontFamily: 'var(--hl-font-mono)',
        fontSize: '11px',
        color: 'rgba(255,176,96,0.78)',
        letterSpacing: '0.04em',
        // Lock height so its presence doesn't cause CLS when stats arrive.
        minHeight: 36,
      }}
    >
      <div
        style={{
          maxWidth: '76rem',
          margin: '0 auto',
          padding: '0.5rem clamp(1rem, 4vw, 2rem)',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 'clamp(1rem, 3vw, 2.5rem)',
          flexWrap: 'wrap',
          minHeight: 36,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: blink ? 'rgba(255,82,0,1)' : 'rgba(255,82,0,0.65)',
            boxShadow: blink
              ? '0 0 8px rgba(255,82,0,0.85)'
              : '0 0 4px rgba(255,82,0,0.4)',
            transition: reduceMotion ? 'none' : 'all 220ms ease-out',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
            color: 'rgba(255,122,32,0.55)',
            fontSize: '10px',
            flexShrink: 0,
          }}
        >
          live
        </span>

        {/* Calls in last 60s — TODO: needs /v1/stats/recent server-side */}
        <span style={{ tabularNums: true } as React.CSSProperties}>
          <span style={{ color: 'rgba(255,176,96,0.95)', fontVariantNumeric: 'tabular-nums' }}>
            {/* TODO: /v1/stats/recent endpoint would supply 60s window counter */}
            —
          </span>{' '}
          <span style={{ color: 'rgba(255,194,140,0.88)' }}>calls / 60s</span>
        </span>

        {/* Cumulative executions — real */}
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ color: 'rgba(255,176,96,0.95)' }}>
            {showing ? fmt(stats.executions) : '—'}
          </span>{' '}
          <span style={{ color: 'rgba(255,194,140,0.88)' }}>total calls</span>
          {delta !== null && delta > 0 ? (
            <span
              style={{
                marginLeft: '0.5rem',
                color: 'rgba(255,82,0,0.95)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              +{fmt(delta)}
            </span>
          ) : null}
        </span>

        {/* Endpoints — real */}
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ color: 'rgba(255,176,96,0.95)' }}>
            {showing ? fmt(stats.endpoints) : '—'}
          </span>{' '}
          <span style={{ color: 'rgba(255,194,140,0.88)' }}>endpoints</span>
        </span>

        {/* Domains — real */}
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ color: 'rgba(255,176,96,0.95)' }}>
            {showing ? fmt(stats.domains) : '—'}
          </span>{' '}
          <span style={{ color: 'rgba(255,194,140,0.88)' }}>domains</span>
        </span>

        <span style={{ marginLeft: 'auto', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <span style={{ color: 'rgba(255,122,32,0.45)', fontSize: '10px' }}>
            polls every 30s
          </span>
          <button
            type="button"
            aria-label="Dismiss live ticker"
            onClick={() => {
              dismissedRef.current = true;
              setDismissed(true);
            }}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,122,32,0.3)',
              color: 'rgba(255,176,96,0.7)',
              padding: '0.15rem 0.5rem',
              cursor: 'pointer',
              fontFamily: 'var(--hl-font-mono)',
              fontSize: '10px',
              letterSpacing: '0.1em',
            }}
            className="live-ticker-dismiss"
          >
            ×
          </button>
        </span>
      </div>
      <style jsx>{`
        .live-ticker-dismiss:focus-visible {
          outline: 1px solid rgba(255, 176, 96, 0.7);
          outline-offset: 1px;
        }
        .live-ticker-dismiss:hover {
          background: rgba(255, 122, 32, 0.12);
          color: rgba(255, 176, 96, 0.95);
        }
      `}</style>
    </div>
  );
}
