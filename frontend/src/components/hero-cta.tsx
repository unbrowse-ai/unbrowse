"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { INSTALL_CMD_OPENCLAW, INSTALL_CMD_SKILL } from "@/lib/install-command";
import { getTokenizedInstallCommand, trackWebEvent } from "@/lib/web-telemetry";

interface Props {
  experimentId?: string;
  variantId?: string;
  primaryLabel?: string;
}

export function HeroCTA({ experimentId, variantId, primaryLabel }: Props) {
  const [copied, setCopied] = useState<string | null>(null);

  const handleCopy = async (value: string, ctaId: "install_runtime" | "host_shortcut") => {
    const tokenized = ctaId === "install_runtime"
      ? await getTokenizedInstallCommand(value, experimentId, variantId)
      : { command: value, tokenized: false };
    await navigator.clipboard.writeText(tokenized.command);
    trackWebEvent("hero_cta_clicked", {
      cta_id: ctaId,
      tokenized: tokenized.tokenized,
    }, { experimentId, variantId });
    trackWebEvent("install_command_copied", {
      tab_id: ctaId === "install_runtime" ? "hero-primary" : "hero-skill-shortcut",
      tokenized: tokenized.tokenized,
    }, { experimentId, variantId });
    setCopied(value);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="w-full max-w-3xl rounded-2xl border border-border bg-surface/90 p-3 shadow-sm">
      <div className="grid gap-3">
        <button
          onClick={() => handleCopy(INSTALL_CMD_OPENCLAW, "install_runtime")}
          className="group rounded-xl border border-orange-500/25 bg-orange-50 px-4 py-4 text-left transition-colors hover:border-orange-500/45 hover:bg-orange-100/70 active:scale-[0.99]"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-mono uppercase tracking-[0.22em] text-orange-700">
                {primaryLabel ?? "Make It Your Native Browser"}
              </p>
              <p className="mt-1 text-sm text-text-secondary">
                One command. Replaces the default browser in your agent.
              </p>
            </div>
            {copied === INSTALL_CMD_OPENCLAW ? (
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
            {INSTALL_CMD_OPENCLAW}
          </code>
        </button>

        <div className="rounded-xl border border-border bg-surface-raised px-4 py-3.5 text-left">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[11px] font-mono uppercase tracking-[0.22em] text-text-muted">
                Optional Host Shortcut
              </p>
              <p className="mt-1 text-sm text-text-secondary">
                After install. Adds slash-command or host discovery in skill-aware tools.
              </p>
            </div>
            <button
              onClick={() => handleCopy(INSTALL_CMD_SKILL, "host_shortcut")}
              className="inline-flex shrink-0 items-center gap-1 self-start rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium uppercase tracking-wider text-text-muted transition-colors hover:border-orange-500/30 hover:text-orange-600"
            >
              {copied === INSTALL_CMD_SKILL ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied === INSTALL_CMD_SKILL ? "Copied" : "Copy skill"}
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
