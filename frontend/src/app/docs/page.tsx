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

      <h2>2. Authenticate (web3-native)</h2>
      <p>
        The credential root is a wallet signature. A local self-custody ed25519
        wallet is auto-created at <code>~/.unbrowse/wallet.json</code> on first
        run — no signup required. The SDK signs each request as a fresh capability;
        the backend verifies the signature and authenticates you as
        <code>wallet:&lt;pubkey&gt;</code> — a full principal, never key-gated.
      </p>
      <p>
        <strong>Optional web2 wrapper (deprecated).</strong> For account-bound
        flows (payouts accrual, dashboard sync, ToS surface tied to an email),
        sign in at <a href="/login">unbrowse.ai/login</a> (magic link), mint a
        key, and store it in <code>UNBROWSE_API_KEY</code>. A wallet-only caller
        is already a full principal; the key is layered only for account-bound
        continuity and will be retired.
      </p>

      <h2>3. Resolve an intent</h2>
      <pre><code>{`import { Unbrowse, mergedAuthHeaders } from "@unbrowse/client";

// Web3-native: the wallet signature is the sole required credential.
const unbrowse = new Unbrowse({ walletSigner: mergedAuthHeaders });

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
