"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useTheme } from "@/components/theme-provider";
import { useAuth } from "@/lib/auth-context";

/**
 * Navbar — editions-pattern site header.
 * Sticky top bar, hairline rule under, generous whitespace, light by default.
 * Mirrors shopify.com/editions/winter2026 nav: edition label + primary links + CTA.
 */
export function Navbar() {
  const { theme, toggle } = useTheme();
  const { isAuthenticated } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 8);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav
      className={
        "sticky top-0 inset-x-0 z-50 transition-[border-color,background] duration-200 " +
        (scrolled
          ? "border-b border-border bg-surface/92 backdrop-blur"
          : "border-b border-transparent bg-surface/85 backdrop-blur")
      }
      aria-label="Primary"
    >
      <div className="editions-shell">
        <div className="h-14 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2.5 group">
            <Image
              src="/logo.png"
              alt="Unbrowse"
              width={26}
              height={26}
              unoptimized
              className="rounded-sm"
            />
            <span className="font-display text-base tracking-tight text-text-primary">
              Unbrowse
            </span>
          </Link>

          <div className="hidden md:flex items-center gap-1">
            <NavLink href="/what-is-unbrowse">Product</NavLink>
            <NavLink href="/install">Install</NavLink>
            <NavLink href="/papers">Papers</NavLink>
            <NavLink href="/leaderboard">Marketplace</NavLink>
            <NavLink href="/playground">Playground</NavLink>
            <a
              href="https://docs.unbrowse.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
            >
              Docs
            </a>

            <div className="w-px h-5 bg-border mx-2" />

            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener noreferrer"
              className="w-8 h-8 flex items-center justify-center text-text-secondary hover:text-text-primary transition-colors"
              aria-label="Unbrowse on GitHub"
            >
              <svg className="w-[18px] h-[18px]" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
            </a>

            <button
              type="button"
              onClick={toggle}
              className="w-8 h-8 flex items-center justify-center text-text-secondary hover:text-text-primary transition-colors"
              aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            >
              {theme === "light" ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              )}
            </button>

            {isAuthenticated ? (
              <Link href="/account" className="ml-1 cta-primary text-sm">
                Account
              </Link>
            ) : (
              <Link href="/login" className="ml-1 cta-primary cta-accent text-sm">
                Sign in
              </Link>
            )}
          </div>

          <div className="flex md:hidden items-center gap-1">
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener noreferrer"
              className="w-9 h-9 flex items-center justify-center text-text-secondary hover:text-text-primary transition-colors"
              aria-label="Unbrowse on GitHub"
            >
              <svg className="w-[18px] h-[18px]" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
            </a>
            <button
              type="button"
              onClick={() => setMobileOpen(!mobileOpen)}
              className="w-9 h-9 flex items-center justify-center text-text-secondary hover:text-text-primary transition-colors"
              aria-label={mobileOpen ? "Close menu" : "Open menu"}
              aria-expanded={mobileOpen}
            >
              {mobileOpen ? (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {mobileOpen && (
        <div className="md:hidden border-t border-border bg-surface">
          <div className="editions-shell py-4 space-y-1">
            <MobileNavLink href="/what-is-unbrowse" onClick={() => setMobileOpen(false)}>Product</MobileNavLink>
            <MobileNavLink href="/install" onClick={() => setMobileOpen(false)}>Install</MobileNavLink>
            <MobileNavLink href="/papers" onClick={() => setMobileOpen(false)}>Papers</MobileNavLink>
            <MobileNavLink href="/leaderboard" onClick={() => setMobileOpen(false)}>Marketplace</MobileNavLink>
            <MobileNavLink href="/playground" onClick={() => setMobileOpen(false)}>Playground</MobileNavLink>
            <a
              href="https://docs.unbrowse.ai"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMobileOpen(false)}
              className="block px-3 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary"
            >
              Docs
            </a>
            <a
              href="https://discord.gg/VWugEeFNsG"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMobileOpen(false)}
              className="block px-3 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary"
            >
              Discord
            </a>
            <hr className="hairline my-2" />
            {isAuthenticated ? (
              <MobileNavLink href="/account" onClick={() => setMobileOpen(false)}>Account</MobileNavLink>
            ) : (
              <MobileNavLink href="/login" onClick={() => setMobileOpen(false)}>Sign in</MobileNavLink>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="px-3 py-1.5 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
    >
      {children}
    </Link>
  );
}

function MobileNavLink({
  href,
  onClick,
  children,
}: {
  href: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="block px-3 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary"
    >
      {children}
    </Link>
  );
}
