"use client";

import Link from "next/link";
import { InstallInstructions } from "@/components/install-instructions";
import { useAuth } from "@/lib/auth-context";

export default function InstallPage() {
  const { isAuthenticated, email, agentName, hydrated } = useAuth();

  return (
    <div className="mx-auto max-w-3xl px-6 pb-20 pt-32">
      <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-3">
        ##  Install
      </p>
      <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance text-text-primary">
        Install the unbrowse MCP
      </h1>
      <p className="mt-3 text-sm text-text-secondary leading-relaxed">
        One command per host. {isAuthenticated
          ? "Your API key is baked in below — just copy + paste."
          : "Sign in first to bake your API key into the command (or install un-keyed and run `unbrowse setup` later)."}
      </p>

      {hydrated && !isAuthenticated && (
        <div className="mt-6 border border-[rgba(255,122,32,0.22)] bg-[rgba(255,122,32,0.04)] p-5 rounded-sm">
          <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.7)]">
            ##  No key yet
          </p>
          <p className="mt-2 text-sm text-text-secondary leading-relaxed">
            Sign in with email and the magic link mints an API key, stores it in this browser session, and bakes it into the install command below in one click.
          </p>
          <Link
            href="/login"
            className="mt-4 inline-flex items-center gap-2 px-6 py-2.5 bg-orange-500 text-white font-mono font-medium text-sm hover:bg-orange-600 active:translate-y-px transition-all cursor-pointer"
          >
            <span>[ Sign in with email ]</span>
          </Link>
        </div>
      )}

      {hydrated && isAuthenticated && (
        <div className="mt-6 border border-[rgba(255,122,32,0.18)] bg-[#070503]/90 p-4 rounded-sm">
          <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)]">
            ##  Signed in as
          </p>
          <p className="mt-1 text-sm text-text-secondary">{email ?? agentName}</p>
        </div>
      )}

      <div className="mt-8">
        <InstallInstructions />
      </div>

      <div className="mt-10 border-t border-[rgba(255,122,32,0.12)] pt-6">
        <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)]">
          ##  After install
        </p>
        <ul className="mt-3 space-y-2 text-sm text-text-secondary leading-relaxed">
          <li>·  Restart your MCP host (Claude Code, Cursor, Codex) so it picks up the new server.</li>
          <li>·  Verify: <span className="font-mono text-[rgba(255,176,96,0.95)]">claude mcp list</span> should show <span className="font-mono text-[rgba(255,176,96,0.95)]">unbrowse</span>.</li>
          <li>·  The MCP server exposes <span className="font-mono text-[rgba(255,176,96,0.95)]">unbrowse://setup/status</span> and <span className="font-mono text-[rgba(255,176,96,0.95)]">unbrowse://docs/*</span> Resources so the agent self-documents.</li>
          <li>·  First call your agent should make: <span className="font-mono text-[rgba(255,176,96,0.95)]">unbrowse_resolve</span> with <span className="font-mono text-[rgba(255,176,96,0.95)]">{`{ intent, url }`}</span>, then pick an <span className="font-mono text-[rgba(255,176,96,0.95)]">endpoint_id</span> from the shortlist and call <span className="font-mono text-[rgba(255,176,96,0.95)]">unbrowse_execute</span>. Two tool calls, never one. See <Link href="/docs" className="font-mono text-[rgba(255,176,96,0.95)] underline hover:text-orange-400">/docs</Link> for the full quickstart.</li>
          <li>·  See <Link href="/dashboard" className="font-mono text-[rgba(255,176,96,0.95)] underline hover:text-orange-400">/dashboard</Link> for your earnings ledger, <Link href="/claim" className="font-mono text-[rgba(255,176,96,0.95)] underline hover:text-orange-400">/claim</Link> to bind a wallet to a domain you own, and <Link href="/how-unbrowse-pays" className="font-mono text-[rgba(255,176,96,0.95)] underline hover:text-orange-400">/how-unbrowse-pays</Link> for the payment ladder.</li>
        </ul>
      </div>
    </div>
  );
}
