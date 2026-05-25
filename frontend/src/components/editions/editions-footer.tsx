import Link from "next/link";

/**
 * EditionsFooter — minimal editions footer. Three columns of links
 * + edition label + copyright. Replaces the legacy SiteFooter when
 * a page is rendered in editions chapter mode.
 */
export function EditionsFooter() {
  return (
    <footer className="border-t border-border bg-surface mt-0">
      <div className="editions-shell py-12 md:py-16">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-12">
          <div>
            <div className="stamp-label mb-3">Product</div>
            <ul className="space-y-2 text-sm">
              <li><Link href="/install" className="text-text-secondary hover:text-text-primary">Install</Link></li>
              <li><Link href="/playground" className="text-text-secondary hover:text-text-primary">Playground</Link></li>
              <li><Link href="/docs" className="text-text-secondary hover:text-text-primary">Docs</Link></li>
              <li><Link href="/papers" className="text-text-secondary hover:text-text-primary">Papers</Link></li>
              <li><Link href="/benchmark-deep-dive" className="text-text-secondary hover:text-text-primary">Benchmarks</Link></li>
            </ul>
          </div>
          <div>
            <div className="stamp-label mb-3">Use</div>
            <ul className="space-y-2 text-sm">
              <li><Link href="/what-is-unbrowse" className="text-text-secondary hover:text-text-primary">What is Unbrowse</Link></li>
              <li><Link href="/personal-agents" className="text-text-secondary hover:text-text-primary">Personal agents</Link></li>
              <li><Link href="/agent-fleet-economics" className="text-text-secondary hover:text-text-primary">Agent fleets</Link></li>
              <li><Link href="/mine-the-internet" className="text-text-secondary hover:text-text-primary">Mine the internet</Link></li>
              <li><Link href="/openclaw-earn" className="text-text-secondary hover:text-text-primary">Earn</Link></li>
            </ul>
          </div>
          <div>
            <div className="stamp-label mb-3">Account</div>
            <ul className="space-y-2 text-sm">
              <li><Link href="/login" className="text-text-secondary hover:text-text-primary">Sign in</Link></li>
              <li><Link href="/account" className="text-text-secondary hover:text-text-primary">Dashboard</Link></li>
              <li><Link href="/billing" className="text-text-secondary hover:text-text-primary">Billing</Link></li>
              <li><Link href="/leaderboard" className="text-text-secondary hover:text-text-primary">Leaderboard</Link></li>
            </ul>
          </div>
          <div>
            <div className="stamp-label mb-3">Company</div>
            <ul className="space-y-2 text-sm">
              <li><Link href="/about" className="text-text-secondary hover:text-text-primary">About</Link></li>
              <li><Link href="/security" className="text-text-secondary hover:text-text-primary">Security</Link></li>
              <li><Link href="/privacy" className="text-text-secondary hover:text-text-primary">Privacy</Link></li>
              <li><Link href="/terms" className="text-text-secondary hover:text-text-primary">Terms</Link></li>
              <li><Link href="/contact" className="text-text-secondary hover:text-text-primary">Contact</Link></li>
            </ul>
          </div>
        </div>
        <hr className="hairline my-10" />
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-text-muted">
          <div className="font-display text-sm text-text-primary tracking-tight">
            Unbrowse
          </div>
          <div>&copy; {new Date().getFullYear()} Unbrowse AI Pte. Ltd. One MCP for any website.</div>
        </div>
      </div>
    </footer>
  );
}
