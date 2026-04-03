"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { INSTALL_CMD_GENERIC, INSTALL_CMD_SKILL } from "@/lib/install-command";

export function HeroCTA() {
  const [copied, setCopied] = useState<string | null>(null);

  const handleCopy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(value);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="w-full max-w-3xl rounded-2xl border border-border bg-surface/90 p-3 shadow-sm backdrop-blur">
      <div className="grid gap-3">
        <button
          onClick={() => handleCopy(INSTALL_CMD_GENERIC)}
          className="group rounded-xl border border-orange-500/25 bg-orange-50 px-4 py-4 text-left transition-colors hover:border-orange-500/45 hover:bg-orange-100/70 active:scale-[0.99]"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-mono uppercase tracking-[0.22em] text-orange-700">
                Install Unbrowse
              </p>
              <p className="mt-1 text-sm text-text-secondary">
                Full runtime. CLI + skill + setup.
              </p>
            </div>
            {copied === INSTALL_CMD_GENERIC ? (
              <span className="flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-orange-700">
                <Check className="w-3.5 h-3.5" /> Copied
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-orange-600">
                <Copy className="w-3.5 h-3.5" /> Copy
              </span>
            )}
          </div>
          <code className="mt-3 block overflow-x-auto whitespace-nowrap font-mono text-xs text-orange-700 sm:text-sm">
            {INSTALL_CMD_GENERIC}
          </code>
        </button>

        <div className="rounded-xl border border-border bg-surface-raised px-4 py-4 text-left">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-mono uppercase tracking-[0.22em] text-text-muted">
                Optional Skill Shortcut
              </p>
              <p className="mt-1 text-sm text-text-secondary">
                After install. Adds slash-command or host discovery where skills are supported.
              </p>
            </div>
            <button
              onClick={() => handleCopy(INSTALL_CMD_SKILL)}
              className="shrink-0 flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-text-muted hover:text-orange-600 transition-colors"
            >
              {copied === INSTALL_CMD_SKILL ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied === INSTALL_CMD_SKILL ? "Copied" : "Copy"}
            </button>
          </div>
          <code className="mt-3 block overflow-x-auto whitespace-nowrap font-mono text-xs text-text-primary sm:text-sm">
            {INSTALL_CMD_SKILL}
          </code>
        </div>
      </div>
    </div>
  );
}
