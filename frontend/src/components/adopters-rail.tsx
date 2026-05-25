/**
 * AdoptersRail — social-proof-through-scale rail surfacing real adopters
 * of Unbrowse. Lives directly under the hero per unicorn-landing pattern
 * #5 (lead with the biggest true number / real logos, not generic claims).
 *
 * Honesty rule: every name here MUST be a real, public adopter or a real
 * publicly-documented integration we can point at. No vapor logos.
 *
 *   - OpenClaw — public plugin (`openclaw-unbrowse-plugin` submodule v0.8.0
 *     pinned in this repo, 344K-star ecosystem per docs/built-on-unbrowse).
 *   - Claude Code — `npx @unbrowse/sdk setup` writes the MCP entry into
 *     `~/.claude/mcp.json` (see src/app/mcp.json + install-instructions).
 *   - Codex — same setup writes `~/.codex/mcp.json`.
 *   - Cursor, Windsurf, Claude Desktop — MCP-host installers documented at
 *     /install.
 *   - Crossmint — payout-rail partner (lobster.cash CLI is the recommended
 *     wallet path; see src/app/account/wallet/page.tsx Option 1).
 *   - Faremeter — payment substrate (`@faremeter/flex-solana` optional
 *     dep in packages/sdk/package.json).
 *
 * If a row stops being true (a partner deprecates, a host stops shipping
 * an MCP installer), delete the row, do not soften the copy.
 */

interface Adopter {
  name: string;
  href: string;
  surface: string;
}

const ADOPTERS: Adopter[] = [
  { name: "OpenClaw", href: "https://openclaw.com", surface: "Plugin" },
  { name: "Claude Code", href: "https://claude.com/code", surface: "MCP host" },
  { name: "Codex CLI", href: "https://github.com/openai/codex", surface: "MCP host" },
  { name: "Cursor", href: "https://cursor.com", surface: "MCP host" },
  { name: "Claude Desktop", href: "https://claude.ai/desktop", surface: "MCP host" },
  { name: "Crossmint", href: "https://crossmint.com", surface: "Payout rail" },
  { name: "Faremeter", href: "https://faremeter.xyz", surface: "Payment substrate" },
];

export function AdoptersRail() {
  return (
    <section
      id="adopters"
      aria-label="Adopters and integrations"
      className="editions-shell"
      style={{ paddingBlock: "clamp(2.5rem, 4vw, 4rem)" }}
    >
      <div className="flex items-baseline justify-between flex-wrap gap-4 mb-8">
        <span className="stamp-label">Already runs on</span>
        <span className="text-xs text-text-muted">
          MCP-native. Drop-in for every major agent host.
        </span>
      </div>
      <div
        className="grid gap-x-8 gap-y-5"
        style={{
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 12rem), 1fr))",
        }}
      >
        {ADOPTERS.map((a) => (
          <a
            key={a.name}
            href={a.href}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex flex-col gap-1 border-t border-border pt-3 transition-colors hover:border-text-primary"
          >
            <span
              className="font-display tabular-nums text-text-primary group-hover:text-text-primary"
              style={{
                fontSize: "clamp(1.05rem, 1.4vw, 1.35rem)",
                letterSpacing: "-0.018em",
              }}
            >
              {a.name}
            </span>
            <span className="text-xs text-text-muted">{a.surface}</span>
          </a>
        ))}
      </div>
    </section>
  );
}
