"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { INSTALL_CMD_OPENCLAW } from "@/lib/install-command";
import { getTokenizedInstallCommand, trackWebEvent } from "@/lib/web-telemetry";

interface Props {
  experimentId?: string;
  variantId?: string;
  primaryLabel?: string;
}

export function HeroCTA({ experimentId, variantId, primaryLabel }: Props) {
  const [copied, setCopied] = useState<string | null>(null);

  // The hero CTA used to surface a secondary "Copy skill" tile pointing at
  // `npx skills add unbrowse-ai/unbrowse`. That skill path was retired in
  // v6.15.0 — the public repo no longer ships a SKILL.md, so the command
  // 404s end-to-end. The host-shortcut step now lives inside the canonical
  // install widget on the same page (InstallInstructions), which shows the
  // real `npx unbrowse setup --mcp` / `claude mcp add unbrowse ...` paths
  // per host. Keeping the hero focused on the one command that works.
  const handleCopy = async (value: string, ctaId: "install_runtime") => {
    const tokenized = await getTokenizedInstallCommand(value, experimentId, variantId);
    await navigator.clipboard.writeText(tokenized.command);
    trackWebEvent("hero_cta_clicked", {
      cta_id: ctaId,
      tokenized: tokenized.tokenized,
    }, { experimentId, variantId });
    trackWebEvent("install_command_copied", {
      tab_id: "hero-primary",
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
      </div>
    </div>
  );
}
