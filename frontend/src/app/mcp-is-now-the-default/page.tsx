import type { Metadata } from "next";
import Link from "next/link";

const POST_TITLE = "MCP is the default, not the CLI";
const POST_SUBTITLE =
  "v6.11.0 makes MCP the recommended way to drive Unbrowse from any agent";
const CANONICAL_PATH = "/mcp-is-now-the-default";
const PUBLISHED_AT = "2026-05-12";
const MODIFIED_AT = "2026-05-12";

const summary = `v6.11.0 rebuilds the Unbrowse MCP server around an agent-first contract: a disposable daemon the client respawns transparently, browse sessions that survive daemon restarts, structured next-actions on every tool response, and recipe prompts that hand the calling client a known-good pipeline. If you are driving Unbrowse from Claude, Codex, or any MCP-capable agent, switch off the CLI.`;

const highlights = [
  "Disposable mcp-serve: the local daemon self-exits after idle, MCP transparently respawns and retries",
  "Browse sessions persist to ~/.unbrowse/sessions.jsonl and rehydrate on the next daemon boot",
  "Structured next_action on every tool response, not just prose hints",
  "Workflow recipe prompts (cached resolve, cold browse + publish, URL-contents fetch) exposed via listChanged",
  "Tightened SKILL.md so the agent loads only what it needs to act",
];

const sections = [
  {
    title: "Why MCP beats the CLI for agents",
    body: "The CLI was built for humans typing into terminals; MCP is built for agents reasoning over a typed surface. The two-call contract (resolve, then execute) is enforced as the default surface in MCP, so the agent's LLM picks from a ranked shortlist with full evidence per endpoint instead of you scripting the flow. Every tool response carries a structured next_action field with the suggested follow-up tool and arguments, so agent code can route on a value instead of parsing English. There is no shell to escape, no exit codes to interpret, no flag matrix to memorise. MCP gives the agent the same surface as the CLI with richer hints and zero shell scripting.",
  },
  {
    title: "Disposable daemon, invisible to the agent",
    body: "Earlier versions of unbrowse serve hung around forever. Every Ctrl-C of an MCP client left a detached daemon behind; after five sessions you had twenty zombie processes pinning ports and CPU. v6.11.0 makes the daemon disposable. unbrowse serve self-exits after UNBROWSE_SERVE_IDLE_MS of zero activity (default sixty seconds, set zero to disable). On the client side, MCP catches connect failures (ECONNREFUSED, ConnectionRefused, fetch failed, the full set), drops its cached server-ready promise, respawns the daemon, and retries the request once. From the agent's point of view, the lifecycle is invisible. From your process list's point of view, there is one daemon at most.",
  },
  {
    title: "Sessions survive the reaper",
    body: "Disposability only works if state survives. Browse sessions are appended to ~/.unbrowse/sessions.jsonl on every mutation. When unbrowse serve cold-starts, the in-memory session map is rehydrated from this file. Open a tab, get reaped mid-flow, the next browse_snap against the same session id still works. The agent does not need to know the daemon restarted, and you do not need to redrive the browser to recover.",
  },
  {
    title: "Recipe prompts and structured hints",
    body: "MCP clients that surface prompts (Claude Desktop, Claude Code, several IDE extensions) can now list and run workflow:* prompt templates that codify the canonical Unbrowse pipelines. The cached-resolve recipe shows the agent how to two-call against the marketplace; the cold-browse-publish recipe walks the live capture path; the URL-contents recipe handles raw fetch intents. listChanged is on, so prompt updates propagate without a client restart. Combined with structured next_action on every response, the calling agent has both the field-level routing it needs for its own logic and the recipe-level scaffolding for the user's intent.",
  },
];

const setupSnippet = `# install + register the MCP server with one command
npx unbrowse setup --mcp

# or wire it manually: point your MCP client at
unbrowse mcp   # stdio transport`;

