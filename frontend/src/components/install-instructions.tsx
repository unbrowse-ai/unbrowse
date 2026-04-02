"use client";

import { useState } from "react";
import { Terminal, Copy, Check } from "lucide-react";

const tabs = [
    {
      id: "claude",
      label: "Claude Code",
      code: `# Full setup in one command
npx unbrowse setup

# Install globally for repeat use
npm install -g unbrowse
unbrowse setup

# Already installed? Upgrade to latest after releases
npm install -g unbrowse@latest
unbrowse setup

# Add the skill for agent workflows
npx skills add unbrowse-ai/unbrowse

# Use it
unbrowse resolve --intent "get events" --url "https://lu.ma"`,
    },
    {
      id: "openclaw",
      label: "OpenClaw",
      code: `# Install the published browser-replacement plugin
npx unbrowse-openclaw install --restart

# Or install globally for repeat use
npm install -g unbrowse-openclaw
unbrowse-openclaw install --restart

# Fallback routing instead of hard browser blocking
unbrowse-openclaw install --mode fallback --restart

# Use a named OpenClaw profile
unbrowse-openclaw install --profile work --restart`,
    },
    {
      id: "cursor",
      label: "Cursor",
      code: `# Full setup in one command
npx unbrowse setup

# Install globally for repeat use
npm install -g unbrowse
unbrowse setup

# Already installed? Upgrade to latest after releases
npm install -g unbrowse@latest
unbrowse setup

# Add the skill in Cursor
npx skills add unbrowse-ai/unbrowse

# Check the install
unbrowse health`,
    },
] as const;

export function InstallInstructions() {
  const [active, setActive] = useState<string>("claude");
  const [copied, setCopied] = useState(false);

  const tab = tabs.find((t) => t.id === active) ?? tabs[0];

  const handleCopy = async () => {
    await navigator.clipboard.writeText(tab.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-2xl border border-border bg-surface overflow-hidden shadow-sm transition-colors">
      {/* Tab bar */}
      <div className="flex items-center justify-between border-b border-border bg-surface-raised pl-2 pr-4">
          <div className="flex overflow-x-auto hide-scrollbar">
            {tabs.map((t) => (
        <button
                  key={t.id}
                  onClick={() => setActive(t.id)}
                  className={`px-4 sm:px-6 py-3.5 text-xs sm:text-sm font-medium whitespace-nowrap transition-all border-b-2 relative top-[1px]
                  ${active === t.id
                    ? "text-orange-600 border-orange-500"
                    : "text-text-muted border-transparent hover:text-text-secondary hover:bg-surface"
                  }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button 
            onClick={handleCopy}
            className="shrink-0 p-2 rounded-lg text-text-muted hover:text-orange-500 hover:bg-orange-50 transition-colors"
            title="Copy code"
          >
            {copied ? <Check className="w-4 h-4 text-orange-500" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>
        {/* Code block */}
        <div className="p-6 relative group bg-surface border-t border-border">
          <div className="absolute top-6 left-6 flex flex-col gap-1.5 opacity-50 select-none">
            {tab.code.split('\n').map((_, i) => (
              <div key={i} className="text-xs font-mono text-border-strong text-right w-4">{i + 1}</div>
            ))}
          </div>
          <pre className="pl-8 text-sm font-mono text-text-primary overflow-x-auto leading-relaxed whitespace-pre-wrap">
            {tab.code.split('\n').map((line, i) => {
              if (line.startsWith('#')) return <div key={i} className="text-text-muted">{line}</div>;
              if (line.startsWith('npx')) return <div key={i} className="text-orange-600 font-medium">{line}</div>;
              if (line.startsWith('export') || line.startsWith('UNBROWSE')) return <div key={i} className="text-orange-500">{line}</div>;
              return <div key={i}>{line}</div>;
            })}
          </pre>
        </div>
    </div>
  );
}
