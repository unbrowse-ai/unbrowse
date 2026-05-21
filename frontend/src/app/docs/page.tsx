import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Quickstart — Unbrowse Docs",
  description: "Three lines to your first call against the Unbrowse API.",
};

export default function DocsQuickstartPage() {
  return (
    <>
      <h1>Quickstart</h1>
      <p>
        <strong>@unbrowse/client</strong> is a thin HTTP-first SDK. It calls <code>beta-api.unbrowse.ai</code> directly. No binary spawn, no local daemon, runs in the browser, on Node 18+, and on any edge runtime that exposes a <code>fetch</code>. Zero runtime dependencies.
      </p>

      <h2>1. Install</h2>
      <pre><code>npm i @unbrowse/client</code></pre>

      <h2>2. Get an API key</h2>
      <p>
        Sign in at <a href="/login">unbrowse.ai/login</a> (magic link). The dashboard mints your first key. Copy it once and store it in <code>UNBROWSE_API_KEY</code>.
      </p>

      <h2>3. Resolve an intent</h2>
      <pre><code>{`import { Unbrowse } from "@unbrowse/client";

const unbrowse = new Unbrowse({ apiKey: process.env.UNBROWSE_API_KEY });

const result = await unbrowse.resolve({
  intent: "search hackernews for AI agent papers",
});

// result.available_operations: AvailableEndpoint[]
// result.status: "ok" | "empty" | "browse_session_open" | "auth_required" | ...
// result._request_id: paste into support if anything looks off`}</code></pre>

      <h2>4. Execute the picked endpoint</h2>
      <pre><code>{`const data = await unbrowse.execute({
  endpoint_id: result.available_operations![0].endpoint_id,
  params: { q: "agents" },
});`}</code></pre>

      <h2>Two tool calls, never one</h2>
      <p>
        Unbrowse always returns a ranked shortlist from <code>resolve</code>. Your LLM picks one and calls <code>execute</code>. The shortlist is rich enough that an LLM can pick without re-prompting; we never auto-execute a guess.
      </p>

      <h2>Next</h2>
      <ul>
        <li><a href="/docs/api">Full API reference</a> — every method, every type.</li>
        <li><a href="/docs/proxy">Worker proxy + IProyal</a> — route outbound fetches through Cloudflare or a residential IP.</li>
        <li><a href="/docs/errors">Errors</a> — typed hierarchy you can <code>instanceof</code>.</li>
      </ul>
    </>
  );
}
