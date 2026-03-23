"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

type InstallOption = {
  id: string;
  label: string;
  summary: string;
  code: string;
  badge?: string;
};

const installOptions: InstallOption[] = [
  {
    id: "one-shot",
    label: "One-shot",
    badge: "Recommended",
    summary: "Installs the local runtime and wires detected hosts automatically.",
    code: `curl -fsSL https://www.unbrowse.ai/install.sh | bash`,
  },
  {
    id: "skill",
    label: "Skill",
    summary: "Best for skill-compatible agents. Add the shared skill first.",
    code: `npx skills add unbrowse-ai/unbrowse`,
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    summary: "Full OpenClaw wiring via the hosted installer. Native plugin replaces browser-first routing inside OpenClaw.",
    code: `curl -fsSL https://www.unbrowse.ai/install.sh | bash -s -- --openclaw --no-cli`,
  },
  {
    id: "manual",
    label: "Manual",
    summary: "CLI-only fallback when you do not want auto-detect.",
    code: `npm install -g unbrowse`,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    summary: "Explicit Claude Code wiring via the hosted installer.",
    code: `curl -fsSL https://www.unbrowse.ai/install.sh | bash -s -- --claude-code --no-cli`,
  },
  {
    id: "cursor",
    label: "Cursor",
    summary: "Explicit Cursor MCP wiring via the hosted installer.",
    code: `curl -fsSL https://www.unbrowse.ai/install.sh | bash -s -- --cursor --no-cli`,
  },
  {
    id: "windsurf",
    label: "Windsurf",
    summary: "Explicit Windsurf MCP wiring via the hosted installer.",
    code: `curl -fsSL https://www.unbrowse.ai/install.sh | bash -s -- --windsurf --no-cli`,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    summary: "Explicit Claude Desktop config wiring via the hosted installer.",
    code: `curl -fsSL https://www.unbrowse.ai/install.sh | bash -s -- --claude-desktop --no-cli`,
  },
  {
    id: "codex",
    label: "Codex",
    summary: "Explicit Codex MCP wiring via the hosted installer.",
    code: `curl -fsSL https://www.unbrowse.ai/install.sh | bash -s -- --codex --no-cli`,
  },
];

export function InstallInstructions() {
  const [active, setActive] = useState<string>("one-shot");
  const [copied, setCopied] = useState(false);
  const selected = installOptions.find((option) => option.id === active) ?? installOptions[0];

  const handleCopy = async () => {
    await navigator.clipboard.writeText(selected.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="overflow-hidden rounded-[28px] border border-border-strong bg-surface-raised shadow-[0_20px_60px_rgba(0,0,0,0.22)]">
      <div className="border-b border-border-strong bg-[linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0))] px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-3">
          <div className="overflow-x-auto scrollbar-hide">
            <div className="flex min-w-max gap-2 pr-2">
              {installOptions.map((option) => {
                const isActive = option.id === active;

                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setActive(option.id)}
                    className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium whitespace-nowrap transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/60 ${
                      isActive
                        ? "border-orange-500 bg-orange-500 text-white shadow-[0_0_0_1px_rgba(255,109,0,0.2)]"
                        : "border-border-strong bg-surface-sunken text-text-primary hover:border-orange-500/40 hover:text-white"
                    }`}
                  >
                    <span>{option.label}</span>
                    {option.badge ? (
                      <span className="rounded-full bg-white/95 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-orange-700">
                        {option.badge}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <p className="max-w-3xl text-base leading-relaxed text-text-primary">
            {selected.summary}
          </p>
        </div>
      </div>

      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4 rounded-2xl border border-border-strong bg-[#0b0907] px-5 py-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-orange-500">Install path</span>
              <span className="rounded-full border border-border-strong bg-surface-raised px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-primary">
                {selected.label}
              </span>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-base leading-relaxed text-white sm:text-lg">
              <span className="text-orange-500">$ </span>
              {selected.code}
            </pre>
          </div>

          <button
            type="button"
            onClick={handleCopy}
            aria-label="Copy install command"
            title="Copy install command"
            className="inline-flex min-h-12 min-w-12 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-orange-500/30 bg-orange-500/12 text-orange-500 transition-colors hover:border-orange-500/60 hover:bg-orange-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/60"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </button>
        </div>

        <div className="mt-5 flex flex-col gap-4 rounded-2xl border border-border-strong bg-surface-sunken px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-base font-semibold text-text-primary">Already installed?</p>
            <p className="mt-1 text-sm leading-relaxed text-text-primary">
              Upgrade in place. Hermes, ElizaOS, and generic MCP setup docs stay in the docs because they include native browser-replacement wiring, not just package install.
            </p>
          </div>

          <div className="flex flex-col items-stretch gap-3 sm:items-end">
            <code className="rounded-xl border border-border-strong bg-[#0b0907] px-3 py-2 font-mono text-sm leading-relaxed text-white">
              curl -fsSL https://www.unbrowse.ai/install.sh | bash -s -- --upgrade-cli
            </code>
            <a
              href="/skill.md"
              className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-xl border border-border-strong bg-surface px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:border-orange-500/40 hover:text-white"
            >
              Open setup docs
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
