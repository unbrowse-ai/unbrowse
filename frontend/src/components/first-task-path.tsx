"use client";

import { useState } from "react";
import { Check, Copy, ArrowRight } from "lucide-react";
import { FIRST_TASK_CMD, VERIFY_CMD } from "@/lib/install-command";
import { trackWebEvent } from "@/lib/web-telemetry";

type CommandId = "verify" | "first_resolve";

const commands: Array<{
  id: CommandId;
  eyebrow: string;
  title: string;
  body: string;
  command: string;
}> = [
  {
    id: "verify",
    eyebrow: "Step 1",
    title: "Check the local runtime",
    body: "Confirms the local server is up before you try a real task.",
    command: VERIFY_CMD,
  },
  {
    id: "first_resolve",
    eyebrow: "Step 2",
    title: "Run one real resolve",
    body: "Canonical quickstart. If this returns data or endpoints, the product is live.",
    command: FIRST_TASK_CMD,
  },
];

export function FirstTaskPath() {
  const [copied, setCopied] = useState<CommandId | null>(null);
  const verifyStep = commands[0]!;
  const firstResolveStep = commands[1]!;

  const handleCopy = async (id: CommandId, command: string) => {
    await navigator.clipboard.writeText(command);
    if (id === "first_resolve") {
      trackWebEvent("first_task_command_copied", { command_id: id });
    } else {
      trackWebEvent("verify_command_copied", { command_id: id });
    }
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-stretch">
        <div className="rounded-2xl border border-border bg-surface px-5 py-5 shadow-sm">
          <p className="text-[11px] font-mono uppercase tracking-[0.22em] text-orange-600">{verifyStep.eyebrow}</p>
          <h3 className="mt-2 text-lg font-semibold tracking-tight text-text-primary">{verifyStep.title}</h3>
          <p className="mt-2 text-sm leading-6 text-text-secondary">{verifyStep.body}</p>
          <div className="mt-4 rounded-xl border border-orange-500/15 bg-orange-50/60 p-3">
            <code className="block overflow-x-auto whitespace-nowrap font-mono text-xs text-orange-700 sm:text-sm">
              {verifyStep.command}
            </code>
          </div>
          <button
            onClick={() => handleCopy(verifyStep.id, verifyStep.command)}
            className="mt-4 inline-flex items-center gap-2 rounded-xl border border-orange-500/25 bg-white px-3.5 py-2.5 text-xs font-medium uppercase tracking-wider text-orange-700 transition-colors hover:border-orange-500/45 hover:bg-orange-50"
          >
            {copied === verifyStep.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied === verifyStep.id ? "Copied" : "Copy command"}
          </button>
        </div>

        <div className="hidden items-center justify-center lg:flex">
          <div className="flex h-12 w-12 items-center justify-center rounded-full border border-orange-500/20 bg-orange-50 text-orange-600">
            <ArrowRight className="h-4 w-4" />
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-surface px-5 py-5 shadow-sm">
          <p className="text-[11px] font-mono uppercase tracking-[0.22em] text-orange-600">{firstResolveStep.eyebrow}</p>
          <h3 className="mt-2 text-lg font-semibold tracking-tight text-text-primary">{firstResolveStep.title}</h3>
          <p className="mt-2 text-sm leading-6 text-text-secondary">{firstResolveStep.body}</p>
          <div className="mt-4 rounded-xl border border-orange-500/15 bg-orange-50/60 p-3">
            <code className="block overflow-x-auto whitespace-nowrap font-mono text-xs text-orange-700 sm:text-sm">
              {firstResolveStep.command}
            </code>
          </div>
          <button
            onClick={() => handleCopy(firstResolveStep.id, firstResolveStep.command)}
            className="mt-4 inline-flex items-center gap-2 rounded-xl border border-orange-500/25 bg-white px-3.5 py-2.5 text-xs font-medium uppercase tracking-wider text-orange-700 transition-colors hover:border-orange-500/45 hover:bg-orange-50"
          >
            {copied === firstResolveStep.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied === firstResolveStep.id ? "Copied" : "Copy command"}
          </button>
          <p className="mt-3 text-xs leading-5 text-text-muted">
            Then swap Google for the site you actually care about.
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-surface px-5 py-4 text-sm leading-7 text-text-secondary">
        High-signal outcome:
        <span className="ml-2">copy install, run one resolve, then use Unbrowse on your own target site before touching optional skill or dashboard setup.</span>
      </div>
    </div>
  );
}
