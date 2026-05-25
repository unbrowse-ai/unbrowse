import Link from "next/link";
import { Github } from "lucide-react";

/**
 * Site footer — editions chapter pattern.
 *
 * Four category columns over an editorial tagline, hairline base row.
 * Light cream surface, ink type, no orange dots, no #060402 panel.
 */

const PRODUCT_LINKS: Array<{ href: string; label: string }> = [
  { href: "/", label: "Overview" },
  { href: "/install", label: "Install" },
  { href: "/playground", label: "Playground" },
  { href: "/leaderboard", label: "Marketplace" },
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
];

const COMPANY_LINKS: Array<{ href: string; label: string }> = [
  { href: "https://discord.gg/VWugEeFNsG", label: "Discord" },
  { href: "https://x.com/unbrowse", label: "X / @unbrowse" },
  { href: "/openclaw-earn", label: "Earn" },
  { href: "/claim", label: "Claim a domain" },
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
      <p className="stamp-label">{heading}</p>
      <ul className="flex flex-col gap-2">
        {links.map((link) => {
          const external =
            link.href.startsWith("http") ||
            link.href.endsWith(".txt") ||
            link.href.endsWith(".md") ||
            link.href.endsWith(".json");
          const className =
            "text-sm text-text-secondary hover:text-text-primary transition-colors";
          return (
            <li key={link.href}>
              {external ? (
                <a href={link.href} target="_blank" rel="noopener noreferrer" className={className}>
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
    <footer className="border-t border-border bg-surface mt-20">
      <div className="editions-shell py-14 sm:py-20">
        <div className="flex flex-col gap-3 mb-12">
          <p className="stamp-label">Unbrowse</p>
          <p
            className="font-display text-text-primary max-w-2xl"
            style={{ fontSize: "clamp(1.5rem, 2.4vw, 2rem)", letterSpacing: "-0.022em", lineHeight: 1.15 }}
          >
            Infrastructure for the agentic internet.
          </p>
          <p className="text-text-secondary text-sm sm:text-base max-w-xl">
            Capture once, replay forever. One agent&apos;s capture is every agent&apos;s speed-up.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 sm:gap-12 mb-12">
          <FooterColumn heading="Product" links={PRODUCT_LINKS} />
          <FooterColumn heading="Developers" links={DEVELOPER_LINKS} />
          <FooterColumn heading="Resources" links={RESOURCES_LINKS} />
          <FooterColumn heading="Company" links={COMPANY_LINKS} />
        </div>

        <hr className="hairline" />
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pt-6 text-xs text-text-muted">
          <div className="flex items-center gap-3">
            <span>© {new Date().getFullYear()} Unbrowse AI Pte. Ltd.</span>
            <span>·</span>
            <span>Free, open source, AGPL-3.0</span>
          </div>
          <div className="flex items-center gap-5">
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Unbrowse on GitHub"
              className="text-text-secondary hover:text-text-primary transition-colors"
            >
              <Github className="w-4 h-4" aria-hidden />
            </a>
            <a
              href="https://x.com/unbrowse"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Unbrowse on X"
              className="text-text-secondary hover:text-text-primary transition-colors"
            >
              𝕏
            </a>
            <a
              href="https://discord.gg/VWugEeFNsG"
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-secondary hover:text-text-primary transition-colors"
            >
              Discord
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
