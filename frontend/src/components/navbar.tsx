"use client";

import Link from "next/link";
import Image from "next/image";
import { useTheme } from "@/components/theme-provider";

export function Navbar() {
  const { theme, toggle } = useTheme();

  return (
    <nav className="glass fixed top-0 inset-x-0 z-50 border-b border-border">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2.5 group">
          <Image
            src="/logo.png"
            alt="unbrowse"
            width={32}
            height={32}
            className="group-hover:scale-105 transition-transform"
          />
          <span className="font-semibold text-lg tracking-tight">
            unbrowse
          </span>
        </Link>

        {/* Nav links */}
        <div className="flex items-center gap-1">
          <NavLink href="/search">Registry</NavLink>

          <div className="w-px h-5 bg-border mx-3" />

          {/* Theme toggle */}
          <button
            onClick={toggle}
            className="relative w-10 h-10 rounded-xl flex items-center justify-center
                       hover:bg-orange-50 transition-colors group"
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
      </div>
    </nav>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="px-4 py-2 rounded-xl text-sm font-medium text-text-secondary
                 hover:text-orange-500 hover:bg-orange-50 transition-all"
    >
      {children}
    </Link>
  );
}
