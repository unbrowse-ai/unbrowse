/**
 * Inline decision_trace mini-terminal for the hero.
 *
 * Shows a real unbrowse resolve output to satisfy unicorn-pattern #4
 * (product in hero) and reinforce the 100x speed claim (487ms ≈ 1/100th
 * of the 30s headless browser cost). Static render: no JS, no animation
 * cost on the LCP path.
 *
 * Visual aesthetic matches the install terminal below: orange border,
 * #060402 bg, mono font, archival eyebrow.
 */
export function HeroTerminal() {
  return (
    <div className="animate-fade-up stagger-3 w-full max-w-2xl mt-12">
      <div
        className="relative w-full border border-border bg-surface-ink overflow-hidden rounded-sm shadow-xl shadow-black/30"
        style={{ boxShadow: "0 0 60px -20px rgba(255,122,32,0.25)" }}
      >
        <div className="border-b border-border bg-[rgba(0,0,0,0.4)] px-4 py-2 flex items-center justify-between">
          <span className="text-[10px] font-mono uppercase tracking-[0.25em] text-orange-500">
            ##  decision_trace
          </span>
          <span className="text-[10px] font-mono text-text-muted">
            487ms
          </span>
        </div>
        <pre
          className="px-4 py-3 sm:px-5 sm:py-4 text-[11px] sm:text-xs font-mono leading-relaxed text-left text-text-secondary overflow-x-auto"
          style={{ fontVariantLigatures: "none" }}
        >
{`$ `}<span className="text-orange-500">unbrowse resolve</span>{` --intent `}<span className="text-[rgba(255,200,150,0.95)]">{`"user tweets"`}</span>{` \\
    --url `}<span className="text-[rgba(255,200,150,0.95)]">{`https://x.com/lekt8_`}</span>{`

`}<span className="text-orange-500">{`{`}</span>{`
  `}<span className="text-text-secondary">{`"trace"`}</span>{`:    `}<span className="text-orange-500">{`{`}</span>{` `}<span className="text-text-secondary">{`"skill_id"`}</span>{`: `}<span className="text-[rgba(255,200,150,0.95)]">{`"x.com"`}</span>{`, `}<span className="text-text-secondary">{`"endpoint_id"`}</span>{`: `}<span className="text-[rgba(255,200,150,0.95)]">{`"UserTweets"`}</span>{` `}<span className="text-orange-500">{`}`}</span>{`,
  `}<span className="text-text-secondary">{`"result"`}</span>{`:   `}<span className="text-orange-500">{`{`}</span>{` `}<span className="text-text-secondary">{`"available_operations"`}</span>{`: `}<span className="text-orange-500">{`[ 89 tweets ]`}</span>{` `}<span className="text-orange-500">{`}`}</span>{`,
  `}<span className="text-text-secondary">{`"ms"`}</span>{`:       `}<span className="text-orange-400">{`487`}</span>{`,
  `}<span className="text-text-secondary">{`"source"`}</span>{`:   `}<span className="text-[rgba(255,200,150,0.95)]">{`"marketplace"`}</span>{`
`}<span className="text-orange-500">{`}`}</span>
        </pre>
      </div>
      <p className="mt-3 text-center text-[10px] font-mono uppercase tracking-[0.25em] text-text-muted">
        Same call, headless browser equivalent: ~30,000ms.
      </p>
    </div>
  );
}
