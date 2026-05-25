"use client";

import Link from "next/link";
import { InstallInstructions } from "@/components/install-instructions";
import { useAuth } from "@/lib/auth-context";
import { Chapter, FeatureGrid, FeatureCard, CtaLink, Hairline } from "@/components/editions";

export default function InstallPage() {
  const { isAuthenticated, email, agentName, hydrated } = useAuth();

  return (
    <>
      <Chapter
        id="install-hero"
        name="Install"
        title={<>Install the Unbrowse MCP.</>}
        lede={
          isAuthenticated
            ? "Your API key is baked into the command below. Pick your MCP host and copy."
            : "One command per host. Sign in first to bake your API key into the command, or install un-keyed and run unbrowse setup later."
        }
      >
        {hydrated && !isAuthenticated && (
          <div className="mb-10 max-w-2xl border border-border-strong bg-surface-raised p-6 rounded-sm">
            <p className="stamp-label">No key yet</p>
            <p className="mt-3 text-sm text-text-secondary leading-relaxed">
              Sign in with email. The magic link mints an API key, stores it in this browser
              session, and bakes it into the install command below in one click.
            </p>
            <Link href="/login" className="cta-primary cta-accent mt-4 text-sm">
              Sign in with email
            </Link>
          </div>
        )}

        {hydrated && isAuthenticated && (
          <div className="mb-10 max-w-2xl border border-border bg-surface-raised p-5 rounded-sm">
            <p className="stamp-label">Signed in as</p>
            <p className="mt-1 text-sm text-text-secondary">{email ?? agentName}</p>
          </div>
        )}

        <div className="max-w-3xl">
          <InstallInstructions />
        </div>
      </Chapter>

      <Chapter
        id="after"
        name="After install"
        title={<>What to do once it&apos;s wired in.</>}
        lede="The MCP server self-documents through Resources. Your agent learns the surface without a tutorial."
      >
        <FeatureGrid cols={2}>
          <FeatureCard
            title="Restart the host"
            description="Restart your MCP host (Claude Code, Claude Desktop, Cursor, Codex) so it picks up the new server."
          />
          <FeatureCard
            title="Verify"
            description="Run claude mcp list (or your host's equivalent). You should see unbrowse listed."
          />
          <FeatureCard
            title="First call"
            description="unbrowse_resolve with {intent, url}. Pick an endpoint_id from the shortlist and call unbrowse_execute. Two tool calls, never one."
            href="/docs"
            cta="Read the full quickstart"
          />
          <FeatureCard
            title="Self-documenting Resources"
            description="The server exposes unbrowse://setup/status and unbrowse://docs/* so the agent reads its own manual."
          />
        </FeatureGrid>

        <Hairline />

        <div className="mt-10 flex flex-wrap gap-6">
          <CtaLink href="/dashboard">Earnings ledger</CtaLink>
          <CtaLink href="/claim">Claim a domain</CtaLink>
          <CtaLink href="/how-unbrowse-pays">How Unbrowse pays</CtaLink>
          <CtaLink href="/playground">Try the playground</CtaLink>
        </div>
      </Chapter>
    </>
  );
}
