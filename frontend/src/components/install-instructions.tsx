"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import {
  INSTALL_CMD_CLAUDE,
  INSTALL_CMD_GENERIC,
  UPGRADE_CMD_CLAUDE,
  UPGRADE_CMD_GENERIC,
} from "@/lib/install-command";
import { trackWebEvent } from "@/lib/web-telemetry";

const tabs = [
  {
    id: "cli",
    label: "CLI / Cursor / Codex",
    command: INSTALL_CMD_GENERIC,
    code: `${INSTALL_CMD_GENERIC}

# First run may ask for ToS acceptance and agent identity
unbrowse health

# Already installed?
${UPGRADE_CMD_GENERIC}`,
  },
  {
    id: "claude",
    label: "Claude Code",
    command: INSTALL_CMD_CLAUDE,
    code: `${INSTALL_CMD_CLAUDE}

# First run may ask for ToS acceptance and agent identity
unbrowse health

# Already installed?
${UPGRADE_CMD_CLAUDE}`,
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    command: "npx unbrowse-openclaw install --restart",
    code: `npx unbrowse-openclaw install --restart

# Pulls in the local Unbrowse runtime automatically
# Older OpenClaw builds may ask once to trust the plugin

# Already installed?
unbrowse-openclaw install --restart`,
  },
] as const;

export function InstallInstructions() {
  const [active, setActive] = useState<string>("cli");
  const [copied, setCopied] = useState(false);

  const tab = tabs.find((t) => t.id === active) ?? tabs[0];

  const handleCopy = async () => {
    await navigator.clipboard.writeText(tab.command);
    trackWebEvent("install_command_copied", { tab_id: tab.id });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-2xl border border-border bg-surface overflow-hidden shadow-sm transition-colors">
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
          title="Copy command"
        >
          {copied ? <Check className="w-4 h-4 text-orange-500" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <div className="p-6 relative group bg-surface border-t border-border">
        <div className="absolute top-6 left-6 flex flex-col gap-1.5 opacity-50 select-none">
          {tab.code.split("\n").map((_, i) => (
            <div key={i} className="text-xs font-mono text-border-strong text-right w-4">{i + 1}</div>
          ))}
        </div>
        <pre className="pl-8 text-sm font-mono text-text-primary overflow-x-auto leading-relaxed whitespace-pre-wrap">
          {tab.code.split("\n").map((line, i) => {
            if (line.startsWith("#")) return <div key={i} className="text-text-muted">{line}</div>;
            if (
              line.startsWith("git clone") ||
              line.startsWith("cd ") ||
              line.startsWith("./setup") ||
              line.startsWith("npx") ||
              line.startsWith("unbrowse")
            ) return <div key={i} className="text-orange-600 font-medium">{line}</div>;
            if (line.startsWith("export") || line.startsWith("UNBROWSE")) return <div key={i} className="text-orange-500">{line}</div>;
            return <div key={i}>{line}</div>;
          })}
        </pre>
      </div>
    </div>
  );
}
