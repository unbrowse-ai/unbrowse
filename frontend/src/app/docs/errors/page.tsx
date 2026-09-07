import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Errors — Unbrowse Docs",
  description: "Typed error hierarchy. Catch with instanceof, branch on status, paste the request_id for support.",
};

export default function DocsErrorsPage() {
  return (
    <>
      <h1>Errors</h1>
      <p>
        Every SDK method throws on non-2xx. Errors are typed; <code>instanceof</code> works in browser, Node, and edge runtimes. Every error carries the <code>request_id</code> from the <code>x-request-id</code> response header so support can find the corresponding server trace instantly.
      </p>

      <h2>Hierarchy</h2>
      <pre><code>{`UnbrowseError
├─ UnbrowseAPIError                 // any 4xx/5xx with body
│  ├─ UnbrowseBadRequestError       // 400
│  ├─ UnbrowseAuthenticationError   // 401
│  ├─ UnbrowsePaymentRequiredError  // 402 (x402 / sponsor exhausted)
│  ├─ UnbrowsePermissionError       // 403
│  ├─ UnbrowseNotFoundError         // 404
│  ├─ UnbrowseRateLimitError        // 429 (carries retry_after_ms)
│  └─ UnbrowseServerError           // 5xx
└─ UnbrowseConnectionError          // network
   └─ UnbrowseTimeoutError`}</code></pre>

      <h2>Common shape</h2>
      <pre><code>{`interface UnbrowseAPIError extends UnbrowseError {
  status: number;
  body: unknown;            // server-returned JSON or text
  request_id: string | undefined;
  url: string;
  method: string;
}`}</code></pre>

      <h2>Branch by class</h2>
      <pre><code>{`import {
  Unbrowse,
  UnbrowseRateLimitError,
  UnbrowsePaymentRequiredError,
  UnbrowseAuthenticationError,
} from "@unbrowse/client";

try {
  await unbrowse.resolve({ intent });
} catch (e) {
  if (e instanceof UnbrowseRateLimitError) {
    console.log("rate limited, retry after", e.retry_after_ms, "ms");
  } else if (e instanceof UnbrowsePaymentRequiredError) {
    // sponsor cap exhausted; e.body is the x402 requirements object
    console.log("top up wallet", e.body);
  } else if (e instanceof UnbrowseAuthenticationError) {
    console.log("rotate your key at /docs#keys");
  } else {
    throw e;
  }
}`}</code></pre>

      <h2>Auto-retry</h2>
      <p>
        The SDK retries 429, 5xx, and network errors automatically with exponential backoff + jitter. The default budget is 2 retries; override with <code>maxRetries</code> on the constructor or per request. <code>Retry-After</code> response headers are honoured for 429.
      </p>

      <h2>Including request_id in support requests</h2>
      <p>
        Every successful response also carries <code>_request_id</code> as a field, so you can capture it on success-path debug too. Paste it into any support thread and the worker logs surface in one query.
      </p>
    </>
  );
}
