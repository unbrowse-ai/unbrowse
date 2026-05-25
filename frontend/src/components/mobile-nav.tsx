'use client';

import { useState } from 'react';
import Link from 'next/link';

export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Burger button — fixed top-right, mobile only */}
      <button
        onClick={() => setOpen(o => !o)}
        className="sm:hidden fixed top-3 right-4 z-50 flex flex-col justify-center items-center w-9 h-9 gap-1.5 cursor-pointer"
        aria-label="Menu"
        style={{ background: 'rgba(6,4,2,0.85)', border: '1px solid rgba(255,122,32,0.3)', borderRadius: '2px' }}
      >
        <span className="block w-4 h-px transition-all duration-200"
          style={{ background: open ? 'rgba(255,176,96,0.9)' : 'rgba(255,122,32,0.7)',
            transform: open ? 'translateY(5px) rotate(45deg)' : 'none' }} />
        <span className="block w-4 h-px transition-all duration-200"
          style={{ background: open ? 'transparent' : 'rgba(255,122,32,0.7)', opacity: open ? 0 : 1 }} />
        <span className="block w-4 h-px transition-all duration-200"
          style={{ background: open ? 'rgba(255,176,96,0.9)' : 'rgba(255,122,32,0.7)',
            transform: open ? 'translateY(-5px) rotate(-45deg)' : 'none' }} />
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className="sm:hidden fixed top-14 right-4 z-50 flex flex-col font-mono text-xs"
          style={{ background: 'rgba(6,4,2,0.96)', border: '1px solid rgba(255,122,32,0.28)', borderRadius: '2px', minWidth: '140px' }}
        >
          <a href="https://github.com/unbrowse-ai/unbrowse" target="_blank" rel="noopener"
            onClick={() => setOpen(false)}
            className="px-5 py-3 text-text-secondary hover:bg-orange-50 transition-colors border-b border-border">
            GitHub
          </a>
          <a href="https://discord.gg/VWugEeFNsG" target="_blank" rel="noopener"
            onClick={() => setOpen(false)}
            className="px-5 py-3 text-text-secondary hover:bg-orange-50 transition-colors border-b border-border">
            Discord
          </a>
          <Link href="/faq" onClick={() => setOpen(false)}
            className="px-5 py-3 text-text-secondary hover:bg-orange-50 transition-colors">
            FAQ
          </Link>
        </div>
      )}

      {/* Backdrop to close menu */}
      {open && (
        <div className="sm:hidden fixed inset-0 z-40" onClick={() => setOpen(false)} />
      )}
    </>
  );
}
