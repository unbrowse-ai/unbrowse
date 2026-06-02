import Link from "next/link";
import { Github } from "lucide-react";

/**
 * Site footer — unicorn-landing pattern #10.
 *
 * Stripe-style category columns plus a tagline that carries the L2
 * positioning ("infrastructure for the agentic internet") that the
 * hero stays out of for L1 disclosure.
 */

const PRODUCT_LINKS: Array<{ href: string; label: string }> = [
  { href: "/", label: "Overview" },
  { href: "/#install", label: "Install" },
  { href: "/#demo", label: "Demo" },
  { href: "/miners", label: "Miners" },
];

const DEVELOPER_LINKS: Array<{ href: string; label: string }> = [
  { href: "https://github.com/unbrowse-ai/unbrowse", label: "GitHub" },
  { href: "https://www.npmjs.com/package/unbrowse", label: "npm" },
  { href: "/llms.txt", label: "llms.txt" },
  { href: "/.well-known/ai-plugin.json", label: "ai-plugin.json" },
];

const RESOURCES_LINKS: Array<{ href: string; label: string }> = [
  { href: "/internal-apis-are-all-you-need", label: "Whitepaper" },
  { href: "/how-unbrowse-pays", label: "How Unbrowse pays" },
  { href: "/papers", label: "Papers" },
  { href: "/blog", label: "Blog" },
  { href: "/faq", label: "FAQ" },
  { href: "/compare/playwright", label: "vs. Playwright" },
  { href: "/compare/puppeteer", label: "vs. Puppeteer" },
  { href: "/compare/browser-use", label: "vs. browser-use" },
];

const COMPANY_LINKS: Array<{ href: string; label: string }> = [
  { href: "https://discord.gg/VWugEeFNsG", label: "Discord" },
  { href: "https://x.com/getFoundry", label: "X / @getFoundry" },
  { href: "/openclaw-earn", label: "Earn" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
];

function FooterColumn({
  heading,
  links,
}: {
  heading: string;
  links: Array<{ href: string; label: string }>;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.5)]">
        {heading}
      </p>
      <ul className="flex flex-col gap-2">
        {links.map((link) => {
          const external = link.href.startsWith("http") || link.href.endsWith(".txt") || link.href.endsWith(".md") || link.href.endsWith(".json");
          const className =
            "text-sm font-mono text-[rgba(255,176,96,0.7)] hover:text-[rgba(255,176,96,1)] transition-colors";
          return (
            <li key={link.href}>
              {external ? (
                <a href={link.href} target="_blank" rel="noopener" className={className}>
                  {link.label}
                </a>
              ) : (
                <Link href={link.href} className={className}>
                  {link.label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer
      data-global-chrome="site-footer"
      className="relative border-t border-[rgba(255,122,32,0.18)] mt-16 sm:mt-24"
      style={{ background: "rgba(6,4,2,0.92)" }}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
        {/* Tagline + identity row */}
        <div className="flex flex-col gap-3 mb-12">
          <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.45)]">
            ##  Unbrowse
          </p>
          <p className="text-base sm:text-lg font-mono text-[rgba(255,176,96,0.85)] max-w-xl leading-relaxed">
            Infrastructure for the agentic internet.
            <span className="block text-sm text-[rgba(255,176,96,0.55)] mt-1">
              Capture once, replay forever. One agent&apos;s capture is every agent&apos;s speed-up.
            </span>
          </p>
        </div>

        {/* Category columns */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-8 sm:gap-12 mb-12">
          <FooterColumn heading="Product" links={PRODUCT_LINKS} />
          <FooterColumn heading="Developers" links={DEVELOPER_LINKS} />
          <FooterColumn heading="Resources" links={RESOURCES_LINKS} />
          <FooterColumn heading="Company" links={COMPANY_LINKS} />
        </div>

        {/* Bottom row */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pt-6 border-t border-[rgba(255,122,32,0.12)]">
          <div className="flex items-center gap-3 text-[11px] font-mono text-[rgba(255,122,32,0.5)]">
            <span>© {new Date().getFullYear()} Unbrowse AI Pte. Ltd.</span>
            <span className="text-[rgba(255,122,32,0.25)]">·</span>
            <span>Open-source MIT SDKs · runs locally</span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              aria-label="GitHub"
              className="text-[rgba(255,176,96,0.6)] hover:text-[rgba(255,176,96,1)] transition-colors"
            >
              <Github className="w-4 h-4" />
            </a>
            <a
              href="https://x.com/getFoundry"
              target="_blank"
              rel="noopener"
              aria-label="X / Twitter"
              className="text-[11px] font-mono text-[rgba(255,176,96,0.6)] hover:text-[rgba(255,176,96,1)] transition-colors"
            >
              𝕏
            </a>
            <a
              href="https://discord.gg/VWugEeFNsG"
              target="_blank"
              rel="noopener"
              className="text-[11px] font-mono text-[rgba(255,176,96,0.6)] hover:text-[rgba(255,176,96,1)] transition-colors"
            >
              Discord
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
