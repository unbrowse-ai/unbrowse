"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useTheme } from "@/components/theme-provider";
import { useAuth } from "@/lib/auth-context";

/**
 * Navbar — Banger Wave 1 (2026-05-26).
 *
 * Cut from 7 primary items to 5 to honor the unicorn-landing taste
 * surface (Stripe / Coinbase / Linear all render ≤6 primary items).
 *
 *   New: Marketplace (dropdown → Leaderboard + Registry) · Docs ·
 *        Papers · GitHub · Sign in
 *   Dropped from primary: Discord (footer), Blog (footer),
 *        standalone Leaderboard + Registry (inside Marketplace).
 *
 * GitHub now reads as a NAV ITEM (text) rather than an icon button —
 * it deserves a primary slot since the "free, open source" frame is
 * load-bearing. The icon-only version stays on mobile.
 */

export function Navbar() {
  const { theme, toggle } = useTheme();
  const { isAuthenticated } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [marketOpen, setMarketOpen] = useState(false);

  return (
    <nav
      data-global-chrome="navbar"
      // Theme-aware opaque-ish surface, not a translucent black scrim. The nav
      // sits over pages of varying backgrounds (light registry pages AND always-
      // dark archival pages), so its text must contrast with the HEADER's own
      // surface, not whatever shows through. var(--surface-raised) is light in the
      // light theme and dark in the dark theme, so theme-aware nav text reads on
      // every page in both themes (was bg-black/15 → dark text on dark archival
      // pages in light mode was unreadable).
      className="fixed top-0 inset-x-0 z-50 backdrop-blur-md"
      style={{ background: "var(--surface-raised)", borderBottom: "1px solid var(--border)" }}
    >
      <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2.5 group">
          <Image
            src="/logo-optimized.webp"
            alt="unbrowse"
            width={28}
            height={28}
            priority
          />
          <span className="font-semibold text-base tracking-tight text-text-primary">
            unbrowse
          </span>
        </Link>

        {/* Desktop nav links — 5 primary items */}
        <div className="hidden md:flex items-center gap-1">
          {/* Marketplace — hover-dropdown mega menu */}
          <div
            className="relative"
            onMouseEnter={() => setMarketOpen(true)}
            onMouseLeave={() => setMarketOpen(false)}
          >
            <Link
              href="/search"
              className="px-3 py-1.5 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors inline-flex items-center gap-1"
              onFocus={() => setMarketOpen(true)}
              onBlur={() => setMarketOpen(false)}
              aria-haspopup="menu"
              aria-expanded={marketOpen}
            >
              Marketplace
              <svg
                className="w-3 h-3 opacity-60"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </Link>
            {marketOpen && (
              <div
                role="menu"
                aria-label="Marketplace submenu"
                className="absolute left-0 top-full pt-2"
              >
                <div className="min-w-[200px] bg-[#060402]/95 backdrop-blur-md border border-[rgba(255,122,32,0.25)] rounded-sm shadow-xl shadow-black/40 py-1.5">
                  <Link
                    href="/search"
                    className="block px-4 py-2 text-sm font-mono text-[rgba(255,176,96,0.85)] hover:bg-[rgba(255,122,32,0.08)] hover:text-[rgba(255,176,96,1)] transition-colors"
                  >
                    Registry
                    <span className="block text-[10px] text-text-muted mt-0.5">
                      All captured routes
                    </span>
                  </Link>
                  <Link
                    href="/how-unbrowse-pays"
                    className="block px-4 py-2 text-sm font-mono text-[rgba(255,176,96,0.85)] hover:bg-[rgba(255,122,32,0.08)] hover:text-[rgba(255,176,96,1)] transition-colors"
                  >
                    How Unbrowse pays
                    <span className="block text-[10px] text-text-muted mt-0.5">
                      Free discovery, fair payouts
                    </span>
                  </Link>
                </div>
              </div>
            )}
          </div>

          <a
            href="https://docs.unbrowse.ai"
            target="_blank"
            rel="noopener"
            className="px-3 py-1.5 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
          >
            Docs
          </a>
          <NavLink href="/papers">Papers</NavLink>
          <a
            href="https://github.com/unbrowse-ai/unbrowse"
            target="_blank"
            rel="noopener"
            className="px-3 py-1.5 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors inline-flex items-center gap-1.5"
          >
            <svg
              className="w-[14px] h-[14px]"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            GitHub
          </a>
          {isAuthenticated ? (
            <>
              <NavLink href="/dashboard">Dashboard</NavLink>
              <NavLink href="/account">Account</NavLink>
            </>
          ) : (
            <NavLink href="/login">Sign in</NavLink>
          )}

          <div className="w-px h-5 bg-border mx-3" />

          {/* Theme toggle */}
          <button
            onClick={toggle}
            className="w-8 h-8 flex items-center justify-center text-text-muted hover:text-text-primary transition-colors"
            aria-label="Toggle theme"
          >
            {theme === "light" ? (
              <svg
                className="w-[16px] h-[16px]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                />
              </svg>
            ) : (
              <svg
                className="w-[16px] h-[16px]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                />
              </svg>
            )}
          </button>
        </div>

        {/* Mobile: icons + hamburger */}
        <div className="flex md:hidden items-center gap-1">
          <a
            href="https://github.com/unbrowse-ai/unbrowse"
            target="_blank"
            rel="noopener"
            className="w-9 h-9 flex items-center justify-center text-text-muted hover:text-text-primary transition-colors"
            aria-label="GitHub Repository"
          >
            <svg
              className="w-[18px] h-[18px]"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
          </a>
          <button
            onClick={toggle}
            className="w-9 h-9 flex items-center justify-center text-text-muted hover:text-text-primary transition-colors"
            aria-label="Toggle theme"
          >
            {theme === "light" ? (
              <svg
                className="w-[16px] h-[16px]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                />
              </svg>
            ) : (
              <svg
                className="w-[16px] h-[16px]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                />
              </svg>
            )}
          </button>
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="w-9 h-9 flex items-center justify-center text-text-muted hover:text-text-primary transition-colors"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
            aria-controls="navbar-mobile-dropdown"
            type="button"
          >
            {mobileOpen ? (
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            ) : (
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 6h16M4 12h16M4 18h16"
                />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile dropdown — same 5 primary items + utility links */}
      {mobileOpen && (
        <div
          id="navbar-mobile-dropdown"
          role="menu"
          aria-label="Site navigation"
          className="md:hidden border-t border-white/8 bg-black/40 backdrop-blur-md"
        >
          <div className="px-6 py-4 space-y-0.5">
            <MobileNavLink href="/search" onClick={() => setMobileOpen(false)}>
              Marketplace
            </MobileNavLink>
            <MobileNavLink href="/how-unbrowse-pays" onClick={() => setMobileOpen(false)}>
              How Unbrowse pays
            </MobileNavLink>
            <a
              href="https://docs.unbrowse.ai"
              target="_blank"
              rel="noopener"
              onClick={() => setMobileOpen(false)}
              className="block px-3 py-2.5 text-sm font-medium text-text-muted hover:text-text-primary border-l-2 border-transparent hover:border-border transition-colors duration-200"
            >
              Docs
            </a>
            <MobileNavLink href="/papers" onClick={() => setMobileOpen(false)}>
              Papers
            </MobileNavLink>
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              onClick={() => setMobileOpen(false)}
              className="block px-3 py-2.5 text-sm font-medium text-text-muted hover:text-text-primary border-l-2 border-transparent hover:border-border transition-colors duration-200"
            >
              GitHub
            </a>
            {isAuthenticated ? (
              <>
                <MobileNavLink
                  href="/dashboard"
                  onClick={() => setMobileOpen(false)}
                >
                  Dashboard
                </MobileNavLink>
                <MobileNavLink
                  href="/account"
                  onClick={() => setMobileOpen(false)}
                >
                  Account
                </MobileNavLink>
              </>
            ) : (
              <MobileNavLink
                href="/login"
                onClick={() => setMobileOpen(false)}
              >
                Sign in
              </MobileNavLink>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}

function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
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
      className="block px-3 py-2.5 text-sm font-medium text-text-muted hover:text-text-primary border-l-2 border-transparent hover:border-border transition-colors duration-200"
    >
      {children}
    </Link>
  );
}
