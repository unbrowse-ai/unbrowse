import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Worker proxy + IProyal — Unbrowse Docs",
  description: "Route outbound HTTP through the Unbrowse worker, optionally via a residential IP.",
};

export default function DocsProxyPage() {
  return (
    <>
      <h1>Worker proxy + IProyal</h1>
      <p>
        The SDK runs in places where direct outbound fetches don't work: browsers (CORS), edge runtimes (no outbound socket), or against APIs that block datacenter IPs. <code>POST /v1/proxy</code> on the worker fetches the URL for you and returns the response.
      </p>

      <h2>Basic worker fetch</h2>
      <pre><code>{`const r = await unbrowse.proxy.fetch({
  url: "https://www.reddit.com/r/singularity/top.json",
  method: "GET",
});
// r.status, r.headers, r.body, r.proxy_used: "direct", r.duration_ms`}</code></pre>
      <p>
        Defaults: <code>proxy: "direct"</code> (worker fetches from its own Cloudflare egress), 30 s timeout, 8 MB body cap, follows redirects, strips internal CF headers from the upstream call.
      </p>

      <h2>Residential routing</h2>
      <p>
        For geo-fenced or anti-bot targets, ask the worker to tunnel the outbound fetch through a residential IP via IProyal:
      </p>
      <pre><code>{`const r = await unbrowse.proxy.fetch({
  url: "https://geo-fenced.example.com/api/data",
  proxy: "residential",
});
// r.proxy_used: "residential"`}</code></pre>
      <p>
        The worker connects to <code>geo.iproyal.com:12321</code> using <code>cloudflare:sockets</code>, sends an HTTP <code>CONNECT</code> with proxy auth, upgrades to TLS for HTTPS targets, and forwards your request. Returns the raw response (status, headers, body) just like direct mode.
      </p>

      <h2>Capability check</h2>
      <p>
        Residential mode requires <code>IPROYAL_USER</code> + <code>IPROYAL_PASS</code> as wrangler secrets on the worker. Before requesting it, check what's configured:
      </p>
      <pre><code>{`const caps = await unbrowse.proxy.capabilities();
// {
//   modes: ["direct", "residential"],
//   residential_configured: true,
//   max_body_bytes: 8388608,
//   default_timeout_ms: 30000,
// }`}</code></pre>
      <p>
        If <code>residential_configured: false</code>, a <code>proxy: "residential"</code> call will return HTTP 502 with a clear error naming the missing env. Fall back to <code>direct</code> in that case.
      </p>

      <h2>Choosing direct vs worker-proxy on execute()</h2>
      <pre><code>{`// Default — worker fetches the captured URL on your behalf.
await unbrowse.execute({ endpoint_id, params });

// Same call, with residential egress for the upstream fetch.
await unbrowse.execute({ endpoint_id, params, proxy: "residential" });

// Lower latency, exposes your IP, bypasses sponsor metering.
await unbrowse.execute({ endpoint_id, params, transport: "direct" });`}</code></pre>

      <h2>Blocked targets</h2>
      <p>
        The worker rejects requests to private RFC1918 ranges, loopback, and link-local addresses with HTTP 400 (<code>error: "blocked_private_host"</code>). HTTP and HTTPS are the only allowed schemes.
      </p>

      <h2>Response shape</h2>
      <pre><code>{`{
  status: number;                       // upstream HTTP status
  headers: Record<string, string>;      // upstream headers (CF/internal stripped)
  body: string;                         // upstream body (utf-8 text up to 8MB)
  proxy_used: "direct" | "residential";
  duration_ms: number;
  egress_ip?: string;                   // when residential
  _request_id?: string;
}`}</code></pre>
    </>
  );
}
