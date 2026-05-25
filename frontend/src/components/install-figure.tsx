'use client';

import { useState } from 'react';
import Image from 'next/image';

export function InstallFigure() {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText('npm install -g unbrowse@latest && unbrowse setup');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="max-sm:relative max-sm:w-full max-sm:flex max-sm:flex-col max-sm:items-center max-sm:pt-6 sm:absolute sm:bottom-0 sm:-right-24 sm:translate-y-[40%] sm:w-[340px] sm:w-[460px] z-20 flex flex-col">

      {/* Already installed box — above the drawing */}
      <div
        className="relative max-sm:self-center sm:self-end rounded-sm text-xs font-mono leading-relaxed z-10"
        style={{ background: 'rgba(6,4,2,0.92)', border: '1px solid rgba(255,122,32,0.28)' }}
      >
        {/* Header row: label + copy button */}
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <span className="text-orange-500">##  already installed?</span>
          <button
            onClick={copy}
            title="Copy command"
            className="ml-3 flex-shrink-0 p-1 rounded-sm transition-colors cursor-pointer"
            style={{
              color: copied ? 'rgba(255,176,96,0.95)' : 'rgba(255,122,32,0.5)',
              border: '1px solid rgba(255,122,32,0.25)',
              background: 'rgba(255,122,32,0.06)',
            }}
          >
            {copied ? (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <path d="M1.5 6L4.5 9L10.5 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect x="4" y="1" width="7" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1"/>
                <rect x="1" y="3" width="7" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1"/>
              </svg>
            )}
          </button>
        </div>
        <div className="px-4 pb-3 text-text-muted">
          <code className="text-text-secondary">npm install -g unbrowse@latest</code>
          <span className="mx-1.5 opacity-50">&&</span>
          <code className="text-text-secondary">unbrowse setup</code>
        </div>
      </div>

      {/* Drawing — behind the already installed box */}
      <div className="relative pointer-events-none select-none" style={{ mixBlendMode: 'multiply' }}>
        <div style={{ filter: 'url(#crt-hand)' }}>
          <Image
            src="/images/saint-eagle.png"
            alt=""
            width={460}
            height={520}
            className="w-full h-auto object-contain"
            style={{ opacity: 1 }}
          />
        </div>
      </div>
    </div>
  );
}