export const metadata: Metadata = {
  title: `${POST_TITLE} | Unbrowse`,
  description: summary,
  alternates: {
    canonical: `https://www.unbrowse.ai${CANONICAL_PATH}`,
  },
  authors: [{ name: "Unbrowse AI", url: "https://www.unbrowse.ai" }],
  openGraph: {
    title: POST_TITLE,
    description: summary,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    siteName: "Unbrowse",
    type: "article",
    publishedTime: PUBLISHED_AT,
    modifiedTime: MODIFIED_AT,
    images: [
      {
        url: "https://www.unbrowse.ai/logo.png",
        alt: "Unbrowse logo",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@unbrowse",
    title: POST_TITLE,
    description: summary,
    images: ["https://www.unbrowse.ai/logo.png"],
  },
  keywords: [
    "mcp",
    "unbrowse",
    "ai agents",
    "browser automation",
    "claude code",
    "model context protocol",
    "agentic web",
    "internal apis",
    "disposable daemon",
    "shadow apis",
  ],
};

export default function McpIsDefaultPostPage() {
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: POST_TITLE,
    alternativeHeadline: POST_SUBTITLE,
    description: summary,
    author: {
      "@type": "Organization",
      name: "Unbrowse AI",
      url: "https://www.unbrowse.ai",
    },
    publisher: {
      "@type": "Organization",
      name: "Unbrowse AI",
      url: "https://www.unbrowse.ai",
      logo: {
        "@type": "ImageObject",
        url: "https://www.unbrowse.ai/logo.png",
      },
    },
    datePublished: PUBLISHED_AT,
    dateModified: MODIFIED_AT,
    url: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    mainEntityOfPage: `https://www.unbrowse.ai${CANONICAL_PATH}`,
    keywords: metadata.keywords,
    articleSection: "Releases",
    inLanguage: "en-US",
    isAccessibleForFree: true,
  };

  return (
    <div className="bg-surface-ink min-h-screen text-text-secondary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }}
      />

      <article className="max-w-4xl mx-auto px-6 py-16 sm:py-24">
        <div className="mb-6">
          <Link
            href="/"
            className="text-sm font-mono text-text-secondary hover:text-orange-500 transition-colors"
          >
            [← back to unbrowse]
          </Link>
        </div>

        <header className="mb-12 border-b border-border pb-10">
          <p className="text-xs font-mono font-medium uppercase tracking-[0.3em] text-text-secondary mb-4">
            ## RELEASE · v6.11.0
          </p>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-balance leading-tight text-text-secondary">
            {POST_TITLE}
          </h1>
          <p className="mt-4 text-xl sm:text-2xl font-mono font-medium text-balance text-text-secondary">
            {POST_SUBTITLE}
          </p>

          <p className="mt-6 text-sm font-mono text-text-secondary">
            published {PUBLISHED_AT} · unbrowse v6.11.0
          </p>

          <div className="mt-8 flex flex-col sm:flex-row gap-3">
            <a
              href="https://github.com/unbrowse-ai/unbrowse/releases/tag/v6.11.0"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-sm bg-[rgba(255,122,32,0.95)] px-5 py-3 font-mono font-medium text-[#070503] hover:bg-[rgba(255,140,48,1)] transition-colors"
            >
              [ release notes ]
            </a>
            <a
              href="https://www.npmjs.com/package/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-sm border border-border bg-surface-ink px-5 py-3 font-mono font-medium text-text-secondary hover:border-orange-500 hover:bg-surface-ink transition-colors"
            >
              [ npm ]
            </a>
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center rounded-sm border border-border bg-surface-ink px-5 py-3 font-mono font-medium text-text-secondary hover:border-border hover:bg-surface-ink transition-colors"
            >
              [ view repo ]
            </a>
          </div>
        </header>

        <section className="mb-12">
          <p className="text-xs font-mono font-medium uppercase tracking-[0.3em] text-text-secondary mb-4">
            ## SUMMARY
          </p>
          <p className="text-base sm:text-lg leading-8 font-mono text-text-secondary">
            {summary}
          </p>
        </section>

        <section className="mb-12">
          <p className="text-xs font-mono font-medium uppercase tracking-[0.3em] text-text-secondary mb-4">
            ## WHAT&apos;S NEW
          </p>
          <ul className="space-y-3 text-base sm:text-lg leading-8 font-mono text-text-secondary">
            {highlights.map((item) => (
              <li key={item} className="flex gap-3">
                <span className="text-text-secondary shrink-0">›</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-10 mb-12">
          {sections.map((section) => (
            <div key={section.title}>
              <p className="text-xs font-mono font-medium uppercase tracking-[0.3em] text-text-secondary mb-3">
                ## {section.title.toUpperCase()}
              </p>
              <p className="text-base sm:text-lg leading-8 font-mono text-text-secondary">
                {section.body}
              </p>
            </div>
          ))}
        </section>

        <section className="mb-12 rounded-sm border border-border bg-surface-ink p-6 sm:p-8">
          <p className="text-xs font-mono font-medium uppercase tracking-[0.3em] text-text-secondary mb-3">
            ## SETUP
          </p>
          <pre className="overflow-x-auto text-sm sm:text-base font-mono leading-7 text-text-secondary whitespace-pre-wrap">
            {setupSnippet}
          </pre>
        </section>

        <section className="mb-12">
          <p className="text-xs font-mono font-medium uppercase tracking-[0.3em] text-text-secondary mb-4">
            ## SWITCH OVER
          </p>
          <p className="text-base sm:text-lg leading-8 font-mono text-text-secondary mb-4">
            If your agent is shelling out to <code className="text-text-secondary">unbrowse resolve</code> and <code className="text-text-secondary">unbrowse execute</code>, point your MCP client at <code className="text-text-secondary">unbrowse mcp</code> and delete the shell glue. The CLI is not going away, but every CLI flow has a richer MCP equivalent now, and that is where future work lands first.
          </p>
          <a
            href="https://github.com/unbrowse-ai/unbrowse#mcp"
            target="_blank"
            rel="noopener"
            className="font-mono font-medium text-text-secondary hover:text-orange-500"
          >
            [ MCP setup guide → ]
          </a>
        </section>
      </article>
    </div>
  );
}
