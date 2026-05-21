import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "API reference — Unbrowse Docs",
  description: "Every method on the @unbrowse/client SDK with types and examples.",
};

export default function DocsApiPage() {
  return (
    <>
      <h1>API reference</h1>
      <p>
        Constructor: <code>new Unbrowse(options)</code>. Every method returns a typed promise. Network errors, 429, and 5xx are auto-retried with exponential backoff + jitter (default 2 retries; override per call).
      </p>

      <h2>Constructor options</h2>
      <pre><code>{`new Unbrowse({
  apiKey?:    string;          // env UNBROWSE_API_KEY
  baseURL?:   string;          // env UNBROWSE_BASE_URL, default https://beta-api.unbrowse.ai
  timeout?:   number;          // ms, default 60_000
  maxRetries?: number;         // default 2
  fetch?:     typeof fetch;    // inject for tracing or mocking
  defaultHeaders?: Record<string, string>;
  logLevel?:  "off" | "error" | "warn" | "info" | "debug"; // env UNBROWSE_LOG
});`}</code></pre>

      <h2>Top-level methods</h2>

      <h3><code>resolve(input)</code></h3>
      <p>Find captured endpoints that match an intent. Returns a ranked shortlist.</p>
      <pre><code>{`await unbrowse.resolve({
  intent: "find tomorrow's calendar events",
  contextUrl?: "https://calendar.google.com",
  domain?: "calendar.google.com",
  limit?: 5,
});
// → { status, available_operations: AvailableEndpoint[], next_step?, _request_id }`}</code></pre>

      <h3><code>execute(input)</code></h3>
      <p>Execute one of the shortlisted endpoints. Auto-sets an <code>Idempotency-Key</code> so a network-retry never double-charges.</p>
      <pre><code>{`await unbrowse.execute({
  endpoint_id?:    string;
  url?:            string;
  method?:         string;
  params?:         Record<string, unknown>;
  body?:           unknown;
  raw?:            boolean;       // bypass extract
  extract?:        string;        // JSONPath into the response
  limit?:          number;
  idempotency_key?: string;       // override the auto-key
  transport?:      "worker-proxy" | "direct";
  proxy?:          "direct" | "residential";
});
// → { success, status_code, data, raw, trace, _request_id }`}</code></pre>

      <h3><code>search(input)</code></h3>
      <p>Public discovery — search the marketplace by intent and optional domain.</p>
      <pre><code>{`await unbrowse.search({
  intent: "github trending repos",
  domain?: "github.com",
  limit?: 10,
});
// → { hits: SearchHit[], _request_id }`}</code></pre>

      <h3><code>health()</code></h3>
      <pre><code>{`await unbrowse.health();
// → { status: "ok" | "degraded", version?, uptime_s? }`}</code></pre>


      <h2>Skill management</h2>
      <pre><code>{`// Publish a captured skill to the marketplace.
// Wraps POST /v1/skills.
await unbrowse.publish({
  name: "github.com search",
  intent_signature: "search github code",
  domain: "github.com",
  description: "search github via the public API",
  endpoints: [/* EndpointDescriptor[] */],
  markup_bps: 2500,  // optional, [500, 8000] = 5-80% platform cut on x402 settle
});
// → { skill_id, version, publish_status }

// Annotate an endpoint with a tip, constraint, or gotcha.
// Wraps POST /v1/skills/:id/endpoints/:eid/annotate.
await unbrowse.annotate({
  skillId: "abc123",
  endpointId: "ep1",
  text: "rate limit is 60/hr per token",
  constraint: "per_page:format:1-100",  // optional structured constraint
});
// → { ok: true, annotation_id }`}</code></pre>

      <h2>Payment provider</h2>
      <pre><code>{`// Sync the agent's chosen x402 settlement rail.
// Wraps POST /v1/account/payment-provider. Allowed values:
//   "pay_sh"           pay-cli + TouchID + USDC (x402 MPP)
//   "lobster_cash"     @crossmint/lobster-cli + virtual card + Solana
//   "external_solana"  bring-your-own signer (via \`unbrowse wallet\`)
//   "privy_embedded"   Privy auto-created wallet (web sign-in)
//   "privy_embedded_solana"  bound automatically via /v1/auth/privy/start
//   "skip"             free tier (sponsor middleware covers $1/day/agent)
await unbrowse.paymentProvider("privy_embedded");
// → { agent_id, wallet_provider, wallet_address }`}</code></pre>

      <h2>Per-skill markup_bps (Flex x402)</h2>
      <p className="text-sm text-muted-foreground">
        SkillManifest accepts an optional <code>markup_bps</code> field that overrides the global PLATFORM_BPS constant when computing x402 splits. Clamped to <code>[500, 8000]</code> (5-80%) at compute time. The owner-share (1500 bps when DNS-claimed) and the indexer pool auto-rebalance from the remainder. Set per skill at publish time to charge different rates per route.
      </p>

      <h2>Account resource</h2>
      <pre><code>{`await unbrowse.account.me();             // current user
await unbrowse.account.credits();        // balance, used, granted (USD)
await unbrowse.account.sponsorStatus();  // daily sponsor remaining`}</code></pre>

      <h2>Keys resource</h2>
      <pre><code>{`await unbrowse.keys.list();              // { keys: ApiKey[] }
await unbrowse.keys.create({ name: "prod" });
// → { keyId, key (plaintext, ONCE), name, created_at, message }
await unbrowse.keys.revoke(keyId);
await unbrowse.keys.rotate(keyId);       // revokes old, returns new key`}</code></pre>
      <p className="text-sm text-muted-foreground">
        Key-management endpoints (<code>/v1/account/keys</code>) authenticate via the magic-link cookie session, not bearer API key. Sign in at the dashboard once to mint the first key; the bearer key covers every other call.
      </p>

      <h2>Proxy resource</h2>
      <p>See <a href="/docs/proxy">Worker proxy + IProyal</a> for the full story.</p>
      <pre><code>{`await unbrowse.proxy.fetch({
  url: "https://www.reddit.com/r/singularity/top.json",
  method: "GET",
  proxy: "residential",            // optional, tunnels via IProyal
});
// → { status, headers, body, proxy_used, duration_ms }

await unbrowse.proxy.capabilities();
// → { modes, residential_configured, max_body_bytes, default_timeout_ms }`}</code></pre>

      <h2>Per-request overrides</h2>
      <pre><code>{`await unbrowse.resolve({ intent }, {
  timeout: 10_000,
  maxRetries: 0,
  signal: ac.signal,
  headers: { "x-custom": "..." },
  idempotencyKey: "user-supplied",
});`}</code></pre>
    </>
  );
}
