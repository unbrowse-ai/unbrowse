"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button 
      onClick={handleCopy}
      className="ml-4 shrink-0 flex items-center justify-center gap-2 bg-[rgba(255,176,96,0.1)] hover:bg-[rgba(255,176,96,0.2)] text-[rgba(255,250,242,0.95)] px-4 py-2.5 rounded-xl text-sm font-medium transition-colors w-24"
    >
      {copied ? <><Check className="w-4 h-4 text-emerald-400" /> Copied</> : <><Copy className="w-4 h-4" /> Copy</>}
    </button>
  );
}
