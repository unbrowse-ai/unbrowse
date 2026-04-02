"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useTheme } from "@/components/theme-provider";

export function Navbar() {
  const { theme, toggle } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="glass fixed top-0 inset-x-0 z-50 border-b border-border">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5 group">
          <Image
            src="/logo.png"
            alt="unbrowse"
            width={32}
            height={32}
            unoptimized
            className="group-hover:scale-105 transition-transform"
          />
          <span className="font-semibold text-lg tracking-tight">
            unbrowse
          </span>
        </Link>

        <div className="hidden md:flex items-center gap-1">
          <NavLink href="/blog">Blog</NavLink>
          <NavLink href="/papers">Papers</NavLink>
          <NavLink href="/search">Registry</NavLink>
          <NavLink href="/miners">Miners</NavLink>
          <NavLink href="/dashboard">Dashboard</NavLink>
          <a
            href="https://discord.gg/VWugEeFNsG"
            target="_blank"
            rel="noopener"
            className="px-4 py-2 rounded-xl text-sm font-medium text-text-secondary hover:text-orange-500 hover:bg-orange-50 transition-all"
          >
            Discord
          </a>

          <div className="w-px h-5 bg-border mx-3" />

          <a
            href="https://github.com/unbrowse-ai/unbrowse"
            target="_blank"
            rel="noopener"
            className="relative w-10 h-10 rounded-xl flex items-center justify-center hover:bg-orange-50 transition-colors group"
            aria-label="GitHub Repository"
          >
            <svg className="w-[20px] h-[20px] text-text-secondary group-hover:text-orange-500 transition-colors" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
          </a>

          <button
            onClick={toggle}
            className="relative w-10 h-10 rounded-xl flex items-center justify-center hover:bg-orange-50 transition-colors group"
            aria-label="Toggle theme"
          >
            {theme === "light" ? (
              <svg className="w-[18px] h-[18px] text-text-secondary group-hover:text-orange-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            ) : (
              <svg className="w-[18px] h-[18px] text-text-secondary group-hover:text-orange-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            )}
          </button>
        </div>

        <div className="flex md:hidden items-center gap-1">
          <a
            href="https://github.com/unbrowse-ai/unbrowse"
            target="_blank"
            rel="noopener"
            className="relative w-10 h-10 rounded-xl flex items-center justify-center hover:bg-orange-50 transition-colors group"
            aria-label="GitHub Repository"
          >
            <svg className="w-[18px] h-[18px] text-text-secondary group-hover:text-orange-500 transition-colors" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
          </a>
          <button
            onClick={toggle}
            className="relative w-10 h-10 rounded-xl flex items-center justify-center hover:bg-orange-50 transition-colors group"
            aria-label="Toggle theme"
          >
            {theme === "light" ? (
              <svg className="w-[18px] h-[18px] text-text-secondary group-hover:text-orange-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            ) : (
              <svg className="w-[18px] h-[18px] text-text-secondary group-hover:text-orange-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            )}
          </button>
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="relative w-10 h-10 rounded-xl flex items-center justify-center hover:bg-orange-50 transition-colors group"
            aria-label="Toggle menu"
          >
            {mobileOpen ? (
              <svg className="w-5 h-5 text-text-secondary group-hover:text-orange-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-text-secondary group-hover:text-orange-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="md:hidden border-t border-border bg-surface/95 backdrop-blur-lg">
          <div className="px-6 py-4 space-y-1">
            <MobileNavLink href="/blog" onClick={() => setMobileOpen(false)}>Blog</MobileNavLink>
            <MobileNavLink href="/papers" onClick={() => setMobileOpen(false)}>Papers</MobileNavLink>
            <MobileNavLink href="/search" onClick={() => setMobileOpen(false)}>Registry</MobileNavLink>
            <MobileNavLink href="/miners" onClick={() => setMobileOpen(false)}>Miners</MobileNavLink>
            <MobileNavLink href="/dashboard" onClick={() => setMobileOpen(false)}>Dashboard</MobileNavLink>
            <a
              href="https://discord.gg/VWugEeFNsG"
              target="_blank"
              rel="noopener"
              onClick={() => setMobileOpen(false)}
              className="block px-4 py-3 rounded-xl text-base font-medium text-text-secondary
                         hover:text-orange-500 hover:bg-orange-50 transition-all"
            >
              Discord
            </a>
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
      className="px-4 py-2 rounded-xl text-sm font-medium text-text-secondary hover:text-orange-500 hover:bg-orange-50 transition-all"
    >
      {children}
    </Link>
  );
}

function MobileNavLink({ href, onClick, children }: { href: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="block px-4 py-3 rounded-xl text-base font-medium text-text-secondary hover:text-orange-500 hover:bg-orange-50 transition-all"
    >
      {children}
    </Link>
  );
}
