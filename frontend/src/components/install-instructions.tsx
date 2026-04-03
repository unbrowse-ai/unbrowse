"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import {
  INSTALL_CMD_CLAUDE,
  INSTALL_CMD_GENERIC,
  INSTALL_CMD_NPM,
  INSTALL_CMD_SKILL,
  INSTALL_CMD_MCP,
  MCP_CONFIG_JSON,
  MCP_CONFIG_PATH,
  UPGRADE_CMD_CLAUDE,
  UPGRADE_CMD_GENERIC,
  UPGRADE_CMD_MCP,
} from "@/lib/install-command";
import { trackWebEvent } from "@/lib/web-telemetry";
import {
  decorateInstallCommandWithAttribution,
  getInstallAttributionFromDocument,
} from "@/lib/acquisition/install-attribution";

const tabs = [
  {
    id: "cli",
    label: "Cursor / Codex / CLI",
    command: INSTALL_CMD_GENERIC,
    code: `# One-line install
${INSTALL_CMD_GENERIC}

# During first run, set up Crossmint lobster.cash if you want route-mining payouts

# Optional: add the skill after install
${INSTALL_CMD_SKILL}

# Verify
unbrowse health --pretty

# Upgrade after releases
${UPGRADE_CMD_GENERIC}`,
  },
  {
    id: "mcp",
    label: "Any MCP Client",
    command: INSTALL_CMD_MCP,
    code: `${INSTALL_CMD_MCP}

# Installer writes the absolute-path config here
${MCP_CONFIG_PATH}

# Generic template for manual import / paste
${MCP_CONFIG_JSON}

# First run may ask for ToS acceptance, agent identity, and Crossmint lobster.cash setup
# Set up Crossmint if you want route-mining payouts to land in your wallet
unbrowse health

# Already installed?
${UPGRADE_CMD_MCP}`,
  },
  {
    id: "claude",
    label: "Claude Code",
    command: INSTALL_CMD_GENERIC,
    code: `# One-line install
${INSTALL_CMD_GENERIC}

# During first run, set up Crossmint lobster.cash if you want route-mining payouts

# Optional: add the skill in Claude after install
${INSTALL_CMD_SKILL}

# Verify
unbrowse health --pretty

# Upgrade after releases
${UPGRADE_CMD_GENERIC}

# Repo fallback if you want a local checkout
${INSTALL_CMD_CLAUDE}
${UPGRADE_CMD_CLAUDE}`,
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    command: "npx unbrowse-openclaw install --restart",
    code: `# Install the published browser-replacement plugin
npx unbrowse-openclaw install --restart

# The package pulls in the local Unbrowse runtime automatically

# Older OpenClaw builds may ask once to trust the plugin
# Type y and press enter if prompted

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
    command: INSTALL_CMD_GENERIC,
    code: `# One-line install
${INSTALL_CMD_GENERIC}

# Optional: add the skill in Cursor after install
${INSTALL_CMD_SKILL}

# npm-only fallback
${INSTALL_CMD_NPM}

# Upgrade after releases
${UPGRADE_CMD_GENERIC}

# Check the install
unbrowse health --pretty`,
  },
] as const;

export function InstallInstructions() {
  const [active, setActive] = useState<string>("cli");
  const [copied, setCopied] = useState(false);

  const tab = tabs.find((t) => t.id === active) ?? tabs[0];

  const handleCopy = async () => {
    const attribution = getInstallAttributionFromDocument();
    await navigator.clipboard.writeText(decorateInstallCommandWithAttribution(tab.command, attribution));
    trackWebEvent("install_command_copied", {
      tab_id: tab.id,
      install_attribution_attached: Boolean(attribution),
    });
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
