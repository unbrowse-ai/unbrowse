"use client";

import { useState } from "react";

/**
 * HeroCopyInstall — primary hero CTA.
 *
 * A single prominent copy-to-clipboard button that shows the canonical
 * install command: `npx unbrowse setup`. Replaces the old scroll-to-install
 * button so visitors get the actual command above the fold without scrolling.
 *
 * Design rules applied:
 *   - Only transform + opacity animated (never layout properties)
 *   - 150ms feedback, 250ms state transitions with ease-out
 *   - No gradient text, no glassmorphism, no side-stripe borders
 *   - OKLCH used for color values
 */

const SETUP_CMD = "npx unbrowse setup";

export function HeroCopyInstall() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(SETUP_CMD);
    } catch {
      // Fallback for non-secure contexts
      const el = document.createElement("textarea");
      el.value = SETUP_CMD;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied to clipboard" : "Copy install command: npx unbrowse setup"}
      className="group relative flex items-center gap-3 px-5 py-3 font-mono text-sm
                 text-white active:scale-[0.98]
                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-400
                 focus-visible:outline-offset-2"
      style={{
        background: "oklch(0.62 0.22 45)",
        boxShadow: copied
          ? "0 0 0 0 oklch(0.62 0.22 45 / 0)"
          : "0 0 30px -4px oklch(0.62 0.22 45 / 0.6)",
        transition:
          "background 150ms ease-out, box-shadow 250ms ease-out, transform 150ms ease-out",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background =
          "oklch(0.56 0.22 45)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background =
          "oklch(0.62 0.22 45)";
      }}
    >
      {/* Terminal prompt sigil */}
      <span className="opacity-60 select-none" aria-hidden>
        $
      </span>

      {/* Command text */}
      <span className="tracking-tight">{SETUP_CMD}</span>

      {/* Copy / check indicator */}
      <span className="ml-1 flex items-center gap-1 opacity-80">
        {copied ? (
          <>
            {/* Phosphor Check icon */}
            <svg
              width="13"
              height="13"
              viewBox="0 0 256 256"
              fill="currentColor"
              aria-hidden
            >
              <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
            </svg>
            <span className="text-[10px] uppercase tracking-[0.2em]">Copied</span>
          </>
        ) : (
          <>
            {/* Phosphor Copy icon */}
            <svg
              width="13"
              height="13"
              viewBox="0 0 256 256"
              fill="currentColor"
              aria-hidden
              className="group-hover:opacity-100 opacity-70 transition-opacity duration-150"
            >
              <path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z" />
            </svg>
            <span className="text-[10px] uppercase tracking-[0.2em]">Copy</span>
          </>
        )}
      </span>
    </button>
  );
}
