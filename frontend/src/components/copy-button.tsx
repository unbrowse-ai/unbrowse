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
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied to clipboard" : "Copy to clipboard"}
      aria-live="polite"
      className="ml-4 shrink-0 flex items-center justify-center gap-2 bg-white/10 hover:bg-white/20 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-colors w-24"
    >
      {copied ? <><Check aria-hidden="true" className="w-4 h-4 text-emerald-400" /> Copied</> : <><Copy aria-hidden="true" className="w-4 h-4" /> Copy</>}
    </button>
  );
}
