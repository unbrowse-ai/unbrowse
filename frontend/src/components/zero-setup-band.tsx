'use client';

import { IconHourglass, IconSeal, IconScript, IconDiamondCheck } from "./archival-icons";

/**
 * Zero-setup web access band. Three cards, each citing a Reddit-voiced
 * pain that Unbrowse's default behavior already resolves.
 *
 * Wave-3 codebase fixes applied:
 *   - F2: Card A reframed around JA4 TLS impersonation + libcurl-impersonate
 *     (the actual primitive, per src/mcp.ts:700) and real-Chrome cookies.
 *     Residential-proxy fallback is softened to "one env var away" since
 *     UNBROWSE_PROXY_URL is opt-in, not auto.
 *   - U2: Card B sharpened with stale-endpoint detection + ranker demotion
 *     + three-surface login hint (the active 5-commit story per p25:
 *     #517 auth_walled, #518 401-feedback, #519 + #520 login hints).
 *
 * Sources traced in frontend/docs/POSITIONING.md.
 */
export function ZeroSetupBand() {
  return (
    <section id="zero-setup" className="relative py-16 sm:py-24 flex flex-col justify-center">
      <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 min-w-0">
        <div className="relative text-center mb-6 flex flex-col items-center">
          <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-3">
            ##  Zero-setup web access
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance text-text-primary max-w-3xl">
            The bypasses your agent currently needs, already wired in.
          </h2>
          <p className="text-sm sm:text-base text-text-secondary mt-3 max-w-2xl leading-relaxed">
            Three things every production agent hits the wall on. Three
            defaults that mean you do not.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">

          {/* Card A — JA4 + libcurl-impersonate (corrected from residential-magic) */}
          <div className="group relative p-5 border border-[rgba(255,122,32,0.2)] bg-[#070503]/90 overflow-hidden transition-colors hover:border-[rgba(255,122,32,0.35)] rounded-sm flex flex-col">
            <div className="mb-3 flex items-center gap-2 text-orange-500">
              <IconHourglass size={16} />
              <span className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted">Bot detection</span>
            </div>
            <h3 className="text-lg font-semibold mb-2 tracking-tight">JA4 fingerprint of a real Chrome.</h3>
            <p className="text-text-secondary text-sm leading-relaxed mb-4 flex-1">
              <code className="text-xs font-mono">unbrowse_fetch</code> ships with libcurl-impersonate so the TLS handshake
              looks identical to a real browser. Pair that with your own
              Chrome cookies and Turnstile / Datadome / PerimeterX usually
              never fire. Residential-proxy fallback is one env var away.
            </p>
            <div className="bg-[#060402] border border-[rgba(255,122,32,0.12)] p-3 mt-auto rounded-sm font-mono tabular-nums">
              <div className="flex justify-between items-center text-xs mb-2 pb-2 border-b border-[rgba(255,122,32,0.08)]">
                <span className="text-text-muted">Headless Chrome (default JA4)</span>
                <span className="text-text-muted line-through">flagged</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-text-primary font-medium">unbrowse JA4 + your cookies</span>
                <span className="text-orange-500 font-semibold">200 OK</span>
              </div>
            </div>
          </div>

          {/* Card B — Auth intelligence (sharpened with stale-endpoint demotion) */}
          <div className="group relative p-5 border border-[rgba(255,122,32,0.2)] bg-[#070503]/90 transition-all overflow-hidden hover:border-[rgba(255,122,32,0.35)] rounded-sm flex flex-col">
            <div className="mb-3 flex items-center gap-2 text-orange-500">
              <IconSeal size={16} />
              <span className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted">Auth intelligence</span>
            </div>
            <h3 className="text-lg font-semibold mb-2 tracking-tight">Your agent inherits your login. And knows when it dies.</h3>
            <p className="text-text-secondary text-sm leading-relaxed mb-4 flex-1">
              Cookies from your real Chrome and Firefox flow in on every
              navigation. When an endpoint 401s, the ranker marks it{" "}
              <code className="text-xs font-mono">auth_walled</code> and demotes it the next time you resolve.
              Three login-hint surfaces (Keychain / browser / agent prompt)
              tell you exactly where to reauthenticate.
            </p>
            <div className="pt-4 border-t border-[rgba(255,122,32,0.12)] space-y-2 mt-auto">
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <IconDiamondCheck size={14} className="text-orange-500 shrink-0" /> Chrome + Firefox cookie jars
              </div>
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <IconDiamondCheck size={14} className="text-orange-500 shrink-0" /> Keychain-stored auth profiles
              </div>
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <IconDiamondCheck size={14} className="text-orange-500 shrink-0" /> Stale endpoints demoted in resolve
              </div>
            </div>
          </div>

          {/* Card C — No injected JS */}
          <div className="group relative p-5 border border-[rgba(255,122,32,0.2)] bg-[#070503]/90 transition-all overflow-hidden hover:border-[rgba(255,122,32,0.35)] rounded-sm flex flex-col">
            <div className="mb-3 flex items-center gap-2 text-orange-500">
              <IconScript size={16} />
              <span className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted">Extraction</span>
            </div>
            <h3 className="text-lg font-semibold mb-2 tracking-tight">Markdown out. Not innerHTML.</h3>
            <p className="text-text-secondary text-sm leading-relaxed mb-4 flex-1">
              Extraction lives inside the browser broker, not as a JS snippet
              injected from outside. CSP-strict sites work. Chromium updates
              do not break the agent. Every endpoint gets an LLM-authored
              description at capture time so resolve picks the right one.
            </p>
            <div className="bg-[#060402] border border-[rgba(255,122,32,0.12)] p-3 mt-auto rounded-sm font-mono">
              <div className="flex justify-between items-center text-xs mb-2 pb-2 border-b border-[rgba(255,122,32,0.08)]">
                <span className="text-text-muted">Framework injected JS</span>
                <span className="text-text-muted line-through">a11y tree</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-text-primary font-medium">unbrowse</span>
                <span className="text-orange-500 font-semibold">JSON answer</span>
              </div>
            </div>
          </div>

        </div>
      </div>
    </section>
  );
}
