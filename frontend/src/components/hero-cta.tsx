"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { INSTALL_CMD_GENERIC } from "@/lib/install-command";

export function HeroCTA() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(INSTALL_CMD_GENERIC);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="group flex items-center gap-3 px-6 py-3.5 bg-orange-500
                 text-white font-medium rounded-lg text-base
                 shadow-[0_0_24px_rgba(255,109,0,0.3)] hover:shadow-[0_0_32px_rgba(255,109,0,0.5)]
                 transition-all cursor-pointer hover:bg-orange-600 active:scale-[0.98]"
    >
      <code className="text-white/90 font-mono text-sm sm:text-base">git clone ... && ./setup</code>
      <span className="h-4 w-px bg-white/30" />
      {copied ? (
        <span className="flex items-center gap-1 text-xs uppercase tracking-wider text-white/90">
          <Check className="w-3.5 h-3.5" /> Copied
        </span>
      ) : (
        <span className="flex items-center gap-1 text-xs uppercase tracking-wider text-white/70 group-hover:text-white/90 transition-colors">
          <Copy className="w-3.5 h-3.5" /> Copy
        </span>
      )}
    </button>
  );
}
