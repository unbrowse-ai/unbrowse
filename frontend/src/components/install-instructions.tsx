"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

const bootstrapCommand = "npx unbrowse setup";

const tabs = [
  {
    id: "mcp",
    label: "MCP",
    badge: "Recommended",
    note: "Built into the CLI. Best path for Claude Code, Cursor, Cline, Windsurf, and Claude Desktop.",
    code: `# After running npx unbrowse setup
# Claude Code
claude mcp add unbrowse -- unbrowse mcp

# Generic MCP config snippet
{
  "mcpServers": {
    "unbrowse": {
      "command": "unbrowse",
      "args": ["mcp"]
    }
  }
}`,
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    badge: "Hard Default",
    note: "Strict mode blocks the built-in browser and makes Unbrowse the default web path.",
    code: `# After running npx unbrowse setup
# Install the OpenClaw plugin
openclaw plugins install unbrowse-openclaw

# Make Unbrowse the default browser path
openclaw config set plugins.entries.unbrowse-openclaw.enabled true --strict-json
openclaw config set plugins.entries.unbrowse-openclaw.config.routingMode '"strict"' --strict-json
openclaw config set plugins.entries.unbrowse-openclaw.config.preferInBootstrap true --strict-json

# Restart and verify
openclaw gateway restart
openclaw unbrowse-plugin health`,
  },
  {
    id: "eliza",
    label: "ElizaOS",
    badge: "Default First",
    note: "Routes web work to Unbrowse first. Remove the browser plugin if you want a full replacement.",
    code: `# After running npx unbrowse setup
# In your Eliza project
npm install @unbrowse/plugin-elizaos

# Add to your character config
{
  "plugins": [
    "@elizaos/plugin-openai",
    "@unbrowse/plugin-elizaos"
  ]
}

# Optional: remove @elizaos/plugin-browser for full replacement
npx elizaos start --character characters/my-agent.json`,
  },
  {
    id: "hermes",
    label: "Hermes",
    badge: "Default First",
    note: "Auto-registers through the Hermes plugin entry point and teaches the agent to use Unbrowse first.",
    code: `# After running npx unbrowse setup
# Install the Hermes plugin
pip install unbrowse-hermes

# Start Hermes, then verify the tool is loaded
/tools

# You should see:
# unbrowse -> resolve, search, execute, login, skills, skill, health`,
  },
  {
    id: "langchain",
    label: "LangChain",
    badge: "Toolkit",
    note: "Drop-in toolkit for agents that already choose tools through LangChain or LangGraph.",
    code: `# After running npx unbrowse setup
pip install unbrowse-langchain

from unbrowse_langchain import create_unbrowse_toolkit

tools = create_unbrowse_toolkit()

# Tools exposed:
# unbrowse_resolve
# unbrowse_search
# unbrowse_execute`,
  },
  {
    id: "vercel",
    label: "Vercel AI SDK",
    badge: "Toolkit",
    note: "Single-tool install for generateText, streamText, route handlers, and chat surfaces.",
    code: `# After running npx unbrowse setup
npm install @unbrowse/vercel-ai-sdk ai zod

import { generateText } from "ai";
import { createUnbrowseTools } from "@unbrowse/vercel-ai-sdk";

const tools = createUnbrowseTools();

// Then let the model call:
// tools.unbrowse`,
  },
] as const;

export function InstallInstructions() {
  const [active, setActive] = useState<(typeof tabs)[number]["id"]>("mcp");
  const [copied, setCopied] = useState(false);
  const [copiedBootstrap, setCopiedBootstrap] = useState(false);

  const tab = tabs.find((entry) => entry.id === active) ?? tabs[0];

  const handleCopy = async () => {
    await navigator.clipboard.writeText(tab.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleBootstrapCopy = async () => {
    await navigator.clipboard.writeText(bootstrapCommand);
    setCopiedBootstrap(true);
    setTimeout(() => setCopiedBootstrap(false), 2000);
  };

  return (
    <div className="rounded-2xl border border-border bg-surface overflow-hidden shadow-sm transition-colors">
      <div className="border-b border-border bg-surface-raised px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-mono font-medium uppercase tracking-[0.2em] text-orange-600">
              Verified Install Paths
            </p>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-secondary">
              Start with one command. It installs the browser runtime, starts the local service, auto-registers your agent, and caches the API key. Then pick your host-specific hookup below.
            </p>
          </div>
          <button
            onClick={handleCopy}
            className="shrink-0 self-start rounded-lg p-2 text-text-muted transition-colors hover:bg-orange-50 hover:text-orange-500"
            title="Copy code"
          >
            {copied ? <Check className="h-4 w-4 text-orange-500" /> : <Copy className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <div className="border-b border-border bg-surface px-4 py-5 sm:px-5">
        <div className="rounded-2xl border border-orange-500/20 bg-orange-50/70 p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-mono font-medium uppercase tracking-[0.18em] text-orange-700">
                Step 1
              </p>
              <p className="mt-2 text-sm leading-relaxed text-orange-950">
                Run this once on the machine. No separate API-key form. No manual registration step.
              </p>
            </div>
            <button
              onClick={handleBootstrapCopy}
              className="shrink-0 self-start rounded-lg p-2 text-orange-700 transition-colors hover:bg-orange-100 hover:text-orange-900"
              title="Copy bootstrap command"
            >
              {copiedBootstrap ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
          <pre className="mt-4 overflow-x-auto rounded-xl border border-orange-500/15 bg-surface px-4 py-3 font-mono text-sm font-medium leading-relaxed text-orange-600">
            {bootstrapCommand}
          </pre>
        </div>
      </div>

      <div className="border-b border-border bg-surface px-2 sm:px-3">
        <div className="flex overflow-x-auto hide-scrollbar">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setActive(entry.id)}
              className={`relative top-[1px] flex flex-col gap-1 border-b-2 px-4 py-3 text-left text-xs transition-all sm:px-5 sm:text-sm ${
                active === entry.id
                  ? "border-orange-500 text-orange-600"
                  : "border-transparent text-text-muted hover:bg-surface-raised hover:text-text-secondary"
              }`}
            >
              <span className="font-medium whitespace-nowrap">{entry.label}</span>
              <span className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
                {entry.badge}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="border-b border-border bg-orange-50/70 px-4 py-3 sm:px-5">
        <p className="text-sm leading-relaxed text-orange-950">
          <span className="font-medium">Step 2:</span> {tab.note}
        </p>
      </div>

      <div className="relative bg-surface px-4 py-5 sm:px-6">
        <div className="absolute left-4 top-5 flex select-none flex-col gap-1.5 opacity-50 sm:left-6">
          {tab.code.split("\n").map((_, index) => (
            <div key={index} className="w-4 text-right font-mono text-xs text-border-strong">
              {index + 1}
            </div>
          ))}
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap pl-8 font-mono text-sm leading-relaxed text-text-primary">
          {tab.code.split("\n").map((line, index) => {
            if (line.startsWith("#")) return <div key={index} className="text-text-muted">{line}</div>;
            if (line.startsWith("npm") || line.startsWith("npx") || line.startsWith("pip") || line.startsWith("openclaw") || line.startsWith("claude")) {
              return <div key={index} className="font-medium text-orange-600">{line}</div>;
            }
            if (line.startsWith("import ") || line.startsWith("from ")) {
              return <div key={index} className="text-orange-500">{line}</div>;
            }
            return <div key={index}>{line}</div>;
          })}
        </pre>
      </div>
    </div>
  );
}
